import type { ReasoningEffort, ReasoningEffortSetting } from "../types";

export const resolveReasoningEffort = (value: ReasoningEffortSetting | null | undefined): ReasoningEffort | null => {
  if (!value || value === "auto") return null;
  return value;
};

const matchesReasoningPrefix = (modelId: string) => {
  if (modelId.startsWith("openai/gpt-5")) return true;
  if (modelId.startsWith("openai/o")) return true;
  if (modelId.startsWith("x-ai/grok")) return true;
  return false;
};

export const supportsReasoningEffortDefault = (modelId: string) => {
  if (!modelId) return false;
  return matchesReasoningPrefix(modelId);
};

export const buildOpenRouterReasoningProviderOptions = (params: {
  modelId: string;
  effort?: ReasoningEffortSetting | null;
  supportsReasoningEffort?: (modelId: string) => boolean;
}) => {
  const resolved = resolveReasoningEffort(params.effort);
  if (!resolved) return undefined;
  const supports = params.supportsReasoningEffort ?? supportsReasoningEffortDefault;
  if (!supports(params.modelId)) return undefined;
  return {
    openai: {
      reasoning: {
        effort: resolved,
      },
    },
  };
};
