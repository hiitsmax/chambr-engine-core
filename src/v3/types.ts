import type { RoomTextGenerator, RoomTextSpanHandle } from "../llm/types";
import type {
  ReasoningEffortSetting,
  RoomState,
  Roomie,
  RoomieModelAssignment,
  UserTier,
} from "../types";

export const THEATRICAL_CONTRACT_VERSION = 1;
export const THEATRICAL_EVENT_SCHEMA_VERSION = 1;

export type TheatricalEventType = "speak" | "action" | "thought";
export type TheatricalEventVisibility = "public" | "private";
export type TheatricalEventOrigin = "roomie" | "director" | "repair";

export type TheatricalEvent = {
  type: TheatricalEventType;
  author: string;
  content: string;
  eventId: string;
  beatId: string;
  schemaVersion: number;
  visibility: TheatricalEventVisibility;
  intensity: number;
  origin: TheatricalEventOrigin;
};

export type DirectorBeat = {
  beatId: string;
  agentId: string;
  intent: string;
  allowAction: boolean;
  allowThought: boolean;
  toneHint: string;
  maxEvents: number;
};

export type TheatricalBudget = {
  maxDirectorAttempts: number;
  maxActionEventsPerTurn: number;
  maxThoughtEventsPerTurn: number;
  maxThoughtCharsPerEvent: number;
  targetP95TurnLatencyMs: number;
};

export type DirectorPlan = {
  contractVersion: number;
  schemaVersion: number;
  turnIndex: number;
  presetId: string;
  budgets: TheatricalBudget;
  beats: DirectorBeat[];
  trace: {
    source: "model" | "repair" | "fallback";
    attempts: number;
    reason?: string;
  };
};

export type RoomTraceContextV3 = {
  chamberId: string;
  userId?: string;
};

export type RoomTraceMetaV3 = {
  userMessage: string;
  turnIndex: number;
  roomieIds: string[];
};

export type RoomEngineDepsV3 = {
  loadState: (chamberId: string) => Promise<{ state: RoomState }>;
  saveState: (chamberId: string, state: RoomState) => Promise<void>;
  getModelAssignment?: (params: { chamberId: string; userId: string }) => Promise<{
    assignment: RoomieModelAssignment;
    tier: UserTier;
    manualOverride: boolean;
  } | null>;
  saveModelAssignment?: (params: {
    chamberId: string;
    userId: string;
    tier: UserTier;
    assignment: RoomieModelAssignment;
    manualOverride: boolean;
  }) => Promise<void>;
  generateText: RoomTextGenerator;
  withTrace: <T>(
    context: RoomTraceContextV3 | undefined,
    meta: RoomTraceMetaV3,
    fn: () => Promise<T>
  ) => Promise<T>;
  startSpan?: (params: {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }) => RoomTextSpanHandle | null;
  logger?: {
    info?: (message: string, ...meta: unknown[]) => void;
    warn?: (message: string, ...meta: unknown[]) => void;
    error?: (message: string, ...meta: unknown[]) => void;
  };
};

export type RoomTurnInputV3 = {
  chamberId: string;
  userId: string;
  userName: string;
  userTier: UserTier;
  userMessage: string;
  chamberGoal?: string;
  roomies: Roomie[];
  defaultAgentModel: string;
  directorModel: string;
  summarizerModel?: string;
  directorReasoning?: ReasoningEffortSetting;
  defaultAgentReasoning?: ReasoningEffortSetting;
  summarizerReasoning?: ReasoningEffortSetting;
  budget: TheatricalBudget;
  presetId: string;
  presetPrompt: string;
  thoughtDisplayDefault?: boolean;
  maxAgents?: number;
  compactEveryChars?: number;
  compactKeepMessages?: number;
  onBeatStart?: (payload: {
    beatId: string;
    agent_id: string;
    name: string;
    step_index: number;
    intent: string;
  }) => void | Promise<void>;
  onEvent?: (event: TheatricalEvent) => void | Promise<void>;
  traceContext?: RoomTraceContextV3;
};

export type RoomTurnResultV3 = {
  outputText: string;
  events: TheatricalEvent[];
  directorPlan: DirectorPlan;
  state: RoomState;
};

export type DirectorPlanSchema = {
  beats: Array<{
    agent_id: string;
    intent: string;
    allow_action?: boolean;
    allow_thought?: boolean;
    tone_hint?: string;
    max_events?: number;
  }>;
};
