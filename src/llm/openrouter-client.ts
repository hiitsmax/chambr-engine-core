import { createOpenAI } from "@ai-sdk/openai";

export const createOpenRouterClient = (params?: { apiKey?: string; baseURL?: string }) => {
  const baseURL = params?.baseURL ?? "https://openrouter.ai/api/v1";
  return createOpenAI({
    baseURL,
    apiKey: params?.apiKey,
  });
};
