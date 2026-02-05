import type { ReasoningEffortSetting } from "../types";

export type RoomTextTrace = {
  name: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
};

export type RoomTextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type RoomTextRequest = {
  model: string;
  system?: string;
  prompt?: string;
  messages?: RoomTextMessage[];
  temperature?: number;
  reasoningEffort?: ReasoningEffortSetting;
  trace?: RoomTextTrace;
};

export type RoomTextSpanHandle = {
  update: (data: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    usageDetails?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  }) => void;
  end: () => void;
};

export type RoomTextGenerationTracer = (params: {
  name: string;
  input: unknown;
  model: string;
  modelParameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) => RoomTextSpanHandle | null;

export type RoomTextGenerator = (params: RoomTextRequest) => Promise<string>;

export type RoomTextLogger = {
  info: (message: string, ...meta: unknown[]) => void;
  warn?: (message: string, ...meta: unknown[]) => void;
  error?: (message: string, ...meta: unknown[]) => void;
};
