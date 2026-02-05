import type { ReasoningEffortSetting } from "./types";

export type RoomV2Config = {
  version: number;
  models: {
    summarizer: string;
    defaultAgent: string;
    router: string;
    scorer: string;
  };
  reasoning: {
    summarizer: ReasoningEffortSetting;
    defaultAgent: ReasoningEffortSetting;
    router: ReasoningEffortSetting;
    scorer: ReasoningEffortSetting;
  };
  prompts: {
    summarizer_system: string;
    speaker_system: string;
    router_system: string;
  };
};
