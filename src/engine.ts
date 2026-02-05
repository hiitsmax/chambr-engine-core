import type { RoomV2Config } from "./config";
import { buildSummarizerMessages } from "./prompts";
import type {
  ModelCatalogEntry,
  ReasoningEffortSetting,
  Roomie,
  RoomieModelAssignment,
  RoomState,
  SpeakerOutput,
  SpeakerStep,
  SharedState,
  UserTier,
} from "./types";
import type { RoomTextGenerator, RoomTextMessage, RoomTextSpanHandle } from "./llm/types";

export type RoomTraceContext = {
  chamberId: string;
  userId?: string;
};

export type RoomTraceMeta = {
  userMessage: string;
  turnIndex: number;
  roomieIds: string[];
};

export type RoomEngineDeps = {
  loadState: (chamberId: string) => Promise<{ state: RoomState; config: RoomV2Config }>;
  saveState: (chamberId: string, state: RoomState) => Promise<void>;
  getModelCatalog: () => Promise<ModelCatalogEntry[]>;
  getModelAssignment: (params: { chamberId: string; userId: string }) => Promise<{
    assignment: RoomieModelAssignment;
    tier: UserTier;
    manualOverride: boolean;
  } | null>;
  saveModelAssignment: (params: {
    chamberId: string;
    userId: string;
    tier: UserTier;
    assignment: RoomieModelAssignment;
    manualOverride: boolean;
  }) => Promise<void>;
  generateText: RoomTextGenerator;
  withTrace: <T>(context: RoomTraceContext | undefined, meta: RoomTraceMeta, fn: () => Promise<T>) => Promise<T>;
  startSpan?: (params: { name: string; input?: unknown; metadata?: Record<string, unknown> }) => RoomTextSpanHandle | null;
  logger?: { info?: (message: string, ...meta: unknown[]) => void };
};

export type RoomTurnInput = {
  chamberId: string;
  userId: string;
  userName: string;
  userTier: UserTier;
  userMessage: string;
  chamberGoal?: string;
  roomies: Roomie[];
  maxAgents?: number;
  compactEveryChars?: number;
  compactKeepMessages?: number;
  onSpeakerStart?: (payload: { agent_id: string; name: string; step_index: number; intent: string }) => void | Promise<void>;
  onSpeakerOutput?: (output: SpeakerOutput) => void | Promise<void>;
  traceContext?: RoomTraceContext;
};

export type RoomTurnResult = {
  outputText: string;
  outputs: SpeakerOutput[];
  state: RoomState;
  config: RoomV2Config;
};

const ENABLE_SPEAKER_OUTPUT_FILTER = false;
const DEFAULT_COMPACT_EVERY_CHARS = 12000;
const DEFAULT_COMPACT_KEEP_MESSAGES = 5;

const compact = (value: string) =>
  value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const toText = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toSpeakLine = (author: string, content: string) =>
  JSON.stringify({ type: "speak", author, content });

type LocalMessage = Pick<SharedState["last_messages"][number], "role" | "agent_id" | "text">;

type MessageEntry = { author: string; content: string };

const normalizeName = (value: string | null | undefined, fallback: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
};

const buildHistoryMessages = (state: RoomState): LocalMessage[] =>
  (state.shared.last_messages || []).map((message) => ({
    role: message.role,
    agent_id: message.agent_id,
    text: message.text,
  }));

const buildMessageEntries = (
  messages: LocalMessage[],
  params: { userName: string; agentNames: Map<string, string>; selfAgentId?: string }
): MessageEntry[] =>
  messages.map((message) => {
    if (message.role === "user") {
      return { author: params.userName, content: message.text };
    }
    if (message.agent_id && message.agent_id === params.selfAgentId) {
      return { author: "You", content: message.text };
    }
    const agentName = message.agent_id ? params.agentNames.get(message.agent_id) : null;
    return { author: normalizeName(agentName, "Agent"), content: message.text };
  });

const buildHistoryLines = (entries: MessageEntry[]) => entries.map((entry) => `${entry.author}: ${entry.content}`);

const estimateSharedChars = (shared: SharedState): number => {
  const historyChars = shared.last_messages.reduce((total, message) => total + message.text.length, 0);
  return shared.goal.length + shared.summary_window.length + historyChars;
};

const trimMessages = (messages: SharedState["last_messages"], keepCount: number) => {
  if (keepCount <= 0) return [];
  if (messages.length <= keepCount) return messages;
  return messages.slice(-keepCount);
};

const tokenize = (value: unknown) =>
  toText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);

const scoreModelTokens = (context: string, modelIdentity?: unknown | null) => {
  if (!modelIdentity) return 0;
  const contextTokens = new Set(tokenize(context));
  const goodForTokens = tokenize(modelIdentity);
  let score = 0;
  for (const token of goodForTokens) {
    if (contextTokens.has(token)) score += 1;
  }
  return score;
};

const SCORE_MODEL_SYSTEM =
  "You are a model scorer. Use ONLY the provided anonymized identity data to score fit. " +
  "Return only a minified JSON array in the format " +
  '[{"id":"M1","score":0-100,"reason":"..."}]. ' +
  "Include every id exactly once. Reasons must be short and grounded in the identity data.";

type ScoredCandidate = {
  modelId: string;
  anonId: string;
  score: number;
  reason: string;
};

const extractJsonArray = (raw: string) => {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
};

const buildScoringPrompt = (params: {
  roomieContext: string;
  candidates: { anonId: string; identity?: unknown | null }[];
}) => {
  const identityLines = params.candidates.map((candidate) => {
    const identity = candidate.identity ?? null;
    return `${candidate.anonId}: ${JSON.stringify(identity)}`;
  });
  return ["Roomie context:", params.roomieContext, "", "Anonymized model identities:", ...identityLines].join("\n");
};

const scoreModel = async (deps: RoomEngineDeps, params: {
  roomieContext: string;
  candidates: { modelId: string; identity?: unknown | null }[];
  scorerModel: string;
  reasoningEffort?: ReasoningEffortSetting;
  traceMeta?: Record<string, unknown>;
}): Promise<ScoredCandidate[]> => {
  if (!params.candidates.length) return [];
  const anonymized = params.candidates.map((candidate, index) => ({
    modelId: candidate.modelId,
    anonId: `M${index + 1}`,
    identity: candidate.identity ?? null,
  }));
  const prompt = buildScoringPrompt({
    roomieContext: params.roomieContext,
    candidates: anonymized,
  });

  let parsedScores: Map<string, { score: number; reason: string }> | null = null;
  try {
    const messages: RoomTextMessage[] = [
      { role: "system", content: SCORE_MODEL_SYSTEM },
      { role: "user", content: prompt },
    ];
    const raw = await deps.generateText({
      model: params.scorerModel,
      messages,
      temperature: 0,
      reasoningEffort: params.reasoningEffort,
      trace: {
        name: "room-v2.1.scorer",
        input: { messages },
        metadata: params.traceMeta,
      },
    });
    const parsed = extractJsonArray(raw);
    if (Array.isArray(parsed)) {
      parsedScores = new Map();
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) continue;
        const scoreRaw = record.score;
        const scoreValue =
          typeof scoreRaw === "number"
            ? scoreRaw
            : typeof scoreRaw === "string" && scoreRaw.trim()
              ? Number(scoreRaw)
              : NaN;
        if (!Number.isFinite(scoreValue)) continue;
        const score = Math.max(0, Math.min(100, Math.round(scoreValue)));
        const reason = typeof record.reason === "string" && record.reason.trim()
          ? record.reason.trim()
          : "No reason provided.";
        parsedScores.set(id, { score, reason });
      }
    }
  } catch {
    parsedScores = null;
  }

  return anonymized.map((candidate) => {
    const resolved = parsedScores?.get(candidate.anonId);
    if (resolved) {
      return {
        modelId: candidate.modelId,
        anonId: candidate.anonId,
        score: resolved.score,
        reason: resolved.reason,
      };
    }
    return {
      modelId: candidate.modelId,
      anonId: candidate.anonId,
      score: scoreModelTokens(params.roomieContext, candidate.identity),
      reason: "Fallback score from token overlap.",
    };
  });
};

type RoomieAssignmentDecision = {
  roomieId: string;
  roomieName: string;
  roomieContext: string;
  pickedModelId: string;
  reason: "existing" | "highest-available" | "round-robin" | "fallback";
  scores?: { modelId: string; anonId: string; score: number; reason: string }[];
};

const buildRoomieModelAssignment = async (deps: RoomEngineDeps, params: {
  roomies: Roomie[];
  candidates: { modelId: string; identity?: unknown | null }[];
  fallbackModel: string;
  context: string;
  scorerModel: string;
  scorerReasoning?: ReasoningEffortSetting;
  traceMeta?: Record<string, unknown>;
  existing?: RoomieModelAssignment;
}): Promise<{ roomieModels: Record<string, string>; decisions: RoomieAssignmentDecision[] }> => {
  const roomieModels: Record<string, string> = { ...(params.existing?.roomieModels ?? {}) };
  const decisions: RoomieAssignmentDecision[] = [];
  if (params.roomies.length === 0) return { roomieModels, decisions };
  const pool = params.candidates.length
    ? params.candidates
    : [{ modelId: params.fallbackModel, identity: null }];

  const used = new Set(Object.values(roomieModels));
  let cursor = 0;

  for (const roomie of params.roomies) {
    const roomieContext = [params.context, roomie.name, roomie.bio, roomie.traits].filter(Boolean).join("\n");
    if (roomieModels[roomie.id]) {
      decisions.push({
        roomieId: roomie.id,
        roomieName: roomie.name,
        roomieContext,
        pickedModelId: roomieModels[roomie.id],
        reason: "existing",
      });
      continue;
    }
    const scoredRaw = await scoreModel(deps, {
      roomieContext,
      candidates: pool,
      scorerModel: params.scorerModel,
      reasoningEffort: params.scorerReasoning,
      traceMeta: params.traceMeta ? { ...params.traceMeta, roomieId: roomie.id } : { roomieId: roomie.id },
    });
    const scored = scoredRaw.sort((a, b) => b.score - a.score);

    let picked = scored.find((model) => !used.has(model.modelId))?.modelId;
    let reason: RoomieAssignmentDecision["reason"] = "highest-available";
    if (!picked) {
      if (scored.length > 0) {
        picked = scored[cursor % scored.length]?.modelId || params.fallbackModel;
        reason = "round-robin";
        cursor += 1;
      } else {
        picked = params.fallbackModel;
        reason = "fallback";
      }
    }
    roomieModels[roomie.id] = picked;
    used.add(picked);
    decisions.push({
      roomieId: roomie.id,
      roomieName: roomie.name,
      roomieContext,
      pickedModelId: picked,
      reason,
      scores: scored.map((entry) => ({
        modelId: entry.modelId,
        anonId: entry.anonId,
        score: entry.score,
        reason: entry.reason,
      })),
    });
  }

  return { roomieModels, decisions };
};

const extractSpeakContent = (raw: string) => {
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && parsed.type === "speak" && typeof parsed.content === "string") {
      return parsed.content;
    }
  } catch {
    // ignore parse errors
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      if (parsed && parsed.type === "speak" && typeof parsed.content === "string") {
        return parsed.content;
      }
    } catch {
      // ignore parse errors
    }
  }
  return raw;
};

const trimWords = (value: string, limit: number) => value.split(/\s+/).filter(Boolean).slice(0, limit).join(" ");

const sanitizeSpeakerOutput = (params: {
  text: string;
  allowTable: boolean;
  allowBoard: boolean;
  agentNames: Map<string, string>;
  selfName: string;
}) => {
  let text = extractSpeakContent(params.text).trim();
  if (!text) return text;
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/\{[^}]*"type"\s*:\s*"speak"[\s\S]*?\}/g, "");
  text = text.replace(/^\s*#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*•]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");

  const otherNames = new Set(
    Array.from(params.agentNames.values())
      .map((name) => name.trim())
      .filter(Boolean)
  );
  otherNames.delete(params.selfName.trim());

  let lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !otherNames.has(line));
  lines = lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);

  if (params.allowTable) {
    const tableLines = lines.filter((line) => line.includes("|"));
    if (tableLines.length) {
      return tableLines
        .slice(0, 4)
        .map((line) => {
          const cols = line
            .split("|")
            .map((col) => col.trim())
            .filter(Boolean)
            .slice(0, 2);
          if (!cols.length) return line.trim();
          return `| ${cols.join(" | ")} |`;
        })
        .join("\n");
    }
  }

  if (params.allowBoard) {
    const boardLines = lines.length ? lines : [text];
    return boardLines
      .slice(0, 4)
      .map((line) => {
        const cleaned = line.replace(/^post-?it:\s*/i, "");
        const trimmed = trimWords(cleaned, 6);
        return trimmed ? `POST-IT: ${trimmed}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  const flattened = lines.join(" ");
  const sentences = flattened
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const limited = sentences.length ? sentences.slice(0, 4).join(" ") : flattened;
  return compact(limited);
};

const buildConversationMessages = (params: {
  historyMessages: LocalMessage[];
  userMessage: string;
  userName: string;
  agentNames: Map<string, string>;
  selfAgentId: string;
}): RoomTextMessage[] => {
  const messages: RoomTextMessage[] = params.historyMessages.map((message) => {
    const entry = buildMessageEntries([message], {
      userName: params.userName,
      agentNames: params.agentNames,
      selfAgentId: params.selfAgentId,
    })[0];
    const isSelf = message.agent_id === params.selfAgentId;
    const role = isSelf ? "assistant" : "user";
    const cleanedText = message.agent_id ? extractSpeakContent(message.text) : message.text;
    if (!entry) {
      return {
        role,
        content: cleanedText,
      };
    }
    return {
      role,
      content: isSelf ? cleanedText : `${entry.author}: ${cleanedText}`,
    };
  });
  messages.push({ role: "user", content: params.userMessage });
  return messages;
};

const buildSystemPromptMessages = (params: {
  goal?: string;
  roomie: Roomie;
  summaryWindow: string;
}): RoomTextMessage[] => {
  const task = [
    "<Task>",
    "You are doing roleplay intepreting the character described in the character section in a irl discussion.",
    "</Task>",
  ].join("\n");
  const discussionSummary = [
    "<DiscussionSummary>",
    "<Goal>",
    params.goal ? params.goal : "(none)",
    "</Goal>",
    "<SummaryWindow>",
    params.summaryWindow ? `${params.summaryWindow}` : "",
    "</SummaryWindow>",
    "</DiscussionSummary>",
  ].join("\n");
  const character = [
    "<Character>",
    "<Name>",
    params.roomie.name,
    "</Name>",
    "<Bio>",
    params.roomie.bio,
    "</Bio>",
    "<Traits>",
    params.roomie.traits ? `${params.roomie.traits}` : "",
    "</Traits>",
    "</Character>",
  ].join("\n");
  const rules = [
    "<Rules>",
    "<Rule>Follow OutputFormat exactly.</Rule>",
    "<Rule>Reply like a group chat message; default to 3-4 short sentences unless the goal or user asks for more.</Rule>",
    "<Rule>Never include speaker labels or your own name; output only message text.</Rule>",
    "<Rule>Avoid echoing others; add a new angle or decision.</Rule>",
    "<Rule>Always prioritize the most recent user message; any unprefixed message is from the real human.</Rule>",
    "<Rule>Interact with other participants when it helps, but avoid open questions unless necessary.</Rule>",
    "<Rule>Use traits and personal style to sound human, concise, and natural in chat.</Rule>",
    "<Rule>If you have nothing to say you can comment whatever your character would do in a normal chat.</Rule>",
    "</Rules>",
  ].join("\n");

  const outputFormat = [
    "<OutputFormat>",
    "<Default>Plain chat text only. No JSON, no Markdown, no lists.</Default>",
    "<Default>3-4 short sentences max unless explicitly asked for more.</Default>",
    "<PostIt>When asked for a post-it board, output 4 lines max: POST-IT: <2-6 words>.</PostIt>",
    "<Table>When asked for a table, use 2 columns and 2-4 rows max, no header.</Table>",
    "</OutputFormat>",
  ].join("\n");
  return [
    { role: "system", content: task },
    { role: "system", content: discussionSummary },
    { role: "system", content: character },
    { role: "system", content: rules },
    { role: "system", content: outputFormat },
  ];
};

const buildRoutingPrompt = (params: {
  goal?: string;
  userMessage: string;
  userName: string;
  roomies: Roomie[];
  maxAgents: number;
  historyLines: string[];
  summaryWindow: string;
}) => {
  const roomieLines = params.roomies.map((roomie) => `- ${roomie.id}: ${roomie.name} — ${roomie.bio}`);
  const blocks = [
    "You are selecting which roomies should respond to the user.",
    params.goal ? `Goal: ${params.goal}` : "Goal: (none)",
    `Max agents: ${params.maxAgents}`,
    "Roomies:",
    ...roomieLines,
    params.historyLines.length ? "Recent context:" : "",
    ...params.historyLines,
    params.summaryWindow ? `Summary: ${params.summaryWindow}` : "",
    `${params.userName}: ${params.userMessage}`,
    "Return a JSON array of roomie ids in the order they should reply. No extra text.",
  ].filter(Boolean);
  return blocks.join("\n");
};

const parseRoomieIds = (raw: string): string[] => {
  const trimmed = raw.trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string");
    }
  } catch {
    return [];
  }
  return [];
};

// Linear, minimal v2.1 engine with router + summarizer.
export async function runRoomTurnLinear(deps: RoomEngineDeps, input: RoomTurnInput): Promise<RoomTurnResult> {
  if (!input.userMessage.trim()) {
    throw new Error("User message is required");
  }

  const turnTrace: string[] = [];
  const trace = (message: string) => {
    turnTrace.push(message);
  };

  // 1) Load state + config.
  const { state, config } = await deps.loadState(input.chamberId);
  trace("state:loaded");

  const runTurn = async () => {
    // 2) Ensure a goal exists if provided.
    let shared = state.shared;
    if (input.chamberGoal && !shared.goal) {
      shared = { ...shared, goal: input.chamberGoal };
      trace("goal:set-from-input");
    }

    // 2.5) Resolve per-roomie model assignment (per user + chamber + tier).
    const existingAssignment = await deps.getModelAssignment({
      chamberId: input.chamberId,
      userId: input.userId,
    });
    const catalog = await deps.getModelCatalog();
    const candidates = catalog
      .filter((entry) => entry.enabled && entry.tiers[input.userTier])
      .map((entry) => {
        const { modelId, label, tiers, ...identity } = entry;
        void label;
        void tiers;
        return { modelId, identity };
      });
    const context = [shared.goal || input.chamberGoal, input.userMessage, shared.summary_window].filter(Boolean).join("\n");

    const assignmentSpan = deps.startSpan?.({
      name: "room-v2.1.model-assignment",
      input: {
        chamber_id: input.chamberId,
        user_id: input.userId,
        tier: input.userTier,
        context,
        scorer_model: config.models.scorer,
        scorer_reasoning: config.reasoning.scorer,
        roomies: input.roomies.map((roomie) => ({
          id: roomie.id,
          name: roomie.name,
          bio: roomie.bio,
          traits: roomie.traits ?? null,
        })),
        candidates: candidates.map((candidate) => ({
          modelId: candidate.modelId,
          identity: candidate.identity ?? null,
        })),
        existing_assignment: existingAssignment?.assignment?.roomieModels ?? null,
        manual_override: existingAssignment?.manualOverride ?? false,
      },
      metadata: {
        candidate_count: candidates.length,
        existing_assignment: Boolean(existingAssignment),
      },
    });

    let assignment = existingAssignment?.assignment;
    let manualOverride = existingAssignment?.manualOverride ?? false;
    let assignmentDecisions: RoomieAssignmentDecision[] = [];
    let assignmentSource: "fresh" | "refresh" = "refresh";

    if (!assignment || existingAssignment?.tier !== input.userTier) {
      const assignmentResult = await buildRoomieModelAssignment(deps, {
        roomies: input.roomies,
        candidates,
        fallbackModel: config.models.defaultAgent,
        context,
        scorerModel: config.models.scorer,
        scorerReasoning: config.reasoning.scorer,
        traceMeta: { chamberId: input.chamberId },
      });
      assignmentSource = "fresh";
      assignment = { roomieModels: assignmentResult.roomieModels };
      assignmentDecisions = assignmentResult.decisions;
      manualOverride = false;
      await deps.saveModelAssignment({
        chamberId: input.chamberId,
        userId: input.userId,
        tier: input.userTier,
        assignment,
        manualOverride,
      });
    } else {
      const assignmentResult = await buildRoomieModelAssignment(deps, {
        roomies: input.roomies,
        candidates,
        fallbackModel: config.models.defaultAgent,
        context,
        existing: assignment,
        scorerModel: config.models.scorer,
        scorerReasoning: config.reasoning.scorer,
        traceMeta: { chamberId: input.chamberId },
      });
      assignment = { roomieModels: assignmentResult.roomieModels };
      assignmentDecisions = assignmentResult.decisions;
      await deps.saveModelAssignment({
        chamberId: input.chamberId,
        userId: input.userId,
        tier: input.userTier,
        assignment,
        manualOverride,
      });
    }

    const roomieModels = assignment?.roomieModels ?? {};
    trace(`models:assigned:${Object.keys(roomieModels).length}`);

    assignmentSpan?.update({
      output: {
        source: assignmentSource,
        manual_override: manualOverride,
        assignment: roomieModels,
        decisions: assignmentDecisions,
      },
    });
    assignmentSpan?.end();

    // 3) Route roomies using a lightweight selector agent (fallback to linear).
    const maxAgents =
      typeof input.maxAgents === "number" && input.maxAgents > 0 ? input.maxAgents : input.roomies.length;
    const historyMessages = buildHistoryMessages({ ...state, shared });
    trace(`history:loaded:${historyMessages.length}`);
    const agentNames = new Map(input.roomies.map((roomie) => [roomie.id, roomie.name]));
    const userName = normalizeName(input.userName, "User");
    const structureHint = [input.userMessage, shared.goal].map(toText).join(" ").toLowerCase();
    const allowTable = /(tabell|table|griglia)/.test(structureHint);
    const allowBoard = /(post\s?-?it|postit|post-it|sticky)/.test(structureHint);
    let activeRoomies: Roomie[] = input.roomies.slice(0, maxAgents);
    if (input.roomies.length > 1) {
      const routingEntries = buildMessageEntries(historyMessages, { userName, agentNames });
      const routingHistoryLines = buildHistoryLines(routingEntries);
      const routingPrompt = buildRoutingPrompt({
        goal: shared.goal || input.chamberGoal,
        userMessage: input.userMessage,
        userName,
        roomies: input.roomies,
        maxAgents,
        historyLines: routingHistoryLines,
        summaryWindow: shared.summary_window,
      });
      trace("routing:prompt-built");
      const routingMessages: RoomTextMessage[] = [{ role: "user", content: routingPrompt }];
      const routingRaw = await deps.generateText({
        model: config.models.router,
        messages: routingMessages,
        temperature: 0,
        reasoningEffort: config.reasoning.router,
        trace: {
          name: "room-v2.1.routing",
          input: { messages: routingMessages },
          metadata: { chamberId: input.chamberId },
        },
      });
      trace("routing:response-received");
      const routedIds = parseRoomieIds(routingRaw);
      if (routedIds.length) {
        const byId = new Map(input.roomies.map((roomie) => [roomie.id, roomie]));
        const picked = routedIds
          .map((id) => byId.get(id))
          .filter((roomie): roomie is Roomie => Boolean(roomie));
        if (picked.length) {
          activeRoomies = picked.slice(0, maxAgents);
          trace(`routing:picked:${activeRoomies.map((roomie) => roomie.id).join(",")}`);
        }
      }
    }
    const speakerPlan: SpeakerStep[] = activeRoomies.map((roomie) => ({ agent_id: roomie.id, intent: "respond" }));
    trace(`speaker:plan:${speakerPlan.length}`);

    // 4) Run each roomie one-by-one and stream outputs.
    const outputs: SpeakerOutput[] = [];

    for (let index = 0; index < activeRoomies.length; index += 1) {
      const roomie = activeRoomies[index];
      trace(`speaker:start:${roomie.id}`);
      if (input.onSpeakerStart) {
        await input.onSpeakerStart({
          agent_id: roomie.id,
          name: roomie.name,
          step_index: index,
          intent: "respond",
        });
      }
      const conversationMessages = buildConversationMessages({
        historyMessages,
        userMessage: input.userMessage,
        userName,
        agentNames,
        selfAgentId: roomie.id,
      });

      const systemMessages = buildSystemPromptMessages({
        goal: shared.goal || input.chamberGoal,
        roomie,
        summaryWindow: shared.summary_window,
      });

      const roomieModel = roomieModels[roomie.id] || config.models.defaultAgent;
      const speakerMessages: RoomTextMessage[] = [...systemMessages, ...conversationMessages];
      const rawText = await deps.generateText({
        model: roomieModel,
        messages: speakerMessages,
        temperature: 0.6,
        trace: {
          name: "room-v2.1.speaker",
          input: { messages: speakerMessages, model: roomieModel },
          metadata: { chamberId: input.chamberId, roomieId: roomie.id },
        },
      });

      const content = ENABLE_SPEAKER_OUTPUT_FILTER
        ? sanitizeSpeakerOutput({
            text: rawText,
            allowTable,
            allowBoard,
            agentNames,
            selfName: roomie.name,
          })
        : compact(rawText);
      if (!content) {
        trace(`speaker:empty:${roomie.id}`);
        continue;
      }
      const output: SpeakerOutput = {
        agent_id: roomie.id,
        intent: "respond",
        text: toSpeakLine(roomie.name, content),
        step_index: index,
      };

      outputs.push(output);
      trace(`speaker:done:${roomie.id}`);
      if (input.onSpeakerOutput) {
        await input.onSpeakerOutput(output);
      }
      historyMessages.push({ role: "agent", agent_id: roomie.id, text: content });
    }

    // 5) Summarize and persist shared state updates.
    const userMessageEntry = {
      role: "user" as const,
      text: input.userMessage,
      turn_index: shared.turn_index,
    };
    const agentEntries = outputs.map((output) => ({
      role: "agent" as const,
      agent_id: output.agent_id,
      text: extractSpeakContent(output.text),
      turn_index: shared.turn_index,
    }));

    const sharedWithMessages: SharedState = {
      ...shared,
      last_messages: [...shared.last_messages, userMessageEntry, ...agentEntries],
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

    if (shouldCompact) {
      trace(`summarizer:compact:triggered:${compactChars}`);
      const summarizerPrompt = buildSummarizerMessages({
        shared: sharedWithMessages,
        userMessage: input.userMessage,
        userName,
        agentNames,
        speakerOutputs: outputs,
        systemPrompt: config.prompts.summarizer_system,
      });
      trace("summarizer:prompt-built");

      const summarizerMessages: RoomTextMessage[] = [
        { role: "system", content: summarizerPrompt.system },
        { role: "user", content: summarizerPrompt.prompt },
      ];
      const summarizerRaw = await deps.generateText({
        model: config.models.summarizer,
        messages: summarizerMessages,
        temperature: 0.2,
        reasoningEffort: config.reasoning.summarizer,
        trace: {
          name: "room-v2.1.summarizer",
          input: { messages: summarizerMessages },
          metadata: { chamberId: input.chamberId },
        },
      });
      trace("summarizer:response-received");

      const summaryCandidate = compact(summarizerRaw);
      const summaryWindow = summaryCandidate || sharedWithMessages.summary_window;
      summarizedShared = {
        ...sharedWithMessages,
        summary_window: summaryWindow,
        last_messages: trimMessages(sharedWithMessages.last_messages, compactKeepMessages),
      };
    } else {
      trace(`summarizer:skipped:${compactChars}`);
    }

    const nextShared: SharedState = {
      ...summarizedShared,
      turn_index: shared.turn_index + 1,
    };

    trace("state:prepared");
    const nextState: RoomState = {
      shared: nextShared,
      runtime: {
        ...state.runtime,
        turn_index: nextShared.turn_index,
        last_user_message: input.userMessage,
        speaker_plan: speakerPlan,
        speaker_outputs: outputs,
        turn_trace: turnTrace,
      },
    };

    await deps.saveState(input.chamberId, nextState);

    // 6) Return a single NDJSON payload (compatible with current UI parsing).
    const outputText = outputs.map((output) => output.text).filter(Boolean).join("\n");
    return { outputText, outputs, state: nextState, config };
  };

  return deps.withTrace(
    input.traceContext,
    {
      userMessage: input.userMessage,
      turnIndex: state.shared.turn_index,
      roomieIds: input.roomies.map((roomie) => roomie.id),
    },
    runTurn
  );
}
