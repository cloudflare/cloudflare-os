import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import { validateRpc } from "capnweb-validate";
import type {
  AnthropicMessagesCompat, Api, AssistantMessageEventStream, Context, FetchFunction, Model,
  ModelCost, OpenAICompletionsCompat, ProviderHeaders, SimpleStreamOptions, StreamFunction,
} from "@earendil-works/pi-ai";
import { stream as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as googleGenerativeAiStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as openaiCodexResponsesStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openaiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { ApprovalQueue, Gatekeeper, ResourceDescription, stripTrailingSlashes } from '@gadgets/workshop-shared/gatekeeper';
import { LanguageModelBinding } from "./ai-model-binding";
import AI_MODEL_BINDING_TYPES from "./ai-model-binding.txt";
import { AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS, WORKERS_AI_OUTPUT_LIMIT }
  from "@gadgets/workshop-shared/api";
import { AiGatewayConfig, getAiGatewayConfig, type AiGatewayLogRoute } from "./ai-gateway.js";
import { completeText } from "./ai-invoke.js";
import { bridgePdfAttachments } from "./chat-attachment-pdf.js";
import {
  isTeamPiCodexConfig,
  isTeamPiCodexMarkerConfig,
} from "./team-pi-codex-models.js";

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
  source: "chat" | "thread-title" | "gadget-title" | "model-binding";
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

  /** True only for the deployment-provided Team PI Codex route. */
  teamPiCodex?: true;
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
  "openai-codex-responses": openaiCodexResponsesStream as StreamFunction<Api, SimpleStreamOptions>,
  "openai-responses": openaiResponsesStream as StreamFunction<Api, SimpleStreamOptions>,
  "openai-completions": openaiCompletionsStream as StreamFunction<Api, SimpleStreamOptions>,
  "google-generative-ai": googleGenerativeAiStream as StreamFunction<Api, SimpleStreamOptions>,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const TEAM_PI_CODEX_AUDIENCE = "team-pi-codex";
const TEAM_PI_CODEX_KEY_ID = "odie-v1";
const TEAM_PI_CODEX_USER_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@totango\.com$/;
const TEAM_PI_CODEX_MAX_ENCODED_BODY_BYTES = 4 * 1024 * 1024;
const TEAM_PI_CODEX_MAX_DECODED_BODY_BYTES = 8 * 1024 * 1024;
const TEAM_PI_CODEX_STREAM_IDLE_TIMEOUT_MS = 120_000;
const TEAM_PI_CODEX_REQUEST_BUDGET_MS = 300_000;
const SYNTHETIC_CODEX_API_KEY =
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." +
    "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib2RpZS10ZWFtLXBpLWNvZGV4In19." +
    "synthetic";

// Consult pi's builtin catalog for cost/compat metadata of a known model id. Unknown models are
// fine (synthesized with zero cost). Import per-provider, not providers/all.
function catalogModel(provider: AiModelConfig["provider"], modelId: string): Model<Api> | undefined {
  switch (provider) {
    case "anthropic": return (ANTHROPIC_MODELS as Record<string, Model<Api>>)[modelId];
    case "openai": return (OPENAI_MODELS as Record<string, Model<Api>>)[modelId];
    case "google": return (GOOGLE_MODELS as Record<string, Model<Api>>)[modelId];
    case "cloudflare": return (CLOUDFLARE_WORKERS_AI_MODELS as Record<string, Model<Api>>)[modelId];
    case "ollama": return undefined;
    default: return undefined;
  }
}

function catalogCodexModel(modelId: string): Model<Api> | undefined {
  return (OPENAI_CODEX_MODELS as Record<string, Model<Api>>)[modelId];
}

// Token limits for a synthesized model. SUGGESTED_MODELS remains authoritative (compaction
// budgets in agent-compaction.ts are computed from it and must not change); pi's catalog fills
// gaps for models we don't list, and unknown models get conservative defaults.
function modelTokenWindow(config: AiModelConfig, catalog: Model<Api> | undefined)
    : { contextWindow: number, maxTokens: number } {
  const suggested = SUGGESTED_MODELS[config.provider]?.[config.model];
  return {
    contextWindow: config.contextWindow ?? suggested?.contextWindow ?? catalog?.contextWindow ?? 128_000,
    maxTokens: config.outputLimit ?? suggested?.outputLimit ??
        (config.provider === "cloudflare" ? WORKERS_AI_OUTPUT_LIMIT : undefined) ??
        catalog?.maxTokens ?? 4096,
  };
}

// Compat flags for a Workers AI model reached over its OpenAI-compatible endpoint (direct REST
// or the gateway's workers-ai route). Matches pi's own generated Workers AI catalog entries.
function workersAiCompat(catalog: Model<Api> | undefined): OpenAICompletionsCompat {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    ...(catalog?.compat as OpenAICompletionsCompat | undefined),
    sendSessionAffinityHeaders: true,
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
  const catalog = catalogModel(config.provider, config.model);
  const suggested = SUGGESTED_MODELS[config.provider]?.[config.model];
  const window = modelTokenWindow(config, catalog);
  switch (config.provider) {
    case "anthropic":
      return {
        id: config.model,
        name: catalog?.name ?? config.model,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: `${gatewayUrl}/anthropic`,
        reasoning: true,
        input: catalog?.input ?? ["text", "image"],
        cost: catalog?.cost ?? ZERO_COST,
        ...window,
        thinkingLevelMap: catalog?.thinkingLevelMap,
        // Catalog compat verbatim: pi's catalog marks exactly the models that require the
        // adaptive thinking format (forceAdaptiveThinking); forcing it here breaks models that
        // don't support it (Haiku). Uncataloged model ids get budget-format thinking config --
        // if a new adaptive-only model isn't yet in pi's catalog, bump pi.
        compat: catalog?.compat,
      };
    case "openai":
      return {
        id: config.model,
        name: suggested?.name ?? catalog?.name ?? config.model,
        api: "openai-responses",
        provider: "openai",
        baseUrl: `${gatewayUrl}/openai`,
        reasoning: catalog?.reasoning ?? true,
        input: catalog?.input ?? ["text", "image"],
        cost: suggested?.cost ?? catalog?.cost ?? ZERO_COST,
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
        compat: workersAiCompat(catalog),
      };
    default:
      return undefined;
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
  teamPiCodex?: true;
  // Transport override for every request on this handle: how a binding-routed model reaches the
  // gateway over env.WORKERS_AI.fetch() instead of the global fetch (see bindingFetch).
  // A per-call options.fetch still wins, which tests rely on to capture requests.
  fetch?: FetchFunction;
  // Transport factory for routes that need to wrap the per-call fetch override (Team PI Codex signs
  // the normalized request, then sends it to either the caller's fetch override or global fetch).
  fetchFactory?: (downstream?: FetchFunction) => FetchFunction;
};

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
  errorMessage: string,
  signal: AbortSignal,
)
    : Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel().catch(() => {});
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    const { done, value } = result;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(errorMessage);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Build the package-internal signed transport used for Team PI Codex requests. */
export function makeTeamPiCodexFetch(
  initiator: AiChatAuthorInfo,
  hmacSecret: string,
  downstream?: FetchFunction,
  timeouts: { streamIdleMs?: number; requestBudgetMs?: number } = {},
): FetchFunction {
  const user = initiator.id.toLowerCase();
  if (!TEAM_PI_CODEX_USER_RE.test(user)) {
    throw new Error("Team PI Codex models require a @totango.com user email initiator.");
  }
  const innerFetch = downstream ?? globalThis.fetch;
  const clientRequestId = crypto.randomUUID();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const streamIdleMs = timeouts.streamIdleMs ?? TEAM_PI_CODEX_STREAM_IDLE_TIMEOUT_MS;
    const requestBudgetMs = timeouts.requestBudgetMs ?? TEAM_PI_CODEX_REQUEST_BUDGET_MS;
    const networkController = new AbortController();
    const bodyBudgetController = new AbortController();
    let timeoutError: Error | undefined;
    let abortRequest = (reason: unknown) => networkController.abort(reason);
    const onCallerAbort = () => {
      bodyBudgetController.abort(request.signal.reason);
      abortRequest(request.signal.reason);
    };
    request.signal.addEventListener("abort", onCallerAbort, { once: true });
    const requestTimer = setTimeout(() => {
      timeoutError = new Error(
          `Team PI Codex request timed out after ${requestBudgetMs / 1000} seconds.`);
      bodyBudgetController.abort(timeoutError);
      abortRequest(timeoutError);
    }, requestBudgetMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdleTimer = () => {
      if (idleTimer === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const cleanup = () => {
      clearTimeout(requestTimer);
      clearIdleTimer();
      request.signal.removeEventListener("abort", onCallerAbort);
    };

    try {
      if (request.method !== "POST") throw new Error("Team PI Codex only supports POST requests.");
      const contentEncoding = request.headers.get("Content-Encoding")?.trim().toLowerCase();
      if (contentEncoding && contentEncoding !== "identity" && contentEncoding !== "zstd") {
        throw new Error(`Unsupported Team PI Codex request encoding: ${contentEncoding}`);
      }
      const maxInputBytes = contentEncoding === "zstd"
          ? TEAM_PI_CODEX_MAX_ENCODED_BODY_BYTES
          : TEAM_PI_CODEX_MAX_DECODED_BODY_BYTES;
      const contentLength = request.headers.get("Content-Length");
      if (contentLength !== null && Number(contentLength) > maxInputBytes) {
        throw new Error(contentEncoding === "zstd"
            ? "Team PI Codex compressed request body exceeds the 4 MiB limit."
            : "Team PI Codex request body exceeds the 8 MiB decoded limit.");
      }
      let bodyBytes = await readBoundedBody(
          request, maxInputBytes,
          contentEncoding === "zstd"
            ? "Team PI Codex compressed request body exceeds the 4 MiB limit."
            : "Team PI Codex request body exceeds the 8 MiB decoded limit.",
          bodyBudgetController.signal);
      networkController.signal.throwIfAborted();
      if (contentEncoding === "zstd") {
        if (bodyBytes.byteLength > TEAM_PI_CODEX_MAX_ENCODED_BODY_BYTES) {
          throw new Error("Team PI Codex compressed request body exceeds the 4 MiB limit.");
        }
        try {
          bodyBytes = Uint8Array.from(zstdDecompressSync(bodyBytes, {
            maxOutputLength: TEAM_PI_CODEX_MAX_DECODED_BODY_BYTES,
          }));
        } catch (error) {
          throw new Error("Team PI Codex request body is invalid or exceeds the 8 MiB decoded limit.", {
            cause: error,
          });
        }
      }
      if (bodyBytes.byteLength > TEAM_PI_CODEX_MAX_DECODED_BODY_BYTES) {
        throw new Error("Team PI Codex request body exceeds the 8 MiB decoded limit.");
      }
      const timestamp = Date.now().toString();
      const bodySha256 = await sha256Hex(bodyBytes);
      networkController.signal.throwIfAborted();
      const sessionId = request.headers.get("session-id") ?? "";
      const canonical = [
        TEAM_PI_CODEX_KEY_ID,
        TEAM_PI_CODEX_AUDIENCE,
        "POST",
        "/api/odie/codex/responses",
        timestamp,
        user,
        sessionId,
        clientRequestId,
        bodySha256,
      ].join("\n");
      const headers = new Headers();
      for (const name of ["Content-Type", "Accept", "OpenAI-Beta", "Originator", "session-id"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set("Content-Encoding", "identity");
      headers.set("x-client-request-id", clientRequestId);
      headers.set("x-team-pi-odie-key-id", TEAM_PI_CODEX_KEY_ID);
      headers.set("x-team-pi-odie-audience", TEAM_PI_CODEX_AUDIENCE);
      headers.set("x-team-pi-odie-timestamp", timestamp);
      headers.set("x-team-pi-odie-user", user);
      headers.set("x-team-pi-odie-signature", `v1=${await hmacSha256Base64Url(hmacSecret, canonical)}`);
      networkController.signal.throwIfAborted();
      const response = await innerFetch(new Request(request.url, {
        method: "POST",
        headers,
        body: bodyBytes,
        signal: networkController.signal,
      }));
      if (!response.body) {
        cleanup();
        return response;
      }

      const reader = response.body.getReader();
      let settled = false;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const finish = () => {
        if (settled) return false;
        settled = true;
        cleanup();
        return true;
      };
      const fail = (error: unknown) => {
        if (!finish()) return;
        networkController.abort(error);
        void reader.cancel().catch(() => {});
        streamController?.error(error);
      };
      const resetIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          timeoutError = new Error(
              `Team PI Codex stream stopped responding for ${streamIdleMs / 1000} seconds.`);
          fail(timeoutError);
        }, streamIdleMs);
      };
      abortRequest = fail;

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        async pull(controller) {
          try {
            resetIdleTimer();
            const result = await reader.read();
            clearIdleTimer();
            if (settled) return;
            if (result.done) {
              finish();
              controller.close();
              return;
            }
            controller.enqueue(result.value);
          } catch (error) {
            if (finish()) controller.error(timeoutError ?? error);
          }
        },
        async cancel(reason) {
          if (!finish()) return;
          networkController.abort(reason);
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      throw timeoutError ?? error;
    }
  }) as FetchFunction;
}

function makeHandle(args: HandleArgs): ModelHandle {
  const streamFn = API_STREAMS[args.model.api];
  if (!streamFn) {
    throw new Error(`Unsupported model API "${args.model.api}".`);
  }

  // Per-API extras:
  // - Anthropic: adaptive thinking (the model decides when/how much to think)` -- but only for
  //   models pi's catalog marks adaptive-capable (compat.forceAdaptiveThinking). For other
  //   Anthropic models (e.g. Haiku 4.5, which rejects the adaptive format) we pass nothing, so pi
  //   omits the `thinking` field and the provider default (no extended thinking) applies --
  //   matching the pre-pi quick-model behavior.
  // - OpenAI Responses: explicit medium reasoning effort. pi would otherwise *disable* reasoning
  //   when no effort is passed; effort selection also makes pi request encrypted reasoning
  //   content, which -- with pi's unconditional `store: false` -- preserves the old stateless
  //   ZDR behavior with reasoning carried between tool steps.
  // - Everything else: provider defaults.
  const anthropicCompat = args.model.compat as AnthropicMessagesCompat | undefined;
  const apiExtras: Record<string, unknown> =
      args.model.api === "anthropic-messages"
          ? (anthropicCompat?.forceAdaptiveThinking === true ? { thinkingEnabled: true } : {}) :
      args.model.api === "openai-codex-responses" ? { reasoningEffort: "medium", transport: "sse" } :
      args.model.api === "openai-responses" ? { reasoningEffort: "medium" } : {};

  const handle: ModelHandle = {
    model: args.model,
    aiGatewayLogRoute: args.aiGatewayLogRoute,
    teamPiCodex: args.teamPiCodex,
    stream: (model, context, { thinking = true, ...options } = {}) => {
      // Never let a failed request read a previous request's response metadata.
      handle.lastResponse = undefined;
      const headers: ProviderHeaders = {
        ...args.headers,
        ...options.headers,
        ...(args.gatewayMetadata
            ? { "cf-aig-metadata": JSON.stringify(args.gatewayMetadata) }
            : {}),
      };
      const fetch = args.fetchFactory?.(options.fetch);
      const merged: SimpleStreamOptions = {
        // API defaults first, so an explicit per-call option can override them. `thinking: false`
        // replaces them with an explicit thinking-off request: for Anthropic pi sends
        // `thinking: {type:"disabled"}` (and knows to omit it for models that can't turn thinking
        // off, e.g. claude-fable-5); for OpenAI Responses, passing no reasoningEffort makes pi
        // disable reasoning.
        ...(thinking
            ? apiExtras
            : args.model.api === "anthropic-messages" ? { thinkingEnabled: false } : {}),
        ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
        ...options,
        ...(args.model.api === "openai-codex-responses" ? { transport: "sse" } : {}),
        ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(fetch ? { fetch } : {}),
        // Session affinity: pi only sends it when caching isn't "none" (fine for us).
        sessionId: options.sessionId ?? args.sessionAffinity,
        onResponse: async (response, responseModel) => {
          handle.lastResponse = {
            status: response.status,
            aiGatewayLogId: getHeader(response.headers, "cf-aig-log-id"),
          };
          await options.onResponse?.(response, responseModel);
        },
        // PDF attachments ride pi image parts and are rewritten here into the provider's native
        // document blocks (no-op for payloads without one; see chat-attachment-pdf.ts).
        onPayload: async (payload, payloadModel) => {
          const replaced = await options.onPayload?.(payload, payloadModel);
          return bridgePdfAttachments(args.model.api, replaced ?? payload) ?? replaced;
        },
      };
      return streamFn(model, context, merged);
    },
  };
  return handle;
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
  if (isTeamPiCodexMarkerConfig(config)) {
    if (!isTeamPiCodexConfig(env, config)) {
      throw new Error("Team PI Codex model is not available.");
    }
    return getModelViaTeamPiCodex(env, config, initiator, options.sessionAffinity);
  }

  // BYOK: a connected user's own Cloudflare account pays for everything (all providers, including
  // Workers AI), routed through the user's own AI Gateway with unified billing. Honored regardless
  // of whether a platform AI Gateway is configured, so connected users are always billed correctly.
  if (options.userGateway) {
    return getModelViaUserGateway(
        config, buildMetadata(initiator, options.metadata), options.userGateway,
        options.sessionAffinity);
  }

  // Otherwise: when a platform AI Gateway is configured, route through it (platform-funded free
  // tier). The config's apiToken/apiUrl are ignored in that mode.
  let gwConfig = getAiGatewayConfig(env);
  if (gwConfig) {
    return getModelViaGateway(gwConfig, config, initiator, options);
  }

  return getModelDirect(config, options.sessionAffinity);
}

function getModelViaTeamPiCodex(
  env: Cloudflare.Env,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  sessionAffinity?: string,
): ModelHandle {
  const catalog = catalogCodexModel(config.model);
  const suggested = SUGGESTED_MODELS.openai[config.model];
  const window = modelTokenWindow(config, catalog);
  return makeHandle({
    model: {
      id: config.model,
      name: suggested?.name ?? catalog?.name ?? config.model,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: env.TEAM_PI_CODEX_BASE_URL!,
      reasoning: catalog?.reasoning ?? true,
      input: catalog?.input ?? ["text", "image"],
      cost: suggested?.cost ?? catalog?.cost ?? ZERO_COST,
      ...window,
      thinkingLevelMap: catalog?.thinkingLevelMap,
      compat: catalog?.compat,
    },
    apiKey: SYNTHETIC_CODEX_API_KEY,
    teamPiCodex: true,
    fetchFactory: downstream => makeTeamPiCodexFetch(
        initiator, env.TEAM_PI_CODEX_HMAC_SECRET!, downstream),
    sessionAffinity,
  });
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
    throw new Error(
      `Provider "${config.provider}" is not supported through AI Gateway. ` +
      `Configured providers: ${[...gwConfig.providers].join(", ")}`
    );
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
    aiGatewayLogRoute: logRoute(gateway),
  });
}

// Direct provider access using the credentials in the model config itself (no AI Gateway).
function getModelDirect(config: AiModelConfig, sessionAffinity?: string): ModelHandle {
  const catalog = catalogModel(config.provider, config.model);
  const suggested = SUGGESTED_MODELS[config.provider]?.[config.model];
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
        apiKey: config.apiToken,
        sessionAffinity,
      });
    case "cloudflare": {
      // Workers AI is fetch-only (no Workers-binding transport), so outside AI Gateway mode it's
      // BYOK like every other provider: the user's own account ID and API token come from the
      // model config. (The REST endpoint is account-scoped, hence the extra accountId field.)
      if (!config.accountId || !config.apiToken) {
        throw new Error(
            "This Workers AI model has no Cloudflare credentials. Re-add it with your " +
            "Cloudflare account ID and an API token that permits Workers AI.");
      }
      return makeHandle({
        model: {
          id: config.model,
          name: catalog?.name ?? config.model,
          api: "openai-completions",
          provider: "cloudflare-workers-ai",
          baseUrl: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`,
          reasoning: catalog?.reasoning ?? false,
          input: catalog?.input ?? ["text"],
          cost: catalog?.cost ?? ZERO_COST,
          ...window,
          compat: workersAiCompat(catalog),
        },
        apiKey: config.apiToken,
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
        apiKey: config.apiToken,
        sessionAffinity,
      });
    case "ollama":
      // `apiUrl` is the Ollama server base; its OpenAI-compat endpoint lives under /v1. Accept
      // (and strip) a trailing `/api` or `/v1` path: configs saved before the pi migration store
      // the native-API base `http://host:11434/api` (the old ollama provider's convention), and
      // users may paste the /v1 endpoint directly. When no API key was configured we assume
      // local auth and send no Authorization header at all (as before the pi migration; a strict
      // local proxy may reject an unexpected bearer token): the OpenAI SDK requires *some* key,
      // so give it a placeholder while a null default header deletes the Authorization header
      // the SDK derives from it.
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
        ...(config.apiToken === ""
            ? { apiKey: "unused", headers: { Authorization: null } }
            : { apiKey: config.apiToken }),
        sessionAffinity,
      });
    case "openai":
      return makeHandle({
        model: {
          id: config.model,
          name: suggested?.name ?? catalog?.name ?? config.model,
          api: "openai-responses",
          provider: "openai",
          baseUrl: config.apiUrl ?? "https://api.openai.com/v1",
          reasoning: catalog?.reasoning ?? true,
          input: catalog?.input ?? ["text", "image"],
          cost: suggested?.cost ?? catalog?.cost ?? ZERO_COST,
          ...window,
          thinkingLevelMap: catalog?.thinkingLevelMap,
          compat: catalog?.compat,
        },
        apiKey: config.apiToken,
        sessionAffinity,
      });
    default:
      config.provider satisfies never;
      throw new Error(`Unknown provider "${config.provider}".`);
  }
}

// =======================================================================================

export type LanguageModelGatekeeperProps = {
  displayName: string,
  config: AiModelConfig,
  initiator: AiChatAuthorInfo,
  metadata?: GatewayMetadataContext,
};

export class LanguageModelGatekeeper
    extends DurableObject<Cloudflare.Env, LanguageModelGatekeeperProps>
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
    if (isTeamPiCodexMarkerConfig(this.ctx.props.config)) {
      throw new Error("Team PI Codex models cannot be used through persistent bindings.");
    }
    let model = getModel(this.env, this.ctx.props.config, this.ctx.props.initiator, {
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
    return await completeText(this.model, {
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
    });
  }
}
