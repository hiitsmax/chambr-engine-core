import {
  THEATRICAL_EVENT_SCHEMA_VERSION,
  type TheatricalBudget,
  type TheatricalEvent,
  type TheatricalEventOrigin,
  type TheatricalEventType,
  type TheatricalEventVisibility,
} from "./types";

const EVENT_TYPES: TheatricalEventType[] = ["speak", "action", "thought"];
const EVENT_SET = new Set(EVENT_TYPES);

const VISIBILITY_VALUES: TheatricalEventVisibility[] = ["public", "private"];
const VISIBILITY_SET = new Set(VISIBILITY_VALUES);

const ORIGIN_VALUES: TheatricalEventOrigin[] = ["roomie", "director", "repair"];
const ORIGIN_SET = new Set(ORIGIN_VALUES);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const compact = (value: string) =>
  value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const toSafeInt = (value: unknown, fallback: number) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
};

const sanitizeType = (value: unknown): TheatricalEventType | null => {
  if (typeof value !== "string") return null;
  return EVENT_SET.has(value as TheatricalEventType) ? (value as TheatricalEventType) : null;
};

const sanitizeVisibility = (value: unknown, fallback: TheatricalEventVisibility): TheatricalEventVisibility => {
  if (typeof value !== "string") return fallback;
  return VISIBILITY_SET.has(value as TheatricalEventVisibility)
    ? (value as TheatricalEventVisibility)
    : fallback;
};

const sanitizeOrigin = (value: unknown, fallback: TheatricalEventOrigin): TheatricalEventOrigin => {
  if (typeof value !== "string") return fallback;
  return ORIGIN_SET.has(value as TheatricalEventOrigin) ? (value as TheatricalEventOrigin) : fallback;
};

export const createEventIdFactory = (prefix: string) => {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
};

export const serializeTheatricalEvent = (event: TheatricalEvent) => JSON.stringify(event);

export const toNdjson = (events: TheatricalEvent[]) => events.map((event) => serializeTheatricalEvent(event)).join("\n");

export const buildFallbackSpeakEvent = (params: {
  author: string;
  content: string;
  beatId: string;
  eventId: string;
  origin?: TheatricalEventOrigin;
}): TheatricalEvent => ({
  type: "speak",
  author: params.author,
  content: compact(params.content),
  eventId: params.eventId,
  beatId: params.beatId,
  schemaVersion: THEATRICAL_EVENT_SCHEMA_VERSION,
  visibility: "public",
  intensity: 2,
  origin: params.origin ?? "roomie",
});

export const parseNdjsonTheatricalEvents = (params: {
  raw: string;
  defaultAuthor: string;
  defaultBeatId: string;
  origin?: TheatricalEventOrigin;
  nextEventId: () => string;
}): { ok: true; events: TheatricalEvent[] } | { ok: false; reason: string } => {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty-output" };
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { ok: false, reason: "empty-lines" };
  }

  const events: TheatricalEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: "invalid-json-line" };
    }

    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "invalid-object" };
    }

    const record = parsed as Record<string, unknown>;
    const type = sanitizeType(record.type);
    if (!type) return { ok: false, reason: "invalid-type" };

    const authorRaw = typeof record.author === "string" ? record.author.trim() : "";
    const author = authorRaw || params.defaultAuthor;
    if (!author) return { ok: false, reason: "missing-author" };

    const contentRaw = typeof record.content === "string" ? record.content : "";
    const content = compact(contentRaw);
    if (!content) return { ok: false, reason: "empty-content" };

    const visibilityFallback: TheatricalEventVisibility = type === "thought" ? "private" : "public";
    const visibility = sanitizeVisibility(record.visibility, visibilityFallback);
    const origin = sanitizeOrigin(record.origin, params.origin ?? "roomie");

    const intensity = clamp(toSafeInt(record.intensity, type === "speak" ? 2 : 3), 1, 5);

    const event: TheatricalEvent = {
      type,
      author,
      content,
      eventId:
        typeof record.eventId === "string" && record.eventId.trim()
          ? record.eventId.trim()
          : params.nextEventId(),
      beatId:
        typeof record.beatId === "string" && record.beatId.trim()
          ? record.beatId.trim()
          : params.defaultBeatId,
      schemaVersion: clamp(toSafeInt(record.schemaVersion, THEATRICAL_EVENT_SCHEMA_VERSION), 1, 1000),
      visibility,
      intensity,
      origin,
    };

    events.push(event);
  }

  if (!events.length) {
    return { ok: false, reason: "no-events" };
  }

  return { ok: true, events };
};

const dedupeSimilarEvents = (events: TheatricalEvent[]) => {
  const seen = new Set<string>();
  const deduped: TheatricalEvent[] = [];

  for (const event of events) {
    if (event.type === "speak") {
      deduped.push(event);
      continue;
    }
    const key = `${event.author.toLowerCase()}|${event.type}|${event.content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
};

export const applyBudgetCaps = (events: TheatricalEvent[], budget: TheatricalBudget): TheatricalEvent[] => {
  const deduped = dedupeSimilarEvents(events);
  const next: TheatricalEvent[] = [];

  let actionCount = 0;
  let thoughtCount = 0;

  for (const event of deduped) {
    if (event.type === "action") {
      if (actionCount >= Math.max(0, budget.maxActionEventsPerTurn)) continue;
      actionCount += 1;
      next.push(event);
      continue;
    }

    if (event.type === "thought") {
      if (thoughtCount >= Math.max(0, budget.maxThoughtEventsPerTurn)) continue;
      thoughtCount += 1;
      const maxChars = Math.max(1, budget.maxThoughtCharsPerEvent);
      const clipped = event.content.length > maxChars ? event.content.slice(0, maxChars).trim() : event.content;
      if (!clipped) continue;
      next.push({ ...event, content: clipped });
      continue;
    }

    next.push(event);
  }

  return next;
};

export const eventsForPublicHistory = (events: TheatricalEvent[]) =>
  events.filter((event) => event.type !== "thought" || event.visibility === "public");

export const eventsForAgentPrivateMemory = (events: TheatricalEvent[]) =>
  events.filter((event) => event.type === "thought");

export const eventsForSummarizer = (events: TheatricalEvent[]) => {
  return events.filter((event) => {
    if (event.type === "speak") return true;
    if (event.type === "action") return event.intensity >= 2;
    if (event.type === "thought") {
      if (event.visibility !== "public") return false;
      return event.content.length >= 24;
    }
    return false;
  });
};

export const eventToHistoryLine = (event: TheatricalEvent) => {
  if (event.type === "speak") return `${event.author}: ${event.content}`;
  if (event.type === "action") return `${event.author} (action): ${event.content}`;
  return `${event.author} (thought): ${event.content}`;
};
