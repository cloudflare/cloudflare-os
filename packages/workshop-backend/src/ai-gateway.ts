import { AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class AiGatewayConfig {
  readonly gateway: string;
  readonly workersAiGateway?: string;
  readonly accountId: string;
  readonly apiToken: string;
  readonly providers: Set<string>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    // Inference now goes over HTTPS with tokens (pi has no Workers-binding transport), so the
    // account/token pair is required whenever gateway mode is enabled. The token-less
    // same-account mode existed only because of the Workers binding.
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID || !env.CF_AI_GATEWAY_API_TOKEN) {
      throw new Error(
          "CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_API_TOKEN (a Run + Read token) are " +
          "required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN;
    if (env.CF_AI_GATEWAY_WAI_DIRECT === "true" && env.CF_AI_GATEWAY_WAI) {
      throw new Error(
          "CF_AI_GATEWAY_WAI and CF_AI_GATEWAY_WAI_DIRECT cannot be configured together.");
    }
    this.workersAiGateway = env.CF_AI_GATEWAY_WAI_DIRECT === "true"
      ? undefined
      : env.CF_AI_GATEWAY_WAI || this.gateway;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
  }

  /**
   * Every built-in model this gateway configuration offers, with its provider — the admin
   * panel's view. Unlike the user-facing model list, this is never filtered by admin curation:
   * the panel exists to show disabled models so they can be re-enabled.
   */
  getModelCatalog(): { id: string, name: string, provider: string }[] {
    let result: { id: string, name: string, provider: string }[] = [];
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ id, name: model.name, provider });
        }
      }
    }
    return result;
  }

  /**
   * Get the list of models available through AI Gateway, as AiChatAuthorInfo entries.
   */
  getModelList(): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ type: "agent", id, name: model.name });
        }
      }
    }
    return result;
  }

  /**
   * Look up an AI Gateway model by ID. Returns a UserAiModelRecord if the model is a
   * SUGGESTED_MODEL for an enabled gateway provider, or undefined otherwise.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: {
            provider: provider as AiModelConfig["provider"],
            model: modelId,
            // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
            // reads the real values from env. We set them to empty strings here to satisfy
            // the type.
            apiToken: "",
          },
        };
      }
    }
    return undefined;
  }

  /**
   * Get the AiModelConfig for the quick model (used for title generation).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    // Always use Workers AI here.
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
