import { generateText } from "ai";

import { createOpenRouterClient } from "./openrouter-client";
import { buildOpenRouterReasoningProviderOptions, resolveReasoningEffort } from "./reasoning";
import type {
  RoomTextGenerationTracer,
  RoomTextGenerator,
  RoomTextLogger,
  RoomTextRequest,
} from "./types";

type OpenRouterGeneratorOptions = {
  apiKey?: string;
  baseURL?: string;
  supportsReasoningEffort?: (modelId: string) => boolean;
  logger?: RoomTextLogger;
  startGeneration?: RoomTextGenerationTracer;
};

const estimateTokensFromChars = (chars: number) => Math.ceil(chars / 4);

const getMessageStats = (params: {
  system?: string;
  prompt?: string;
  messages?: { content: string }[];
}) => {
  if (params.messages) {
    const messageChars = params.messages.reduce((total, message) => total + message.content.length, 0);
    return {
      messageCount: params.messages.length,
      messageChars,
      estimatedTokens: estimateTokensFromChars(messageChars),
    };
  }
  const systemChars = params.system?.length ?? 0;
  const promptChars = params.prompt?.length ?? 0;
  const totalChars = systemChars + promptChars;
  return {
    messageCount: 0,
    messageChars: totalChars,
    estimatedTokens: estimateTokensFromChars(totalChars),
  };
};

export const createOpenRouterGenerator = (options: OpenRouterGeneratorOptions = {}): RoomTextGenerator => {
  const client = createOpenRouterClient({ apiKey: options.apiKey, baseURL: options.baseURL });
  const logger = options.logger;

  return async (params: RoomTextRequest) => {
    const temperature = params.temperature ?? 0.4;
    const resolvedReasoning = resolveReasoningEffort(params.reasoningEffort);
    const providerOptions = buildOpenRouterReasoningProviderOptions({
      modelId: params.model,
      effort: params.reasoningEffort,
      supportsReasoningEffort: options.supportsReasoningEffort,
    });

    const stats = getMessageStats(params);
    logger?.info?.(
      "[engine-core] model=%s trace=%s messages=%d messageChars=%d estPromptTokens=%d temperature=%s reasoningEffort=%s",
      params.model,
      params.trace?.name ?? "n/a",
      stats.messageCount,
      stats.messageChars,
      stats.estimatedTokens,
      temperature,
      resolvedReasoning ?? "none"
    );

    const generation = options.startGeneration
      ? options.startGeneration({
          name: params.trace?.name ?? "engine-core.generation",
          input:
            params.trace?.input ??
            (params.messages
              ? { messages: params.messages }
              : { system: params.system, prompt: params.prompt }),
          model: params.model,
          modelParameters: {
            temperature,
            ...(resolvedReasoning ? { reasoningEffort: resolvedReasoning } : {}),
          },
          metadata: params.trace?.metadata,
        })
      : null;

    try {
      const result = await generateText({
        model: client.chat(params.model),
        ...(params.messages
          ? { messages: params.messages }
          : { system: params.system, prompt: params.prompt ?? "" }),
        temperature,
        providerOptions,
      });

      generation?.update({
        output: { text: result.text },
        usageDetails: {
          promptTokens: result.usage?.inputTokens,
          completionTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
      });
      generation?.end();

      return result.text;
    } catch (error) {
      generation?.update({
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      generation?.end();
      throw error;
    }
  };
};
