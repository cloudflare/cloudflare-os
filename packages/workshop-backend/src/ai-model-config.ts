import type {AiModelConfig} from "@gadgets/workshop-shared/api";
import {findOpenAiCompatibleModel} from "@gadgets/workshop-shared/openai-compatible-models";

const CHAT_COMPLETIONS_PATH = "/chat/completions";

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

// Validate and normalize fields owned by the OpenAI-compatible provider.
export function normalizeAiModelConfig(config: AiModelConfig): AiModelConfig {
  if (config.provider !== "openai-compatible") return config;

  const model = config.model.trim();
  if (!model) throw new Error("OpenAI-compatible model ID is required.");

  const apiToken = config.apiToken.trim();
  if (!apiToken) throw new Error("OpenAI-compatible API token is required.");
  if (!config.apiUrl) throw new Error("OpenAI-compatible base URL is required.");

  let apiUrl: URL;
  try {
    apiUrl = new URL(config.apiUrl);
  } catch {
    throw new Error("OpenAI-compatible base URL must be a valid HTTPS URL.");
  }
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && isLoopback(apiUrl.hostname))) {
    throw new Error("OpenAI-compatible base URL must be a valid HTTPS URL (or loopback HTTP URL).");
  }
  if (apiUrl.username || apiUrl.password) {
    throw new Error("OpenAI-compatible base URL must not contain credentials.");
  }
  if (apiUrl.search) throw new Error("OpenAI-compatible base URL must not contain a query string.");
  if (apiUrl.hash) throw new Error("OpenAI-compatible base URL must not contain a fragment.");

  const pathname = apiUrl.pathname.replace(/\/+$/, "");
  apiUrl.pathname = pathname.endsWith(CHAT_COMPLETIONS_PATH)
    ? pathname.slice(0, -CHAT_COMPLETIONS_PATH.length) || "/"
    : pathname || "/";

  const normalizedUrl = apiUrl.toString().replace(/\/$/, "");
  const catalog = findOpenAiCompatibleModel(normalizedUrl, model);
  const contextWindow = catalog?.contextWindow ?? config.contextWindow;
  const outputLimit = catalog?.outputLimit ?? config.outputLimit;

  if (!Number.isSafeInteger(contextWindow) || contextWindow! <= 0) {
    throw new Error("OpenAI-compatible context window must be a positive integer.");
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit! <= 0) {
    throw new Error("OpenAI-compatible output limit must be a positive integer.");
  }
  if (!catalog && outputLimit! >= contextWindow!) {
    throw new Error("OpenAI-compatible output limit must be less than the context window.");
  }

  return {
    ...config,
    model,
    apiToken,
    apiUrl: normalizedUrl,
    contextWindow,
    outputLimit,
  };
}
