import {
  AdminGatewayProvider, AdminModel, AiChatAuthorInfo, AiModelConfig, AiModelProvider, GatewayModel,
  GatewayModelMode, HTTPS_ONLY_PROVIDERS, ReasoningLevel, SUGGESTED_MODELS,
} from "@gadgets/workshop-shared/api";
import { readAdminConfig } from "./admin-config.js";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "./storage-schema/user-storage.js";

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Providers AI Gateway serves: the ones gatewayNativeModel() in ai-models.ts has a route for.
 * Ollama has none, so a model added under it could never run.
 */
const GATEWAY_PROVIDERS: ReadonlySet<string> =
    new Set<AiModelProvider>(["anthropic", "openai", "google", "cloudflare"]);

/** Throws unless AI Gateway serves `provider`. */
export function assertGatewayProvider(provider: string): void {
  if (!GATEWAY_PROVIDERS.has(provider)) {
    throw new Error(`Provider "${provider}" is not served through AI Gateway.`);
  }
}

/** Whether SUGGESTED_MODELS lists `modelId`, under any provider. */
export function isCatalogModel(modelId: string): boolean {
  return Object.values(SUGGESTED_MODELS).some(models => Object.hasOwn(models, modelId));
}

function tokenLimits({ contextWindow, outputLimit }
    : Pick<GatewayModel, "contextWindow" | "outputLimit">) {
  return outputLimit === undefined ? { contextWindow } : { contextWindow, outputLimit };
}

/** The config a gateway model runs with, before what its admin set for it. */
export function gatewayModelConfig(model: AdminModel): AiModelConfig {
  return {
    provider: model.provider,
    model: model.id,
    // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
    // reads the real values from env. We set them to empty strings here to satisfy
    // the type.
    apiToken: "",
    // An added model's limits travel in the config, which token budgeting reads ahead of the
    // catalog. A suggested model's are the catalog's own.
    ...(model.added ? tokenLimits(model) : {}),
  };
}

export class AiGatewayConfig {
  readonly gateway: string;
  /**
   * The gateway name for Workers-AI-binding calls (webFetch's toMarkdown): binding calls only
   * reach gateways in the Worker's own account, so this is the platform gateway whenever the
   * binding transport is active, and unset when it isn't (see {@link binding}).
   */
  readonly sameAccountGateway?: string;
  readonly accountId: string;
  readonly apiToken?: string;
  /**
   * Workers AI binding, used as the gateway transport whenever present unless
   * CF_AI_GATEWAY_USE_BINDING=false opts out: binding requests are pre-authenticated in-account,
   * so inference and cost-log reads need no API token. Binding requests only reach gateways in
   * the Worker's own account, and the Worker can't verify that itself (it can't discover its own
   * account ID), so deployments whose gateway lives in a DIFFERENT account must set the opt-out
   * and use CF_AI_GATEWAY_API_TOKEN over HTTPS. Absent in local dev unless run-dev-server is
   * started with --use-workers-ai-binding.
   *
   * Such a deployment opts out with the flag rather than by unbinding WORKERS_AI, because the
   * binding is not only the gateway transport: webFetch's document-to-Markdown conversion calls
   * `env.ai.toMarkdown()` through it (see web-fetch.ts), so unbinding would break that too.
   */
  readonly binding?: Ai;
  /** The providers CF_AI_GATEWAY_PROVIDERS lists, which an admin can add to (see GatewayModels). */
  readonly providers: Set<string>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID) {
      throw new Error("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN || undefined;
    // Normalized once, so a stray " False " opts out rather than reading as unset and silently
    // picking the other transport.
    const useBinding = env.CF_AI_GATEWAY_USE_BINDING?.trim().toLowerCase();
    this.binding = useBinding === "false"
        ? undefined
        : (env as { WORKERS_AI?: Ai }).WORKERS_AI;
    if (useBinding === "true" && !this.binding) {
      throw new Error(
          "CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding; without it the config " +
          "would silently fall back to the HTTPS transport.");
    }
    if (!this.apiToken && !this.binding) {
      throw new Error(
          "AI Gateway mode needs a transport: bind Workers AI (WORKERS_AI; in local dev start " +
          "with --use-workers-ai-binding) or set CF_AI_GATEWAY_API_TOKEN (a Run + Read token).");
    }
    this.sameAccountGateway = this.binding ? this.gateway : undefined;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    const httpsOnly = [...this.providers].filter(p => HTTPS_ONLY_PROVIDERS.has(p));
    if (httpsOnly.length > 0 && !this.apiToken) {
      const names = httpsOnly.join(", ");
      throw new Error(
          `${names} inference cannot ride the Workers AI binding transport, so enabling the ` +
          `${names} provider${httpsOnly.length > 1 ? "s" : ""} requires ` +
          "CF_AI_GATEWAY_API_TOKEN.");
    }
  }

  /**
   * Transport for a provider's gateway inference: the Workers AI binding when present, except for
   * the providers in {@link HTTPS_ONLY_PROVIDERS}, which ride HTTPS with the token (the
   * constructor guarantees a token whenever the environment enables one of them; one that an
   * admin enabled without a token is refused per request, in getModelViaGateway).
   */
  bindingFor(provider: string): Ai | undefined {
    return HTTPS_ONLY_PROVIDERS.has(provider) ? undefined : this.binding;
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

/**
 * The models a deployment provides through AI Gateway (`gateway`), each in the mode its admin
 * gave it (see GatewayModelMode): the suggested models of every provider the deployment enables
 * (`providers`), each provider's followed by the models the admin added under it. Listing and
 * resolving a gateway model both go through here, so neither can happen without the admin's
 * modes and settings.
 */
export class GatewayModels {
  /**
   * The providers the deployment enables: the environment's, which are a floor, and the ones its
   * admin added that the gateway serves.
   */
  readonly providers: ReadonlySet<string>;
  /** Every model, in any mode, in listing order. */
  readonly all: readonly AdminModel[];
  /** The providers a model may be added under: the ones the gateway both enables and serves. */
  readonly addableProviders: AiModelProvider[] = [];
  /**
   * Whether users may add models of their own, which run through the gateway like these. When
   * false, these are the only models a user can list or run.
   */
  readonly userModels: boolean;
  readonly #byId = new Map<string, AdminModel>();
  /** The stored added models, including the ones this table leaves out. */
  readonly #added: readonly GatewayModel[];
  /** The reasoning level of a model whose settings give none. */
  readonly #defaultReasoning: ReasoningLevel | null;

  constructor(readonly gateway: AiGatewayConfig,
              config: Pick<AdminConfig, "modelModes" | "addedProviders" | "addedModels" |
                  "userModelsEnabled" | "modelSettings" | "defaultReasoning">) {
    this.providers = new Set([
      ...gateway.providers,
      ...config.addedProviders.filter(provider => GATEWAY_PROVIDERS.has(provider)),
    ]);
    this.#added = config.addedModels;
    this.userModels = config.userModelsEnabled;
    this.#defaultReasoning = config.defaultReasoning;
    let add = (model: GatewayModel, defaultMode: GatewayModelMode, added: boolean) => {
      if (this.#byId.has(model.id)) return;
      // Object.hasOwn, so that an ID like "constructor" does not find an inherited mode.
      let mode = Object.hasOwn(config.modelModes, model.id)
          ? config.modelModes[model.id] : defaultMode;
      let settings = Object.hasOwn(config.modelSettings, model.id)
          ? config.modelSettings[model.id] : undefined;
      this.#byId.set(
          model.id, { ...model, mode, defaultMode, added, ...(settings && { settings }) });
    };
    for (let [provider, catalog] of Object.entries(SUGGESTED_MODELS)) {
      if (!this.providers.has(provider)) continue;
      for (let [id, model] of Object.entries(catalog)) {
        add({ provider: provider as AiModelProvider, id, name: model.name, ...tokenLimits(model) },
            model.hidden ? "hidden" : "enabled", false);
      }
      if (!GATEWAY_PROVIDERS.has(provider)) continue;
      this.addableProviders.push(provider as AiModelProvider);
      for (let model of config.addedModels) {
        // A gateway model is looked up by ID alone, so the catalog wins an ID it lists under any
        // provider, whether or not the gateway enables that one.
        if (model.provider === provider && !isCatalogModel(model.id)) add(model, "enabled", true);
      }
    }
    this.all = [...this.#byId.values()];
  }

  /** Every provider the gateway serves, enabled or not, in catalog order. */
  get providerSettings(): AdminGatewayProvider[] {
    return (Object.keys(SUGGESTED_MODELS) as AiModelProvider[])
        .filter(provider => GATEWAY_PROVIDERS.has(provider))
        .map(provider => ({
          provider,
          ...(this.providers.has(provider) &&
              { enabledBy: this.gateway.providers.has(provider) ? "environment" : "admin" }),
          // What getModelViaGateway refuses a request for. Only an admin can enable a provider
          // in that state: the environment enabling one keeps `gateway` from being built.
          needsApiToken: !this.gateway.bindingFor(provider) && !this.gateway.apiToken,
        }));
  }

  /** The gateway model with this ID, in any mode: even a disabled model's ID stays reserved. */
  get(id: string): AdminModel | undefined {
    return this.#byId.get(id);
  }

  /** The models offered in pickers, i.e. the enabled ones, as AiChatAuthorInfo entries. */
  list(): AiChatAuthorInfo[] {
    return this.all.filter(model => model.mode === "enabled")
        .map(({ id, name }) => ({ type: "agent", id, name }));
  }

  /**
   * Look up a gateway model by ID in order to run it. Hidden models resolve, so stored references
   * to them keep working. Returns undefined for a disabled model and for an ID that names no
   * gateway model.
   */
  resolve(id: string): UserAiModelRecord | undefined {
    let model = this.#byId.get(id);
    let config = this.runConfig(id);
    if (!model || !config || model.mode === "disabled") return undefined;
    return { profile: { type: "agent", id, name: model.name }, config };
  }

  /**
   * The config a gateway model runs with, whatever its mode: a disabled model has one too, for
   * an admin to test it with, and whether a model may run is for resolve() and refuseDisabled()
   * to say. Returns undefined for an ID that names no gateway model. The config carries what the
   * admin set and nothing for what is unset, so that an untouched model runs exactly as it does
   * with no admin settings at all.
   */
  runConfig(id: string): AiModelConfig | undefined {
    let model = this.#byId.get(id);
    if (!model) return undefined;
    let reasoning = model.settings?.reasoning ?? this.#defaultReasoning;
    let budget = model.settings?.compactionInputBudget;
    return {
      ...gatewayModelConfig(model),
      ...(model.behavesLike !== undefined ? { behavesLike: model.behavesLike } : {}),
      ...(reasoning !== null ? { reasoning } : {}),
      ...(budget !== undefined ? { compactionInputBudget: budget } : {}),
    };
  }

  /** Throws if `id` names a gateway model that an admin disabled. */
  refuseDisabled(id: string): void {
    let model = this.#byId.get(id);
    if (model?.mode === "disabled") {
      throw new Error(
          `The "${model.name}" model is disabled on this deployment by an administrator.`);
    }
  }

  /**
   * Throws unless users may add models of their own. `name` is that of the model being run, when
   * the refusal is of one a user added rather than of adding one.
   */
  refuseUserModel(name?: string): void {
    if (this.userModels) return;
    throw new Error(name === undefined
        ? "Adding your own models is disabled on this deployment by an administrator."
        : `The "${name}" model can't be used: adding your own models is disabled on this ` +
          "deployment by an administrator.");
  }

  /**
   * Throws unless `model`, already well-formed (see sanitizeAddedModel), may join the added
   * models: the gateway serves and enables its provider, and its ID is free. An ID the catalog
   * lists under any provider is taken, as is that of a stored added model this table leaves out.
   */
  assertAddable(model: GatewayModel): void {
    assertGatewayProvider(model.provider);
    if (!this.providers.has(model.provider)) {
      throw new Error(`Provider "${model.provider}" is not enabled on this deployment.`);
    }
    if (isCatalogModel(model.id)) throw new Error(`"${model.id}" is already a suggested model.`);
    if (this.#added.some(added => added.id === model.id)) {
      throw new Error(`"${model.id}" is already an added model.`);
    }
  }
}

/**
 * The deployment's AI Gateway models, or null if AI Gateway mode is not enabled. Only a gateway
 * deployment reads the admin config for them.
 */
export async function getGatewayModels(env: Cloudflare.Env): Promise<GatewayModels | null> {
  let gateway = getAiGatewayConfig(env);
  if (!gateway) return null;
  return new GatewayModels(gateway, await readAdminConfig(env));
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
