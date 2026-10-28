import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  AnthropicMessagesCompat, Api, AssistantMessageEventStream, ClassifierApi, ClassifierContext,
  ClassifierModel, ClassifierOptions, ClassifierResult, Context, FetchFunction, Model, ModelCost,
  OpenAICompletionsCompat, ProviderHeaders, SimpleStreamOptions, StreamFunction, Usage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, normalizeContext }
  from "@earendil-works/pi-ai";
import { stream as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { classify as workersAiClassify } from "@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one";
import { stream as googleGenerativeAiStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { resolveGoogleThinkingLevel, toGoogleThinkingLevel, usesGoogleThinkingLevel }
  from "@earendil-works/pi-ai/api/google-shared";
import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openaiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel }
  from "@earendil-works/pi-ai/api/simple-options";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import {
  CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS, CLOUDFLARE_WORKERS_AI_MODELS,
} from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { ApprovalQueue, Gatekeeper, ResourceDescription, stripTrailingSlashes } from '@gadgets/workshop-shared/gatekeeper';
import { LanguageModelBinding } from "./ai-model-binding";
import AI_MODEL_BINDING_TYPES from "./ai-model-binding.txt";
import { DecisionAnswer, DecisionModelBinding, DecisionRequest } from "./decision-model-binding";
import DECISION_MODEL_BINDING_TYPES from "./decision-model-binding.txt";
import {
  AiChatAuthorInfo, AiModelConfig, AiModelProvider, BuiltInReasoning, GatewayModelCapabilities,
  REASONING_LEVELS, ReasoningLevel, SUGGESTED_MODELS, WORKERS_AI_OUTPUT_LIMIT,
} from "@gadgets/workshop-shared/api";
import { traceChat } from "./agent-tracing.js";
import {
  AiGatewayConfig, getAiGatewayConfig, getGatewayModels, type AiGatewayLogRoute,
} from "./ai-gateway.js";
import { completeText } from "./ai-invoke.js";
import { bridgePdfAttachments } from "./chat-attachment-pdf.js";
import {
  estimateSharedHeadTokens, hasGpt56PromptCaching, splitSystemPrompt,
} from "./system-prompt-blocks.js";

 /**
  * Routing to bill a user's own Cloudflare account for inference (BYOK path once the free tier is
  * exhausted). Defined here to avoid a backend->ai-gateway-billing type import cycle at runtime.
  * Inference is routed through the account's "default" AI Gateway.
  */
 export interface UserGatewayRouting {
   accountId: string;
   apiKey: string;
 }

// Gadgets-owned attribution schema attached to AI Gateway requests.
type GatewayMetadata = {
  // Stable Gadgets user identifier for attribution.
  user: string;
  // Gadgets execution context, present when the call is associated with a gadget operation.
  source?: GatewayMetadataContext["source"];
  gadgetId?: string;
  chatId?: number;
  // Distinguishes gadget-initiated model calls from interactive user calls.
  automated?: true;
};

type GatewayMetadataContext = {
  source: "chat" | "thread-title" | "gadget-title" | "model-binding" | "cache-warm";
  gadgetId?: string;
  chatId?: number;
};

type ModelRoutingOptions = {
  sessionAffinity?: string;
  userGateway?: UserGatewayRouting;
  metadata?: GatewayMetadataContext;
};

/**
 * Per-call stream options accepted by a ModelHandle, extending pi's own options with
 * handle-level knobs.
 */
export type ModelStreamOptions = SimpleStreamOptions & {
  /**
   * When false, suppress the handle's per-API thinking/reasoning defaults so the request runs
   * without extended thinking (as far as the model allows). Used by completeText(): one-shot
   * calls -- titles, binding names, compaction summaries, gadget model bindings -- should be
   * quick, and none of them benefit from cross-step reasoning. Default: true.
   */
  thinking?: boolean;
};

/**
 * A resolved model plus everything needed to stream from it: `stream` closes over the routing
 * (endpoint, auth headers, gateway attribution metadata, session affinity) chosen by getModel(),
 * so callers never handle credentials themselves. pi streams never throw/reject for provider
 * failures; failures surface as a final AssistantMessage with stopReason "error"/"aborted".
 */
export type ModelHandle = {
  /** pi model descriptor (plain data; pi dispatches purely on `model.api`). */
  model: Model<Api>;

  /**
   * Streams a response. Merges the handle's routing/auth and per-API options into whatever
   * per-call options the caller (e.g. the agent loop) passes. Assignable to pi-agent-core's
   * StreamFn (the extra ModelStreamOptions knobs are optional).
   */
  stream: (model: Model<Api>, context: Context, options?: ModelStreamOptions)
      => AssistantMessageEventStream;

  /**
   * Route for retrieving this model's AI Gateway logs for cost accounting. Absent when requests
   * don't flow through an AI Gateway (direct provider access, direct Workers AI REST).
   */
  aiGatewayLogRoute?: AiGatewayLogRoute;

  /**
   * Status and AI Gateway log id of the most recent HTTP response observed by `stream`. Reset at
   * the start of every request and set from pi's onResponse callback (which fires only once a
   * response arrives -- an SDK-level failure leaves this undefined), so consumers must read it
   * right after the request they care about completes. Turns run requests sequentially, so this
   * is safe.
   */
  lastResponse?: { status: number; aiGatewayLogId?: string };

  /**
   * The most recent request `stream` sent with prompt caching on, once its response ends, if the
   * provider cached any of it and the handle can send it again to keep that copy (see
   * CachedRequest). Cleared at the start of every request, so consumers must read it right after
   * the request they care about completes.
   */
  lastRequest?: CachedRequest;
};

/**
 * A request a handle completed with prompt caching on, which it can send again to keep the
 * provider's cached copy of its prompt: each read of that copy restarts its lifetime.
 */
export type CachedRequest = {
  /** When the request was sent. The provider counts the cache lifetime from a request's start. */
  sentAt: number;

  /** How long the provider keeps the prompt cached after a request last read or wrote it. */
  cacheLifetime: number;

  /**
   * What one resend costs at most, in dollars: a read of the whole prompt from the cache, and the
   * longest response its cap allows.
   */
  resendCost: number;

  /**
   * What the chat's next request pays extra, in dollars, if the cached copy expires first: a
   * write instead of a read of the chat's own part of the prompt (see estimateSharedHeadTokens).
   */
  expiryCost: number;

  /**
   * Sends the request again with the smallest response cap its API takes, through the handle's
   * routing, marked as a cache warm-up in AI Gateway. Resolves with what the resend used, and the
   * AI Gateway log that prices it where it went through a gateway; rejects if it fails.
   */
  resend(): Promise<Resent>;
};

/** What a resend used, priced from the model catalog, and the AI Gateway log that prices it. */
export type Resent = {
  usage: Usage;
  aiGatewayLogId?: string;
  aiGatewayLogRoute?: AiGatewayLogRoute;
};

function buildMetadata(initiator: AiChatAuthorInfo, context?: GatewayMetadataContext): GatewayMetadata {
  const metadata: GatewayMetadata = { user: initiator.id };
  if (context) {
    metadata.source = context.source;
    if (context.gadgetId) metadata.gadgetId = context.gadgetId;
    if (context.chatId !== undefined) metadata.chatId = context.chatId;
  }
  if (initiator.type === "gadget") metadata.automated = true;
  return metadata;
}

// The pi API implementations we route through, keyed by `Model.api`. Import per-module (never
// `providers/all`, which drags ~30 providers into the bundle).
const API_STREAMS: Record<string, StreamFunction<Api, SimpleStreamOptions>> = {
  "anthropic-messages": anthropicMessagesStream as StreamFunction<Api, SimpleStreamOptions>,
  "openai-responses": openaiResponsesStream as StreamFunction<Api, SimpleStreamOptions>,
  "openai-completions": openaiCompletionsStream as StreamFunction<Api, SimpleStreamOptions>,
  "google-generative-ai": googleGenerativeAiStream as StreamFunction<Api, SimpleStreamOptions>,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// pi's builtin catalogs, by provider. Import per-provider, not providers/all.
const CATALOGS: Partial<Record<AiModelProvider, Record<string, Model<Api>>>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
  cloudflare: CLOUDFLARE_WORKERS_AI_MODELS,
};

// Consult pi's builtin catalog for cost/compat metadata of a known model id. Unknown models are
// fine (synthesized with zero cost).
function catalogModel(provider: AiModelProvider, modelId: string): Model<Api> | undefined {
  let catalog = CATALOGS[provider];
  // Object.hasOwn, so that an ID like "constructor" does not find an inherited entry.
  return catalog && Object.hasOwn(catalog, modelId) ? catalog[modelId] : undefined;
}

/** Whether the model runtime (pi's catalog) has an entry for `modelId` under `provider`. */
export function isRuntimeModel(provider: AiModelProvider, modelId: string): boolean {
  return catalogModel(provider, modelId) !== undefined;
}

// What a model descriptor takes from pi's catalog. An entry borrowed from another model supplies
// the runtime flags alone, so that the name, cost and limits stay the model's own, and one made
// of stated capabilities supplies only what they state.
type CatalogEntry = Pick<Model<Api>, "id"> & Partial<Pick<Model<Api>,
    "compat" | "thinkingLevelMap" | "reasoning" | "input" | "name" | "cost" | "contextWindow" |
    "maxTokens">>;

// pi's entry for a gateway model: its own or, while pi has none, the flags of the model its
// config says it behaves like, under the capabilities its config states. pi's own entry always
// wins, so a pi that learns the model takes over from both.
function gatewayCatalogModel(config: AiModelConfig): CatalogEntry | undefined {
  let own = catalogModel(config.provider, config.model);
  if (own) return own;
  let like = config.behavesLike === undefined
      ? undefined : catalogModel(config.provider, config.behavesLike);
  if (!like && !config.capabilities) return undefined;
  // The models Anthropic may answer with in the other one's place are not flags: they would have
  // this model answered by them, at their prices.
  let { allowedFallbackModels, ...compat } = (like?.compat ?? {}) as AnthropicMessagesCompat;
  let entry: CatalogEntry = {
    id: like?.id ?? config.model, compat: like?.compat && compat,
    thinkingLevelMap: like?.thinkingLevelMap, reasoning: like?.reasoning, input: like?.input,
  };
  let { imageInput, reasoningLevels } = config.capabilities ?? {};
  if (imageInput !== undefined) entry.input = imageInput ? ["text", "image"] : ["text"];
  if (reasoningLevels) {
    entry.reasoning = reasoningLevels.some(level => level !== "off");
    // pi has a Claude whose effort it manages think on every request, whatever the descriptor
    // says of its reasoning, so a model stated to do none does not borrow that.
    if (!entry.reasoning && entry.compat) {
      let { supportsMidConvoEffort, ...unmanaged } = compat;
      entry.compat = unmanaged;
    }
    // pi reads both the levels a model has and the level a request is clamped to from this map,
    // where null says the model lacks a level. A stated level keeps the wire value the borrowed
    // entry gives it and otherwise has none, so it is sent as pi sends that level by default.
    // pi offers "xhigh" and "max" only where they are mapped, so each maps to its own name, or
    // to "high" on Gemini, where pi takes no higher level. pi sends Workers AI no effort for an
    // "off" that is not mapped, which leaves the model reasoning, so there it maps to "none",
    // which is what the Workers AI models that stop reasoning are sent.
    entry.thinkingLevelMap = Object.fromEntries(REASONING_LEVELS.map(level => {
      let wire = like?.thinkingLevelMap?.[level];
      return [level, !reasoningLevels.includes(level) ? null :
          typeof wire === "string" ? wire :
          level === "off" && config.provider === "cloudflare" ? "none" :
          level !== "xhigh" && level !== "max" ? undefined :
          config.provider === "google" ? "high" : level];
    }));
  }
  return entry;
}

// Token limits for a synthesized model. The model config's own overrides come first, then
// SUGGESTED_MODELS (compaction budgets in agent-compaction.ts are computed from the same two); pi's
// catalog fills gaps for models we don't list, and unknown models get conservative defaults.
function modelTokenWindow(config: AiModelConfig, catalog: CatalogEntry | undefined)
    : { contextWindow: number, maxTokens: number } {
  const suggested = SUGGESTED_MODELS[config.provider]?.[config.model];
  return {
    contextWindow: config.contextWindow ?? suggested?.contextWindow ?? catalog?.contextWindow ??
        128_000,
    maxTokens: config.outputLimit ?? suggested?.outputLimit ??
        (config.provider === "cloudflare" ? WORKERS_AI_OUTPUT_LIMIT : undefined) ??
        catalog?.maxTokens ?? 4096,
  };
}

// Compat flags for a Workers AI model reached over its OpenAI-compatible endpoint (direct REST
// or the gateway's workers-ai route). Matches pi's own generated Workers AI catalog entries.
function workersAiCompat(catalog: CatalogEntry | undefined): OpenAICompletionsCompat {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    ...(catalog?.compat as OpenAICompletionsCompat | undefined),
    sendSessionAffinityHeaders: true,
    // pi assumes that nothing behind an AI Gateway host takes a reasoning effort, which the
    // workers-ai route does. It only matters once a request has an effort to send.
    supportsReasoningEffort: true,
  };
}

// Build the pi model descriptor for reaching a provider's own native API through an AI Gateway
// (the platform's or a user's). `gatewayUrl` is a gateway root -- over HTTPS
// (https://gateway.ai.cloudflare.com/v1/{accountId}/{gateway}) or, for binding-routed requests,
// over the AI binding (https://workers-binding.ai/ai-gateway/gateways/{gateway}); each
// provider's native API is exposed under the same per-provider path on either. AI Gateway also
// offers a unified OpenAI-compat
// translation layer (/compat), which we deliberately never use: we already speak every
// provider's native API, and the translation drops provider features pi relies on (extended
// thinking, Anthropic cache_control prompt caching, the OpenAI Responses API). Billing --
// including unified billing on a user's own gateway -- is orthogonal to which API a request
// speaks. Returns undefined for providers AI Gateway cannot serve (ollama).
function gatewayNativeModel(config: AiModelConfig, gatewayUrl: string): Model<Api> | undefined {
  const catalog = gatewayCatalogModel(config);
  const window = modelTokenWindow(config, catalog);
  switch (config.provider) {
    case "anthropic":
      return {
        id: config.model,
        name: catalog?.name ?? config.model,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: `${gatewayUrl}/anthropic`,
        reasoning: catalog?.reasoning ?? true,
        input: catalog?.input ?? ["text", "image"],
        cost: catalog?.cost ?? ZERO_COST,
        ...window,
        thinkingLevelMap: catalog?.thinkingLevelMap,
        // Catalog compat verbatim: pi's catalog marks exactly the models that require the
        // adaptive thinking format (forceAdaptiveThinking); forcing it here breaks models that
        // don't support it (Haiku). Uncataloged model ids get budget-format thinking config --
        // if a new adaptive-only model isn't yet in pi's catalog, bump pi, or have the model
        // behave like one that is (AiModelConfig.behavesLike).
        compat: catalog?.compat,
      };
    case "openai":
      return {
        id: config.model,
        name: catalog?.name ?? config.model,
        api: "openai-responses",
        provider: "openai",
        baseUrl: `${gatewayUrl}/openai`,
        reasoning: catalog?.reasoning ?? true,
        input: catalog?.input ?? ["text", "image"],
        cost: catalog?.cost ?? ZERO_COST,
        ...window,
        thinkingLevelMap: catalog?.thinkingLevelMap,
        compat: catalog?.compat,
      };
    case "google":
      // pi's own gateway catalog skips Google, but the gateway's google-ai-studio passthrough +
      // pi's google API impl work; we construct the model ourselves. The @google/genai SDK
      // treats baseUrl as already including the version path.
      return {
        id: config.model,
        name: catalog?.name ?? config.model,
        api: "google-generative-ai",
        provider: "google",
        baseUrl: `${gatewayUrl}/google-ai-studio/v1beta`,
        reasoning: catalog?.reasoning ?? true,
        input: catalog?.input ?? ["text", "image"],
        cost: catalog?.cost ?? ZERO_COST,
        ...window,
        thinkingLevelMap: catalog?.thinkingLevelMap,
      };
    case "cloudflare":
      // Workers AI's own OpenAI-compatible endpoint, exposed through the gateway's workers-ai
      // route. This is Workers AI's native chat API (the same surface as its direct
      // /accounts/{id}/ai/v1 REST endpoint), not the gateway's cross-provider /compat layer.
      return {
        id: config.model,
        name: catalog?.name ?? config.model,
        api: "openai-completions",
        provider: "cloudflare-workers-ai",
        baseUrl: `${gatewayUrl}/workers-ai/v1`,
        reasoning: catalog?.reasoning ?? false,
        input: catalog?.input ?? ["text"],
        cost: catalog?.cost ?? ZERO_COST,
        ...window,
        // With the catalog's level map, pi sends an effort on every request, the one the map
        // gives "off" included. So the descriptor has the map only when a level is set, and
        // requests are otherwise sent no effort at all.
        ...(config.reasoning !== undefined ? { thinkingLevelMap: catalog?.thinkingLevelMap } : {}),
        compat: workersAiCompat(catalog),
      };
    default:
      return undefined;
  }
}

/**
 * The reasoning levels a gateway model can be sent, least to most: those of the descriptor that
 * getModel() builds for it through AI Gateway. Empty when the model takes none.
 */
export function gatewayReasoningLevels(
    provider: AiModelProvider, modelId: string, behavesLike?: string,
    capabilities?: GatewayModelCapabilities): ReasoningLevel[] {
  // Built as for a model with a level set, which is when its levels count.
  let model = gatewayNativeModel(
      { provider, model: modelId, apiToken: "", behavesLike, capabilities, reasoning: "off" }, "");
  return model?.reasoning ? getSupportedThinkingLevels(model) : [];
}

// What a handle with no reasoning level asks `model` for on an agent's turn. makeHandle builds
// the request's options from the answer. A model that does no reasoning, which is how pi marks
// some and how an added one can be stated, is asked for nothing on any API.
// - Anthropic: adaptive thinking (the model decides when/how much to think) -- but only for
//   models pi's catalog marks adaptive-capable (compat.forceAdaptiveThinking). Other Anthropic
//   models (e.g. Haiku 4.5, which rejects the adaptive format) are asked for nothing, so pi omits
//   the `thinking` field and the provider default (no extended thinking) applies.
// - OpenAI Responses: explicit medium reasoning effort, or for a model that lacks "medium" the
//   level a set "medium" would be clamped to (see reasoningOptions), so that a model is never
//   sent an effort it does not take. pi would otherwise *disable* reasoning when no effort is
//   passed; effort selection also makes pi request encrypted reasoning content, which -- with
//   pi's unconditional `store: false` -- keeps requests stateless (ZDR) with reasoning carried
//   between tool steps.
// - Everything else: nothing, which leaves the provider's defaults.
function builtInReasoning(model: Model<Api>): BuiltInReasoning {
  if (!model.reasoning) return null;
  switch (model.api) {
    case "anthropic-messages":
      return (model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking === true
          ? "adaptive" : null;
    case "openai-responses":
      return clampThinkingLevel(model, "medium");
    default:
      return null;
  }
}

/**
 * What a gateway model is asked for on an agent's turns while its config carries no reasoning
 * level: the answer for the descriptor that getModel() builds for it through AI Gateway, which
 * is the same over either transport. Null too for a provider AI Gateway cannot serve, whose
 * models get no handle.
 */
export function gatewayBuiltInReasoning(
    provider: AiModelProvider, modelId: string, behavesLike?: string,
    capabilities?: GatewayModelCapabilities): BuiltInReasoning {
  let model = gatewayNativeModel(
      { provider, model: modelId, apiToken: "", behavesLike, capabilities }, "");
  return model ? builtInReasoning(model) : null;
}

// The per-API options that ask `model` for a reasoning level on a request whose response cap is
// `maxTokens`. This is the mapping of pi's streamSimple(), which is not called because it would
// also give every request a response cap. A level the model lacks is clamped to one it has, so
// "off" asks a model that can't stop reasoning for its lowest level. A model that does no
// reasoning has "off" alone, for which pi sends it nothing. `formatId` is the ID of the pi entry
// the model's flags come from (see gatewayCatalogModel), where there is one.
function reasoningOptions(model: Model<Api>, level: ReasoningLevel, maxTokens: number | undefined,
                          formatId = model.id): Record<string, unknown> {
  let clamped = clampThinkingLevel(model, level);
  switch (model.api) {
    case "anthropic-messages": {
      if (clamped === "off") return { thinkingEnabled: false };
      if ((model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking === true) {
        // Adaptive thinking takes an effort: the model's own name for the level, and otherwise
        // the level's, with "minimal" as Anthropic's lowest.
        let effort = model.thinkingLevelMap?.[clamped] ?? (clamped === "minimal" ? "low" : clamped);
        return { thinkingEnabled: true, effort };
      }
      // Other models take a token budget, which comes out of the response cap. The cap stays as
      // it is and the budget leaves room under it for an answer. Anthropic takes no budget below
      // 1024 tokens, so a cap with no room for one is sent no thinking.
      let budget = clampThinkingBudgetToAnswerRoom(
          thinkingBudgetForLevel(clamped), maxTokens ?? model.maxTokens);
      return budget >= 1024 ? { thinkingEnabled: true, thinkingBudgetTokens: budget } : {};
    }
    case "openai-responses":
    case "openai-completions":
      // With no effort, pi sends the model's own "off".
      return clamped === "off" ? {} : { reasoningEffort: clamped };
    case "google-generative-ai": {
      if (clamped === "off") return { thinking: { enabled: false } };
      // pi tells from a Gemini model's ID whether it takes a level or a token budget, so a model
      // that borrows another's flags is asked the way that one is.
      let google = { ...model, id: formatId } as Model<"google-generative-ai">;
      let resolved = resolveGoogleThinkingLevel(google, clamped);
      return { thinking: usesGoogleThinkingLevel(google)
          ? { enabled: true, level: toGoogleThinkingLevel(resolved) }
          : { enabled: true, budgetTokens: thinkingBudgetForLevel(resolved) } };
    }
    default:
      return {};
  }
}

// Case-insensitive response-header lookup (pi surfaces headers as a plain record).
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

type HandleArgs = {
  model: Model<Api>;
  // Provider auth: a plain API key (pi turns it into the SDK's native auth) and/or headers.
  // A null header value suppresses a default header ({Authorization: null, "x-api-key": null}
  // alongside cf-aig-authorization makes pi skip SDK auth entirely).
  apiKey?: string;
  headers?: ProviderHeaders;
  // Structured gateway attribution; sent as `cf-aig-metadata` on gateway-routed requests only
  // (pi does not forward options.metadata to that header itself).
  gatewayMetadata?: GatewayMetadata;
  sessionAffinity?: string;
  aiGatewayLogRoute?: AiGatewayLogRoute;
  // Transport override for every request on this handle: how a binding-routed model reaches the
  // gateway over env.WORKERS_AI.fetch() instead of the global fetch (see bindingFetch).
  // A per-call options.fetch still wins, which tests rely on to capture requests.
  fetch?: FetchFunction;
  // The reasoning level of main turns, and the ID of the pi entry the model's flags come from
  // (see reasoningOptions). No level gives the model its built-in request (see builtInReasoning).
  reasoning?: ReasoningLevel;
  formatId?: string;
};

function makeHandle(args: HandleArgs): ModelHandle {
  const streamFn = API_STREAMS[args.model.api];
  if (!streamFn) {
    throw new Error(`Unsupported model API "${args.model.api}".`);
  }

  // Per-API extras for a handle with no reasoning level of its own: the options that ask for
  // what builtInReasoning() says. A built-in level is an OpenAI effort, sent as it is.
  const anthropicCompat = args.model.compat as AnthropicMessagesCompat | undefined;
  const builtIn = builtInReasoning(args.model);
  const apiExtras: Record<string, unknown> =
      builtIn === "adaptive" ? { thinkingEnabled: true } :
      builtIn !== null ? { reasoningEffort: builtIn } : {};

  const handle: ModelHandle = {
    model: args.model,
    aiGatewayLogRoute: args.aiGatewayLogRoute,
    stream: (model, context, { thinking = true, ...options } = {}) => {
      // Never let a failed request read a previous request's response metadata, or leave the
      // previous request to be resent in its place.
      handle.lastResponse = undefined;
      handle.lastRequest = undefined;
      // This request's own response metadata: concurrent requests on one handle overwrite
      // `lastResponse`, but not this.
      let received: ModelHandle["lastResponse"];
      // This request as sent, and when, if prompt caching is on.
      let sent: { payload: unknown; at: number } | undefined;
      const headers: ProviderHeaders = {
        ...args.headers,
        ...options.headers,
        ...(args.gatewayMetadata
            ? { "cf-aig-metadata": JSON.stringify(args.gatewayMetadata) }
            : {}),
      };
      const transcript = normalizeContext(context);
      const merged: SimpleStreamOptions = {
        // API defaults first, so an explicit per-call option can override them. A handle with a
        // reasoning level sends that level's options in their place. `thinking: false` replaces
        // either with a quick request. Managed-effort Anthropic models must use adaptive
        // thinking, so select their lowest effort; other Anthropic models disable it (or omit
        // the unsupported off setting). For OpenAI Responses, passing no reasoningEffort disables
        // reasoning.
        ...(thinking
            ? (args.reasoning === undefined
                ? apiExtras
                : reasoningOptions(args.model, args.reasoning, options.maxTokens, args.formatId))
            : args.model.api === "anthropic-messages"
                ? (anthropicCompat?.supportsMidConvoEffort === true
                    ? { effort: "low" } : { thinkingEnabled: false })
                : {}),
        ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
        ...options,
        ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        // Session affinity: pi only sends it when caching isn't "none" (fine for us).
        sessionId: options.sessionId ?? args.sessionAffinity,
        onResponse: async (response, responseModel) => {
          received = {
            status: response.status,
            aiGatewayLogId: getHeader(response.headers, "cf-aig-log-id"),
          };
          handle.lastResponse = received;
          await options.onResponse?.(response, responseModel);
        },
        // Rewrites of the request pi built from `transcript`, each a no-op for payloads it doesn't
        // apply to: PDF attachments ride pi image parts and become the provider's native document
        // blocks (see chat-attachment-pdf.ts), Gemini function calls without a thought signature
        // get Google's stand-in (see signGeminiFunctionCalls), and with caching on, the leading
        // system prompt is split after its static text (see system-prompt-blocks.ts), and a split
        // request drops pi's per-chat prompt cache key (see withoutPromptCacheKey).
        onPayload: async (payload, payloadModel) => {
          const replaced = await options.onPayload?.(payload, payloadModel);
          const bridged = bridgePdfAttachments(args.model.api, replaced ?? payload) ?? replaced;
          const signed = signGeminiFunctionCalls(args.model, bridged ?? payload) ?? bridged;
          if (options.cacheRetention === "none") return signed;
          const split = splitSystemPrompt(args.model, transcript, signed ?? payload);
          const final = split === undefined
              ? signed
              : withoutPromptCacheKey(args.model, split) ?? split;
          sent = { payload: final ?? payload, at: Date.now() };
          return final;
        },
      };
      const stream = traceChat(model, () => received,
          () => streamFn(model, transcript, merged));
      // Kept once the response ends, which is before its caller can start another request.
      void stream.result().then(message => {
        if (sent === undefined) return;
        handle.lastRequest = cachedRequest(streamFn, model, transcript, sent, message.usage,
            args.aiGatewayLogRoute, {
          fetch: merged.fetch,
          apiKey: merged.apiKey,
          sessionId: merged.sessionId,
          cacheRetention: options.cacheRetention,
          headers: args.gatewayMetadata ? {
            ...headers,
            "cf-aig-metadata": JSON.stringify({ ...args.gatewayMetadata, source: "cache-warm" }),
            // The resend is the same every time, which a gateway that caches responses would
            // answer without asking the provider.
            "cf-aig-skip-cache": "true",
          } : headers,
        });
      });
      return stream;
    },
  };
  return handle;
}

// GPT-5.6 and later keep a separate cache for each prompt_cache_key, so the key pi sets from the
// chat's affinity stops chats from sharing the cached tools and static system prompt. Without a
// key, the cache is shared across the OpenAI organization, as Anthropic's is across a workspace.
// Only split requests are agent turns, whose project-specific block starts with the workspace's
// random salt (see runAgentPass); others, like compaction's chat history, keep the key so
// they can't be probed. Older models route by the key, so they keep it too.
function withoutPromptCacheKey(model: Model<Api>, payload: unknown): object | undefined {
  if (!hasGpt56PromptCaching(model) || typeof payload !== "object" || payload === null ||
      !("prompt_cache_key" in payload)) {
    return undefined;
  }
  const { prompt_cache_key, ...rest } = payload;
  return rest;
}

// The request a handle `sent` for `context`, which completed with `usage`, as a CachedRequest that
// resends it with `routing`: the handle's endpoint, auth and headers. Undefined where resending
// can't keep the cache (see cappedForResend), or the provider cached none of the request, as for a
// prompt below its minimum. Resending takes nothing else from the request, so a kept request holds
// only its payload, not the caller's options or transcript.
function cachedRequest(
    streamFn: StreamFunction<Api, SimpleStreamOptions>, model: Model<Api>, context: Context,
    sent: { payload: unknown; at: number }, usage: Usage,
    aiGatewayLogRoute: AiGatewayLogRoute | undefined,
    routing: SimpleStreamOptions): CachedRequest | undefined {
  const resent = cappedForResend(model, sent.payload);
  if (resent === undefined || usage.cacheRead + usage.cacheWrite === 0) return undefined;
  const { cacheRead, cacheWrite, output } = model.cost;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const own = Math.max(prompt - estimateSharedHeadTokens(context), 0);
  return {
    sentAt: sent.at,
    cacheLifetime: resent.cacheLifetime,
    // Prices are per million tokens.
    resendCost: (prompt * cacheRead + resent.responseCap * output) / 1e6,
    expiryCost: own * (cacheWrite - cacheRead) / 1e6,
    resend: async () => {
      let aiGatewayLogId: string | undefined;
      // pi builds a request from the context and then replaces it with the payload.
      const message = await streamFn(model, normalizeContext({ messages: [] }), {
        ...routing,
        onPayload: () => resent.payload,
        onResponse: response => {
          aiGatewayLogId = getHeader(response.headers, "cf-aig-log-id");
        },
      }).result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? "The model request failed.");
      }
      return { usage: message.usage, aiGatewayLogId, aiGatewayLogRoute };
    },
  };
}

// The cache lifetime of `payload`'s API, and `payload` with the smallest response cap it takes.
// Undefined where a resend isn't known to keep the cache.
// - anthropic-messages: pi's default retention keeps the conversation 5 minutes from the start
//   of the last request that read it. Anthropic's pre-warm takes max_tokens 0, but not with
//   streaming, which pi always uses, so 1 it is. An enabled thinking budget must stay below
//   max_tokens, so such requests can't be resent; adaptive thinking takes any cap.
// - openai-responses, GPT-5.6 and later: at least 30 minutes after the last write or reuse. 16
//   is the smallest max_output_tokens the API takes, and it caps reasoning tokens too.
// - Other APIs: undefined.
function cappedForResend(model: Model<Api>, payload: unknown)
    : { payload: object; responseCap: number; cacheLifetime: number } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  switch (model.api) {
    case "anthropic-messages":
      return hasEnabledThinking(payload) ? undefined : {
        payload: { ...payload, max_tokens: 1 }, responseCap: 1, cacheLifetime: 5 * 60_000,
      };
    case "openai-responses":
      return hasGpt56PromptCaching(model) ? {
        payload: { ...payload, max_output_tokens: 16 }, responseCap: 16,
        cacheLifetime: 30 * 60_000,
      } : undefined;
    default:
      return undefined;
  }
}

const hasEnabledThinking = (payload: object): boolean =>
    "thinking" in payload && typeof payload.thinking === "object" && payload.thinking !== null &&
    "type" in payload.thinking && payload.thinking.type === "enabled";

// Gemini 3 rejects a request whose current turn holds a function call without a thought signature.
// The synthetic calls history replay adds (see makeReplayObservation in agent.ts) have none, nor do
// calls another model made, so they get the value Google documents for a call the model didn't
// make. pi can't send it: it passes on only base64 signatures.
function signGeminiFunctionCalls(model: Model<Api>, payload: unknown): object | undefined {
  if (model.api !== "google-generative-ai" || typeof payload !== "object" || payload === null ||
      !("contents" in payload) || !Array.isArray(payload.contents)) {
    return undefined;
  }
  let signed = false;
  const contents = payload.contents.map((content: unknown) => {
    if (typeof content !== "object" || content === null || !("parts" in content) ||
        !Array.isArray(content.parts)) {
      return content;
    }
    return {...content, parts: content.parts.map((part: unknown) => {
      if (typeof part !== "object" || part === null || !("functionCall" in part) ||
          "thoughtSignature" in part) {
        return part;
      }
      signed = true;
      return {...part, thoughtSignature: "skip_thought_signature_validator"};
    })};
  });
  return signed ? {...payload, contents} : undefined;
}

/**
 * Resolve an AiModelConfig to a ModelHandle, choosing among three routing modes: the user's own
 * AI Gateway (BYOK unified billing), the platform's AI Gateway (free tier), or direct provider
 * access with the config's own credentials. The handle carries the matching AI Gateway log route
 * for cost accounting, when there is one.
 */
export function getModel(env: Cloudflare.Env, config: AiModelConfig,
                         initiator: AiChatAuthorInfo,
                         options: ModelRoutingOptions = {}): ModelHandle {
  // BYOK: a connected user's own Cloudflare account pays for everything (all providers, including
  // Workers AI), routed through the user's own AI Gateway with unified billing. Honored regardless
  // of whether a platform AI Gateway is configured, so connected users are always billed correctly.
  if (options.userGateway) {
    return getModelViaUserGateway(
        config, buildMetadata(initiator, options.metadata), options.userGateway,
        options.sessionAffinity);
  }

  // Otherwise: when a platform AI Gateway is configured, route through it (platform-funded free
  // tier). The config's apiToken/apiUrl/extraHeaders are ignored in that mode.
  let gwConfig = getAiGatewayConfig(env);
  if (gwConfig) {
    return getModelViaGateway(gwConfig, config, initiator, options);
  }

  return getModelDirect(config, options.sessionAffinity);
}

// Route inference through the user's own account (unified billing) via their account's default AI
// Gateway. Supports every provider AI Gateway serves, including Workers AI. Billed to the
// user's Cloudflare credits; no provider API key required.
function getModelViaUserGateway(
  config: AiModelConfig,
  metadata: GatewayMetadata,
  userGateway: UserGatewayRouting,
  sessionAffinity?: string,
): ModelHandle {
  // Route through the user's AI Gateway data plane, speaking each provider's native API (see
  // gatewayNativeModel; unified *billing* has no API requirements). Auth is the connected user's
  // Cloudflare token via `cf-aig-authorization` (authorized by its `aig.run` scope); the
  // account-level `/ai/v1` REST endpoint rejects that token. We always use the account's
  // auto-created "default" gateway.
  const model = gatewayNativeModel(
      config, `https://gateway.ai.cloudflare.com/v1/${userGateway.accountId}/default`);
  if (!model) {
    throw new Error(`Provider "${config.provider}" is not supported via unified billing.`);
  }
  return makeHandle({
    model,
    // The Google SDK requires an API key and sends it as `x-goog-api-key`, which the gateway
    // forwards verbatim unless it recognizes the token as gateway auth -- same stored-key flow
    // as the platform path (see getModelViaGateway).
    ...(config.provider === "google" ? { apiKey: userGateway.apiKey } : {}),
    headers: {
      "cf-aig-authorization": `Bearer ${userGateway.apiKey}`,
      Authorization: null,
      "x-api-key": null,
    },
    gatewayMetadata: metadata,
    sessionAffinity,
    reasoning: config.reasoning,
    formatId: gatewayCatalogModel(config)?.id,
    aiGatewayLogRoute: {
      gateway: "default",
      accountId: userGateway.accountId,
      apiToken: userGateway.apiKey,
    },
  });
}

/**
 * Placeholder auth value for binding-routed requests. pi's API impls require an API key or a
 * recognized auth header (authorization, x-api-key, cf-aig-authorization) before dispatch;
 * binding calls are pre-authenticated in-account, so this satisfies the check and the gateway
 * recognizes and strips it rather than treating it as a BYOK provider key.
 */
const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

/**
 * `Ai#fetch` exists at runtime but @cloudflare/workers-types' `Ai` doesn't declare it, so the
 * binding is cast structurally to reach the passthrough.
 */
type AiFetchBinding = {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
};

// pi drives the model's baseUrl, which already names the gateway route on the binding's host,
// so the binding's fetch passes through unchanged -- no URL rewriting needed.
function bindingFetch(binding: Ai): FetchFunction {
  return (input, init) => (binding as unknown as AiFetchBinding).fetch(input, init);
}

// Platform free-tier path: route through the deployment's configured AI Gateway (platform-funded).
// Used only for requests that are NOT billed to a connected user's account.
function getModelViaGateway(
  gwConfig: AiGatewayConfig,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  options: ModelRoutingOptions,
): ModelHandle {
  const metadata = buildMetadata(initiator, options.metadata);
  const binding = gwConfig.bindingFor(config.provider);
  // No binding means either the provider can't ride one or the deployment has none; the second
  // case already required a token in the constructor, so this only fires for the first
  if (!binding && !gwConfig.apiToken) {
    throw new Error(`Provider "${config.provider}" cannot use the Workers AI binding transport, ` +
        "and no CF_AI_GATEWAY_API_TOKEN is configured for the HTTPS one.");
  }
  const gatewayAuthHeaders: ProviderHeaders = {
    // pi's API impls explicitly recognize cf-aig-authorization and skip SDK auth; the null
    // values suppress the SDKs' own auth headers so the gateway's server-managed provider keys
    // apply.
    "cf-aig-authorization":
        `Bearer ${binding ? CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL : gwConfig.apiToken}`,
    Authorization: null,
    "x-api-key": null,
  };
  const gatewayBase =
      `https://gateway.ai.cloudflare.com/v1/${gwConfig.accountId}`;
  // Cost-log reads are same-account, so the binding arm applies whenever the binding transport
  // is active (gwConfig.binding is unset when CF_AI_GATEWAY_USE_BINDING=false opts out) --
  // even for Google inference, which itself rides HTTPS (see AiGatewayConfig.bindingFor).
  const logRoute = (gateway: string): AiGatewayLogRoute => gwConfig.binding
      ? { gateway }
      : { gateway, accountId: gwConfig.accountId, apiToken: gwConfig.apiToken! };

  // Every provider -- Workers AI included -- rides the same gateway, with the same log route
  // and attribution metadata. Binding-routed providers address it on the binding's host, which
  // takes no account id (the binding channel carries identity); the paths are otherwise the
  // same, so the model descriptors are built identically from either root.
  const gateway = gwConfig.gateway;
  const gatewayUrl = binding
      ? `https://workers-binding.ai/ai-gateway/gateways/${gateway}`
      : `${gatewayBase}/${gateway}`;
  const model = gatewayNativeModel(config, gatewayUrl);
  if (!model) {
    throw new Error(`Provider "${config.provider}" is not supported through AI Gateway.`);
  }

  return makeHandle({
    model,
    // The google API impl requires an apiKey (it doesn't recognize header-owned auth), and the
    // @google/genai SDK sends it as `x-goog-api-key` on every request -- which AI Gateway treats
    // as a provider key and forwards to Google verbatim, bypassing the gateway's server-managed
    // keys (credential precedence gives a request-supplied provider key top priority). The
    // documented stored-key flow for this SDK is to pass the *gateway token* as the SDK API key:
    // the gateway recognizes its own token there and applies the stored Google key instead.
    ...(config.provider === "google" ? { apiKey: gwConfig.apiToken } : {}),
    headers: gatewayAuthHeaders,
    ...(binding ? { fetch: bindingFetch(binding) } : {}),
    gatewayMetadata: metadata,
    sessionAffinity: options.sessionAffinity,
    reasoning: config.reasoning,
    formatId: gatewayCatalogModel(config)?.id,
    aiGatewayLogRoute: logRoute(gateway),
  });
}

// Auth for a direct connection whose client can omit the API key, which `keyHeader` carries. A
// blank token sends no key at all: local Ollama needs none, and a proxy may authenticate through
// the config's extraHeaders instead (AI Gateway only injects its stored provider key into requests
// that don't already carry one). The SDKs insist on *some* key, so they get a placeholder, while a
// null default header deletes the header they derive from it; extra headers still override.
function directAuth(config: AiModelConfig, keyHeader: string): Pick<HandleArgs, "apiKey" | "headers"> {
  return config.apiToken === ""
      ? { apiKey: "unused", headers: { [keyHeader]: null, ...config.extraHeaders } }
      : { apiKey: config.apiToken, headers: config.extraHeaders };
}

// Direct provider access using the credentials in the model config itself (no AI Gateway).
function getModelDirect(config: AiModelConfig, sessionAffinity?: string): ModelHandle {
  const catalog = catalogModel(config.provider, config.model);
  const window = modelTokenWindow(config, catalog);
  switch (config.provider) {
    case "anthropic":
      return makeHandle({
        model: {
          id: config.model,
          name: catalog?.name ?? config.model,
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: config.apiUrl ?? "https://api.anthropic.com",
          reasoning: true,
          input: catalog?.input ?? ["text", "image"],
          cost: catalog?.cost ?? ZERO_COST,
          ...window,
          thinkingLevelMap: catalog?.thinkingLevelMap,
          // Catalog compat verbatim -- see the gateway-path comment on forceAdaptiveThinking.
          compat: catalog?.compat,
        },
        ...directAuth(config, "x-api-key"),
        sessionAffinity,
      });
    case "cloudflare": {
      // Workers AI is fetch-only (no Workers-binding transport), so outside AI Gateway mode it's
      // BYOK like every other provider: the user's own account ID and API token come from the
      // model config. (The REST endpoint is account-scoped, hence the extra accountId field.)
      return makeHandle({
        model: {
          id: config.model,
          name: catalog?.name ?? config.model,
          api: "openai-completions",
          provider: "cloudflare-workers-ai",
          baseUrl: `${workersAiAccountUrl(config)}/v1`,
          reasoning: catalog?.reasoning ?? false,
          input: catalog?.input ?? ["text"],
          cost: catalog?.cost ?? ZERO_COST,
          ...window,
          compat: workersAiCompat(catalog),
        },
        apiKey: config.apiToken,
        headers: config.extraHeaders,
        sessionAffinity,
      });
    }
    case "google":
      return makeHandle({
        model: {
          id: config.model,
          name: catalog?.name ?? config.model,
          api: "google-generative-ai",
          provider: "google",
          baseUrl: config.apiUrl ?? "https://generativelanguage.googleapis.com/v1beta",
          reasoning: catalog?.reasoning ?? true,
          input: catalog?.input ?? ["text", "image"],
          cost: catalog?.cost ?? ZERO_COST,
          ...window,
          thinkingLevelMap: catalog?.thinkingLevelMap,
        },
        // Not directAuth: pi's Google API requires a key, and @google/genai adds `x-goog-api-key`
        // with no way to suppress it (an extra header of that name replaces it, though).
        apiKey: config.apiToken,
        headers: config.extraHeaders,
        sessionAffinity,
      });
    case "ollama":
      // `apiUrl` is the Ollama server base; its OpenAI-compat endpoint lives under /v1. Accept
      // (and strip) a trailing `/api` or `/v1` path: configs saved before the pi migration store
      // the native-API base `http://host:11434/api` (the old ollama provider's convention), and
      // users may paste the /v1 endpoint directly. When no API key was configured we assume
      // local auth and send no Authorization header at all (as before the pi migration; a strict
      // local proxy may reject an unexpected bearer token).
      return makeHandle({
        model: {
          id: config.model,
          name: config.model,
          api: "openai-completions",
          provider: "ollama",
          baseUrl: `${stripTrailingSlashes(config.apiUrl ?? "http://localhost:11434")
              .replace(/\/(api|v1)$/, "")}/v1`,
          reasoning: true,
          input: ["text", "image"],
          cost: ZERO_COST,

          // Pi's OpenAI compat uses the "developer" role for the system prompt by default,
          // disabling it only for certain hostnames which are known not to support it.
          //
          // In ollama, some models support it and some do not. Frustratingly, the ones that do not
          // don't necessarily throw an error. They may just proceed without a system prompt. For
          // example, when I tested Muse Glimmer the day after it was released, I found it
          // understood what tool calls were available to it but didn't know any of the info in
          // the system prompt. Annoyingly, Muse Glimmer seems to be trained to treat the system
          // prompt as secret, so refused to answer my questions about it directly. But I figured
          // out it clearly wasn't getting the system prompt. And when I disabled  the "developer"
          // role, the problem was fixed. In contrast, though, Gemma 4 running under otherwise
          // exactly the same setup does understand the "developer" role and works fine. Weird!
          //
          // Some users also filed issues about this because they were trying to use the ollama
          // provider as a way to target an arbitrary third-party OpenAI-compatible provider. This
          // is not the intended use case for the ollama provider -- we should add an explicit
          // provider for this. The ollama provider could in the future switch to using the ollama
          // native API rather than the OpenAI-compatible endpoint, which would break users using
          // it in this way. That said, if this flag works as a temporary work-around for them
          // util we add a real OpenAI provider option... great.
          compat: catalog?.compat ?? {supportsDeveloperRole: false},

          ...window,
        },
        ...directAuth(config, "Authorization"),
        sessionAffinity,
      });
    case "openai":
      return makeHandle({
        model: {
          id: config.model,
          name: catalog?.name ?? config.model,
          api: "openai-responses",
          provider: "openai",
          baseUrl: config.apiUrl ?? "https://api.openai.com/v1",
          reasoning: catalog?.reasoning ?? true,
          input: catalog?.input ?? ["text", "image"],
          cost: catalog?.cost ?? ZERO_COST,
          ...window,
          thinkingLevelMap: catalog?.thinkingLevelMap,
          compat: catalog?.compat,
        },
        ...directAuth(config, "Authorization"),
        sessionAffinity,
      });
    default:
      config.provider satisfies never;
      throw new Error(`Unknown provider "${config.provider}".`);
  }
}

// Workers AI's account-scoped REST root for a direct connection, which needs the config's own
// Cloudflare credentials.
function workersAiAccountUrl(config: AiModelConfig): string {
  if (!config.accountId || !config.apiToken) {
    throw new Error(
        "This Workers AI model has no Cloudflare credentials. Re-add it with your " +
        "Cloudflare account ID and an API token that permits Workers AI.");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai`;
}

/** Runs one resolved decision model; see getDecisionModel(). */
type DecisionModel = (context: ClassifierContext) => Promise<ClassifierResult>;

/**
 * Resolve a decision model config (see modelKind()) to a DecisionModel. It routes through the
 * platform's AI Gateway when one is configured, as getModel() routes language models, and
 * otherwise goes directly to Workers AI with the config's own Cloudflare credentials.
 */
export function getDecisionModel(env: Cloudflare.Env, config: AiModelConfig,
                                 initiator: AiChatAuthorInfo,
                                 metadataContext?: GatewayMetadataContext): DecisionModel {
  // pi's catalog entry supplies the API, cost and window; only the address varies by route.
  const catalog = (CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS as
      Record<string, ClassifierModel<ClassifierApi>>)[config.model];
  const modelAt = (baseUrl: string, options: ClassifierOptions): DecisionModel =>
      context => workersAiClassify({ ...catalog, baseUrl }, context, options);
  const gwConfig = getAiGatewayConfig(env);
  if (!gwConfig) {
    return modelAt(workersAiAccountUrl(config),
        { apiKey: config.apiToken, headers: config.extraHeaders });
  }
  const metadata = buildMetadata(initiator, metadataContext);
  // pi's System One transport POSTs {model, input} as Workers AI's REST API takes them and reads
  // back the REST envelope; both gateway routes take the bare input and return the bare result.
  // pi requires a key, which goes unsent.
  const piInput = async (init?: RequestInit) =>
      (await new Response(init?.body).json<{ input: Record<string, unknown> }>()).input;
  const binding = gwConfig.bindingFor(config.provider);
  if (binding) {
    // The gateway's passthrough refuses /run even with the binding's identity, so binding
    // requests take the binding's own run(), which reaches the same gateway.
    return modelAt(catalog.baseUrl, {
      apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
      fetch: async (_url, init) => Response.json({ success: true, result: await binding.run(
          config.model, await piInput(init), { gateway: { id: gwConfig.gateway, metadata } }) }),
    });
  }
  // Over HTTPS the gateway supplies Workers AI's credential only to a request that names the model
  // in the path and carries no `Authorization`, which it would otherwise forward to Workers AI as
  // the credential. A failure goes back to pi as is, for its retries and error message.
  const gatewayUrl =
      `https://gateway.ai.cloudflare.com/v1/${gwConfig.accountId}/${gwConfig.gateway}`;
  return modelAt(catalog.baseUrl, {
    apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
    fetch: async (_url, init) => {
      const response = await fetch(`${gatewayUrl}/workers-ai/run/${config.model}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-aig-authorization": `Bearer ${gwConfig.apiToken}`,
          "cf-aig-metadata": JSON.stringify(metadata),
        },
        body: JSON.stringify(await piInput(init)),
        signal: init?.signal,
      });
      return response.ok
          ? Response.json({ success: true, result: await response.json() })
          : response;
    },
  });
}

// =======================================================================================

export type AiModelGatekeeperProps = {
  displayName: string,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  metadata?: GatewayMetadataContext,
};

/**
 * Throws if the deployment no longer lets a model binding run its model. A session starts on each
 * call of the binding, so a binding minted before an admin disabled its gateway model stops working
 * at its next call. While users may not add their own models, so does a binding for any other
 * model: one a user added, or one the admin added and removed.
 */
async function refuseRevokedModel(env: Cloudflare.Env, props: AiModelGatekeeperProps) {
  let models = await getGatewayModels(env);
  if (models?.get(props.config.model)?.provider === props.config.provider) {
    models.refuseDisabled(props.config.model);
  } else {
    models?.refuseUserModel(props.displayName);
  }
}

export class LanguageModelGatekeeper
    extends DurableObject<Cloudflare.Env, AiModelGatekeeperProps>
    implements Gatekeeper<LanguageModelBinding> {
  async describe(): Promise<ResourceDescription> {
    let modelConfig = this.ctx.props.config;
    let displayName = this.ctx.props.displayName;

    return {
      // TODO: Decide if we need real URLs or if `url` should stop being part of the description.
      url: `http://models.local/${modelConfig.provider}/${modelConfig.model}`,

      title: displayName,
      snippet: "An AI large language model.",

      suggestedBindingName: "LLM",

      tsType: "LanguageModelBinding",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return AI_MODEL_BINDING_TYPES;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<LanguageModelBinding> {
    // A binding makes one-shot calls, which ask for no reasoning level. Without the level it was
    // minted with, its model is described as one with none set, whatever the admin has set since.
    let { reasoning, ...config } = this.ctx.props.config;
    await refuseRevokedModel(this.env, this.ctx.props);
    let model = getModel(this.env, config, this.ctx.props.initiator, {
      metadata: this.ctx.props.metadata,
    });
    return new LanguageModelBindingImpl(model);
  }

  applyAction(action: number): Promise<void> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: number): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // An AI model is not a restricted-access resource: nothing read through it identifies the
    // observer or leaks private data, so any observer is permitted. No-op (never throws).
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked (see addObserver). Idempotent no-op.
  }
}

@validateRpc()
class LanguageModelBindingImpl extends RpcTarget implements LanguageModelBinding {
  constructor(private model: ModelHandle) {
    super();
  }

  async run(options: {prompt: string, systemPrompt?: string}): Promise<string> {
    // TODO: Should we be calling authorizeObservation() here? It's not really observing anything,
    //   but you might want the audit logs?
    // TODO: Account LLM costs back to the calling gadget.
    // A gadget may call its binding many times with the same system prompt.
    return await completeText(this.model, {
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      cache: true,
    });
  }
}

export class DecisionModelGatekeeper
    extends DurableObject<Cloudflare.Env, AiModelGatekeeperProps>
    implements Gatekeeper<DecisionModelBinding> {
  async describe(): Promise<ResourceDescription> {
    let modelConfig = this.ctx.props.config;
    return {
      url: `http://models.local/${modelConfig.provider}/${modelConfig.model}`,
      title: this.ctx.props.displayName,
      snippet: "An AI decision model.",
      suggestedBindingName: "DECISION_MODEL",
      tsType: "DecisionModelBinding",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return DECISION_MODEL_BINDING_TYPES;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<DecisionModelBinding> {
    let { config, initiator, metadata } = this.ctx.props;
    await refuseRevokedModel(this.env, this.ctx.props);
    return new DecisionModelBindingImpl(getDecisionModel(this.env, config, initiator, metadata));
  }

  applyAction(action: number): Promise<void> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: number): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // Like an LLM, a decision model is not a restricted-access resource (see
    // LanguageModelGatekeeper).
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked (see addObserver). Idempotent no-op.
  }
}

@validateRpc()
class DecisionModelBindingImpl extends RpcTarget implements DecisionModelBinding {
  constructor(private model: DecisionModel) {
    super();
  }

  async decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>> {
    let result = await this.model(request);
    // pi reports a failure in the result; gadget code expects a rejection, as completeText()
    // gives the LLM binding.
    if (result.stopReason !== "stop") throw new Error(result.errorMessage);
    return result.answers;
  }
}
