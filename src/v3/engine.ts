import type { RoomTextMessage } from "../llm/types";
import type { SharedMessage, SharedState, Roomie, RoomState, SpeakerOutput } from "../types";
import {
  buildDirectorMessages,
  buildDirectorRepairMessages,
  buildSpeakerMessages,
  buildSpeakerRepairMessages,
  buildSummarizerMessagesV3,
} from "./prompts";
import {
  buildFallbackSpeakEvent,
  createEventIdFactory,
  eventToHistoryLine,
  eventsForAgentPrivateMemory,
  eventsForSummarizer,
  parseNdjsonTheatricalEvents,
  toNdjson,
} from "./events";
import {
  THEATRICAL_CONTRACT_VERSION,
  THEATRICAL_EVENT_SCHEMA_VERSION,
  type DirectorBeat,
  type DirectorPlan,
  type DirectorPlanSchema,
  type RoomEngineDepsV3,
  type RoomTurnInputV3,
  type RoomTurnResultV3,
  type TheatricalEvent,
} from "./types";

const DEFAULT_COMPACT_EVERY_CHARS = 12000;
const DEFAULT_COMPACT_KEEP_MESSAGES = 5;
const DIRECTOR_HISTORY_LIMIT = 10;
const MAX_AGENT_MEMORY = 12;

const compact = (value: string) =>
  value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const normalizeName = (value: string | null | undefined, fallback: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
};

const estimateSharedChars = (shared: SharedState): number => {
  const historyChars = shared.last_messages.reduce((total, message) => total + message.text.length, 0);
  return shared.goal.length + shared.summary_window.length + historyChars;
};

const trimMessages = (messages: SharedState["last_messages"], keepCount: number) => {
  if (keepCount <= 0) return [];
  if (messages.length <= keepCount) return messages;
  return messages.slice(-keepCount);
};

const parseMaybeJsonObject = (raw: string): Record<string, unknown> | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore direct parse failure.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore fallback parse failure.
  }
  return null;
};

const toPositiveInt = (value: unknown, fallback: number, min = 1, max = 20) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const toBool = (value: unknown, fallback: boolean) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
};

const toShortText = (value: unknown, fallback: string, max = 220) => {
  if (typeof value !== "string") return fallback;
  const next = compact(value);
  if (!next) return fallback;
  return next.slice(0, max);
};

const buildFallbackPlan = (params: {
  activeRoomies: Roomie[];
  turnIndex: number;
  presetId: string;
  reason: string;
  maxEventsPerBeat: number;
  budget: RoomTurnInputV3["budget"];
}): DirectorPlan => {
  const beats: DirectorBeat[] = params.activeRoomies.map((roomie, index) => ({
    beatId: `b${params.turnIndex + 1}-${index + 1}`,
    agentId: roomie.id,
    intent: "respond-helpfully",
    allowAction: false,
    allowThought: false,
    toneHint: "balanced",
    maxEvents: params.maxEventsPerBeat,
  }));

  return {
    contractVersion: THEATRICAL_CONTRACT_VERSION,
    schemaVersion: THEATRICAL_EVENT_SCHEMA_VERSION,
    turnIndex: params.turnIndex,
    presetId: params.presetId,
    budgets: params.budget,
    beats,
    trace: {
      source: "fallback",
      attempts: 0,
      reason: params.reason,
    },
  };
};

const parseDirectorPlanSchema = (params: {
  raw: string;
  activeRoomies: Roomie[];
  turnIndex: number;
  presetId: string;
  budget: RoomTurnInputV3["budget"];
  maxEventsPerBeat: number;
}): { ok: true; plan: DirectorPlan } | { ok: false; reason: string } => {
  const parsed = parseMaybeJsonObject(params.raw);
  if (!parsed) return { ok: false, reason: "director-invalid-json" };
  const beatsRaw = parsed.beats;
  if (!Array.isArray(beatsRaw) || beatsRaw.length === 0) {
    return { ok: false, reason: "director-missing-beats" };
  }

  const activeById = new Map(params.activeRoomies.map((roomie) => [roomie.id, roomie]));
  const maxBeats = params.activeRoomies.length;

  const beats: DirectorBeat[] = [];
  for (let index = 0; index < beatsRaw.length; index += 1) {
    const entry = beatsRaw[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const agentId = typeof record.agent_id === "string" ? record.agent_id.trim() : "";
    if (!agentId || !activeById.has(agentId)) continue;
    if (beats.some((beat) => beat.agentId === agentId)) continue;

    beats.push({
      beatId: `b${params.turnIndex + 1}-${beats.length + 1}`,
      agentId,
      intent: toShortText(record.intent, "respond-helpfully", 140),
      allowAction: toBool(record.allow_action, false),
      allowThought: toBool(record.allow_thought, false),
      toneHint: toShortText(record.tone_hint, "balanced", 120),
      maxEvents: toPositiveInt(record.max_events, params.maxEventsPerBeat, 1, 4),
    });

    if (beats.length >= maxBeats) break;
  }

  if (!beats.length) {
    return { ok: false, reason: "director-no-valid-beats" };
  }

  return {
    ok: true,
    plan: {
      contractVersion: THEATRICAL_CONTRACT_VERSION,
      schemaVersion: THEATRICAL_EVENT_SCHEMA_VERSION,
      turnIndex: params.turnIndex,
      presetId: params.presetId,
      budgets: params.budget,
      beats,
      trace: {
        source: "model",
        attempts: 1,
      },
    },
  };
};

const extractFallbackText = (raw: string) => {
  const trimmed = compact(raw);
  if (!trimmed) return "I am here.";
  const line = trimmed
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)[0] || trimmed;
  return line.slice(0, 360);
};

const buildHistoryLines = (params: {
  sharedMessages: SharedMessage[];
  userName: string;
  roomiesById: Map<string, Roomie>;
}): string[] => {
  const lines: string[] = [];
  for (const message of params.sharedMessages) {
    if (message.role === "user") {
      lines.push(`${params.userName}: ${message.text}`);
      continue;
    }
    if (message.role === "agent") {
      const roomie = message.agent_id ? params.roomiesById.get(message.agent_id) : null;
      const fallbackName = roomie?.name || "Roomie";
      const text = compact(message.text);
      if (!text) continue;
      if (text.includes(":") || text.includes("(action):") || text.includes("(thought):")) {
        lines.push(text);
      } else {
        lines.push(`${fallbackName}: ${text}`);
      }
    }
  }
  return lines;
};

const buildSpeakerOutputs = (events: TheatricalEvent[], beats: DirectorBeat[]): SpeakerOutput[] => {
  const beatMeta = new Map(beats.map((beat, index) => [beat.beatId, { index, agentId: beat.agentId }]));
  return events
    .filter((event) => event.type === "speak")
    .map((event) => {
      const meta = beatMeta.get(event.beatId);
      return {
        agent_id: meta?.agentId || event.beatId,
        intent: "respond",
        text: event.content,
        step_index: meta?.index ?? 0,
      };
    });
};

const cloneAgentMemory = (value: SharedState["agent_memory"]) => {
  const next: SharedState["agent_memory"] = {};
  for (const [agentId, notes] of Object.entries(value || {})) {
    next[agentId] = Array.isArray(notes) ? notes.filter((note) => typeof note === "string") : [];
  }
  return next;
};

const resolveRoomieModels = async (deps: RoomEngineDepsV3, input: RoomTurnInputV3) => {
  const roomieModels: Record<string, string> = {};
  if (deps.getModelAssignment) {
    const existing = await deps.getModelAssignment({ chamberId: input.chamberId, userId: input.userId });
    if (existing?.assignment?.roomieModels) {
      for (const [roomieId, modelId] of Object.entries(existing.assignment.roomieModels)) {
        if (typeof modelId === "string" && modelId.trim()) {
          roomieModels[roomieId] = modelId.trim();
        }
      }
    }
  }

  for (const roomie of input.roomies) {
    if (!roomieModels[roomie.id]) {
      roomieModels[roomie.id] = input.defaultAgentModel;
    }
  }

  if (deps.saveModelAssignment) {
    await deps.saveModelAssignment({
      chamberId: input.chamberId,
      userId: input.userId,
      tier: input.userTier,
      assignment: { roomieModels },
      manualOverride: false,
    });
  }

  return roomieModels;
};

const countEventsByType = (events: TheatricalEvent[]) => {
  let speak = 0;
  let action = 0;
  let thought = 0;

  for (const event of events) {
    if (event.type === "speak") {
      speak += 1;
      continue;
    }
    if (event.type === "action") {
      action += 1;
      continue;
    }
    thought += 1;
  }

  return { speak, action, thought };
};

export async function runRoomTurnTheatricalV3(
  deps: RoomEngineDepsV3,
  input: RoomTurnInputV3
): Promise<RoomTurnResultV3> {
  const userMessage = compact(input.userMessage || "");
  if (!userMessage) {
    throw new Error("User message is required");
  }

  const turnStartedAt = Date.now();
  const retryAllowed = () => {
    const target = Math.max(0, input.budget.targetP95TurnLatencyMs || 0);
    if (!target) return true;
    return Date.now() - turnStartedAt < Math.floor(target * 0.8);
  };

  const { state } = await deps.loadState(input.chamberId);

  const runTurn = async () => {
    let shared = state.shared;
    if (input.chamberGoal && !shared.goal) {
      shared = { ...shared, goal: input.chamberGoal };
    }

    const maxAgents =
      typeof input.maxAgents === "number" && input.maxAgents > 0
        ? Math.floor(input.maxAgents)
        : input.roomies.length;
    const activeRoomies = input.roomies.slice(0, Math.max(1, maxAgents));
    if (!activeRoomies.length) {
      throw new Error("At least one roomie is required for v3");
    }

    const roomiesById = new Map(input.roomies.map((roomie) => [roomie.id, roomie]));
    const userName = normalizeName(input.userName, "User");
    const historyLines = buildHistoryLines({
      sharedMessages: shared.last_messages,
      userName,
      roomiesById,
    });

    const roomieModels = await resolveRoomieModels(deps, input);
    const nextEventId = createEventIdFactory(`t${shared.turn_index + 1}`);

    const directorMessages = buildDirectorMessages({
      userName,
      userMessage,
      goal: shared.goal || input.chamberGoal,
      summaryWindow: shared.summary_window,
      historyLines,
      roomies: activeRoomies,
      presetId: input.presetId,
      presetPrompt: input.presetPrompt,
      budget: input.budget,
      maxAgents: activeRoomies.length,
    });

    const directorSpan = deps.startSpan?.({
      name: "room-v3.director",
      input: { messages: directorMessages, model: input.directorModel },
      metadata: {
        chamberId: input.chamberId,
        turn: shared.turn_index,
      },
    });

    const maxDirectorAttempts = Math.max(1, Math.min(3, input.budget.maxDirectorAttempts || 1));
    let directorRaw = await deps.generateText({
      model: input.directorModel,
      messages: directorMessages,
      temperature: 0.2,
      reasoningEffort: input.directorReasoning,
      trace: {
        name: "room-v3.director",
        input: { messages: directorMessages },
        metadata: { chamberId: input.chamberId, turn: shared.turn_index },
      },
    });

    let directorAttempts = 1;
    let parsedPlan = parseDirectorPlanSchema({
      raw: directorRaw,
      activeRoomies,
      turnIndex: shared.turn_index,
      presetId: input.presetId,
      budget: input.budget,
      maxEventsPerBeat: 2,
    });

    const canRetryDirector = maxDirectorAttempts > 1 && retryAllowed();
    if (!parsedPlan.ok && canRetryDirector) {
      const repairMessages = buildDirectorRepairMessages({
        raw: directorRaw,
        reason: parsedPlan.reason,
        roomies: activeRoomies,
        maxAgents: activeRoomies.length,
      });
      directorRaw = await deps.generateText({
        model: input.directorModel,
        messages: repairMessages,
        temperature: 0,
        reasoningEffort: input.directorReasoning,
        trace: {
          name: "room-v3.director-repair",
          input: { messages: repairMessages },
          metadata: { chamberId: input.chamberId, turn: shared.turn_index },
        },
      });
      directorAttempts = 2;
      parsedPlan = parseDirectorPlanSchema({
        raw: directorRaw,
        activeRoomies,
        turnIndex: shared.turn_index,
        presetId: input.presetId,
        budget: input.budget,
        maxEventsPerBeat: 2,
      });
      if (parsedPlan.ok) {
        parsedPlan.plan.trace = { source: "repair", attempts: directorAttempts };
      }
    } else if (!parsedPlan.ok && maxDirectorAttempts > 1) {
      deps.logger?.warn?.("room-v3.director-retry-skipped", {
        chamberId: input.chamberId,
        turnIndex: shared.turn_index,
        reason: "latency-budget",
      });
    }

    let directorPlan: DirectorPlan;
    if (parsedPlan.ok) {
      directorPlan = {
        ...parsedPlan.plan,
        trace: {
          ...parsedPlan.plan.trace,
          attempts: directorAttempts,
        },
      };
    } else {
      directorPlan = buildFallbackPlan({
        activeRoomies,
        turnIndex: shared.turn_index,
        presetId: input.presetId,
        reason: parsedPlan.reason,
        maxEventsPerBeat: 1,
        budget: input.budget,
      });
    }

    directorSpan?.update({
      output: directorPlan,
      metadata: {
        attempts: directorAttempts,
        beatCount: directorPlan.beats.length,
      },
    });
    directorSpan?.end();

    const allEvents: TheatricalEvent[] = [];
    const turnHistoryLines = [...historyLines];
    const privateMemory = cloneAgentMemory(shared.agent_memory);
    const dedupeKeySet = new Set<string>();
    let actionUsed = 0;
    let thoughtUsed = 0;

    const emitEventIfAllowed = async (event: TheatricalEvent) => {
      if (event.type === "action") {
        if (actionUsed >= Math.max(0, input.budget.maxActionEventsPerTurn)) return;
        const key = `${event.author.toLowerCase()}|action|${event.content.toLowerCase()}`;
        if (dedupeKeySet.has(key)) return;
        dedupeKeySet.add(key);
        actionUsed += 1;
      }

      if (event.type === "thought") {
        if (thoughtUsed >= Math.max(0, input.budget.maxThoughtEventsPerTurn)) return;
        const key = `${event.author.toLowerCase()}|thought|${event.content.toLowerCase()}`;
        if (dedupeKeySet.has(key)) return;
        dedupeKeySet.add(key);
        thoughtUsed += 1;
        const maxChars = Math.max(1, input.budget.maxThoughtCharsPerEvent);
        if (event.content.length > maxChars) {
          event = { ...event, content: event.content.slice(0, maxChars).trim() };
        }
        if (!event.content) return;
      }

      allEvents.push(event);
      if (event.type !== "thought") {
        turnHistoryLines.push(eventToHistoryLine(event));
      }
      if (input.onEvent) {
        await input.onEvent(event);
      }
    };

    for (let index = 0; index < directorPlan.beats.length; index += 1) {
      const beat = directorPlan.beats[index];
      const roomie = roomiesById.get(beat.agentId);
      if (!roomie) continue;
      const beatId = beat.beatId;
      if (input.onBeatStart) {
        await input.onBeatStart({
          beatId,
          agent_id: roomie.id,
          name: roomie.name,
          step_index: index,
          intent: beat.intent,
        });
      }

      const speakerMessages = buildSpeakerMessages({
        roomie,
        beat,
        userMessage,
        userName,
        goal: shared.goal || input.chamberGoal,
        summaryWindow: shared.summary_window,
        historyLines: turnHistoryLines,
        presetPrompt: input.presetPrompt,
        agentMemory: privateMemory[roomie.id] || [],
      });

      const speakerModel = roomieModels[roomie.id] || input.defaultAgentModel;
      let speakerRaw = await deps.generateText({
        model: speakerModel,
        messages: speakerMessages,
        temperature: 0.5,
        reasoningEffort: input.defaultAgentReasoning,
        trace: {
          name: "room-v3.speaker",
          input: { messages: speakerMessages, beat },
          metadata: { chamberId: input.chamberId, roomieId: roomie.id, beatId },
        },
      });

      let parsedEvents = parseNdjsonTheatricalEvents({
        raw: speakerRaw,
        defaultAuthor: roomie.name,
        defaultBeatId: beatId,
        origin: "roomie",
        nextEventId,
      });

      const canRetrySpeaker = retryAllowed();
      if (!parsedEvents.ok && canRetrySpeaker) {
        const repairMessages = buildSpeakerRepairMessages({
          raw: speakerRaw,
          reason: parsedEvents.reason,
          roomieName: roomie.name,
          beatId,
          allowAction: beat.allowAction,
          allowThought: beat.allowThought,
        });
        speakerRaw = await deps.generateText({
          model: speakerModel,
          messages: repairMessages,
          temperature: 0,
          reasoningEffort: input.defaultAgentReasoning,
          trace: {
            name: "room-v3.speaker-repair",
            input: { messages: repairMessages, beat },
            metadata: { chamberId: input.chamberId, roomieId: roomie.id, beatId },
          },
        });
        parsedEvents = parseNdjsonTheatricalEvents({
          raw: speakerRaw,
          defaultAuthor: roomie.name,
          defaultBeatId: beatId,
          origin: "repair",
          nextEventId,
        });
      } else if (!parsedEvents.ok) {
        deps.logger?.warn?.("room-v3.speaker-retry-skipped", {
          chamberId: input.chamberId,
          roomieId: roomie.id,
          beatId,
          reason: "latency-budget",
        });
      }

      const accepted: TheatricalEvent[] = [];
      if (parsedEvents.ok) {
        for (const event of parsedEvents.events) {
          if (event.type === "action" && !beat.allowAction) continue;
          if (event.type === "thought" && !beat.allowThought) continue;
          accepted.push({
            ...event,
            author: roomie.name,
            beatId,
          });
          if (accepted.length >= beat.maxEvents) break;
        }
      }

      const hasSpeak = accepted.some((event) => event.type === "speak");
      if (!accepted.length || !hasSpeak) {
        accepted.length = 0;
        accepted.push(
          buildFallbackSpeakEvent({
            author: roomie.name,
            content: extractFallbackText(speakerRaw),
            beatId,
            eventId: nextEventId(),
            origin: parsedEvents.ok ? "roomie" : "repair",
          })
        );
      }

      for (const event of accepted) {
        await emitEventIfAllowed(event);
      }

      const privateThoughts = eventsForAgentPrivateMemory(accepted).map((event) => event.content);
      if (privateThoughts.length) {
        const existing = privateMemory[roomie.id] || [];
        privateMemory[roomie.id] = [...existing, ...privateThoughts].slice(-MAX_AGENT_MEMORY);
      }
    }

    if (!allEvents.length) {
      const fallbackRoomie = activeRoomies[0];
      if (fallbackRoomie) {
        const event = buildFallbackSpeakEvent({
          author: fallbackRoomie.name,
          content: "I need one more beat to continue, but here is my take now.",
          beatId: `b${shared.turn_index + 1}-1`,
          eventId: nextEventId(),
          origin: "director",
        });
        allEvents.push(event);
        if (input.onEvent) {
          await input.onEvent(event);
        }
      }
    }

    const userEntry: SharedMessage = {
      role: "user",
      text: userMessage,
      turn_index: shared.turn_index,
    };

    const agentEntries: SharedMessage[] = allEvents
      .filter((event) => event.type !== "thought")
      .map((event) => ({
        role: "agent",
        agent_id: directorPlan.beats.find((beat) => beat.beatId === event.beatId)?.agentId,
        text: eventToHistoryLine(event),
        turn_index: shared.turn_index,
      }));

    const sharedWithMessages: SharedState = {
      ...shared,
      last_messages: [...shared.last_messages, userEntry, ...agentEntries],
      agent_memory: privateMemory,
    };

    const compactEveryChars =
      typeof input.compactEveryChars === "number" && input.compactEveryChars > 0
        ? Math.floor(input.compactEveryChars)
        : DEFAULT_COMPACT_EVERY_CHARS;

    const compactKeepMessages =
      typeof input.compactKeepMessages === "number" && input.compactKeepMessages >= 0
        ? Math.floor(input.compactKeepMessages)
        : DEFAULT_COMPACT_KEEP_MESSAGES;

    const compactChars = estimateSharedChars(sharedWithMessages);
    const shouldCompact = compactEveryChars > 0 && compactChars >= compactEveryChars;

    let summarizedShared = sharedWithMessages;
    if (shouldCompact && input.summarizerModel) {
      const summarizerMessages = buildSummarizerMessagesV3({
        userName,
        userMessage,
        goal: shared.goal || input.chamberGoal,
        summaryWindow: shared.summary_window,
        historyLines: turnHistoryLines,
        meaningfulEvents: eventsForSummarizer(allEvents),
      });

      const summarizerRaw = await deps.generateText({
        model: input.summarizerModel,
        messages: summarizerMessages,
        temperature: 0.2,
        reasoningEffort: input.summarizerReasoning,
        trace: {
          name: "room-v3.summarizer",
          input: { messages: summarizerMessages },
          metadata: { chamberId: input.chamberId, turn: shared.turn_index },
        },
      });

      const summaryWindow = compact(summarizerRaw) || sharedWithMessages.summary_window;
      summarizedShared = {
        ...sharedWithMessages,
        summary_window: summaryWindow,
        last_messages: trimMessages(sharedWithMessages.last_messages, compactKeepMessages),
      };
    }

    const nextShared: SharedState = {
      ...summarizedShared,
      turn_index: shared.turn_index + 1,
    };

    const existingHistory = Array.isArray((state.runtime as Record<string, unknown>).director_plan_history)
      ? ((state.runtime as Record<string, unknown>).director_plan_history as unknown[])
      : [];
    const directorHistory = [...existingHistory, directorPlan].slice(-DIRECTOR_HISTORY_LIMIT);

    const nextState: RoomState = {
      shared: nextShared,
      runtime: {
        ...state.runtime,
        turn_index: nextShared.turn_index,
        last_user_message: userMessage,
        speaker_plan: directorPlan.beats.map((beat) => ({ agent_id: beat.agentId, intent: beat.intent })),
        speaker_outputs: buildSpeakerOutputs(allEvents, directorPlan.beats),
        turn_trace: [
          `contract:v${THEATRICAL_CONTRACT_VERSION}`,
          `director:attempts:${directorPlan.trace.attempts}`,
          `events:${allEvents.length}`,
        ],
        director_plan_history: directorHistory,
        theatrical_contract_version: THEATRICAL_CONTRACT_VERSION,
      },
    };

    await deps.saveState(input.chamberId, nextState);

    const eventCounts = countEventsByType(allEvents);
    deps.logger?.info?.("room-v3.turn", {
      chamberId: input.chamberId,
      userTier: input.userTier,
      turnIndex: shared.turn_index,
      directorSource: directorPlan.trace.source,
      directorAttempts: directorPlan.trace.attempts,
      directorValid: directorPlan.trace.source !== "fallback",
      eventCounts,
      totalEvents: allEvents.length,
      latencyMs: Date.now() - turnStartedAt,
    });

    return {
      outputText: toNdjson(allEvents),
      events: allEvents,
      directorPlan,
      state: nextState,
    };
  };

  return deps.withTrace(
    input.traceContext,
    {
      userMessage,
      turnIndex: state.shared.turn_index,
      roomieIds: input.roomies.map((roomie) => roomie.id),
    },
    runTurn
  );
}
