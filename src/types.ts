export const REASONING_EFFORT_SETTINGS = ["auto", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffortSetting = (typeof REASONING_EFFORT_SETTINGS)[number];
export type ReasoningEffort = Exclude<ReasoningEffortSetting, "auto">;

export type UserTier = "BASE" | "PRO" | "MAX";

export type AgentMemory = Record<string, string[]>;

export type MemoryUpdate = {
  agent_id: string;
  notes: string[];
};

export type SharedMessage = {
  role: "user" | "agent";
  agent_id?: string;
  text: string;
  turn_index: number;
};

export type SharedState = {
  goal: string;
  summary_window: string;
  last_messages: SharedMessage[];
  agent_memory: AgentMemory;
  turn_index: number;
};

export type SpeakerStep = {
  agent_id: string;
  intent: string;
};

export type SpeakerOutput = {
  agent_id: string;
  intent: string;
  text: string;
  step_index: number;
};

export type RuntimeState = {
  turn_index: number;
  speaker_plan: SpeakerStep[];
  speaker_outputs: SpeakerOutput[];
  last_user_message?: string;
  turn_trace: string[];
  director_plan_history?: unknown[];
  theatrical_contract_version?: number;
};

export type RoomState = {
  shared: SharedState;
  runtime: RuntimeState;
};

export type Roomie = {
  id: string;
  name: string;
  bio: string;
  traits?: string | null;
};

export type ModelCatalogEntry = {
  modelId: string;
  label?: string | null;
  enabled: boolean;
  tiers: Record<UserTier, boolean>;
  [key: string]: unknown;
};

export type RoomieModelAssignment = {
  roomieModels: Record<string, string>;
};
