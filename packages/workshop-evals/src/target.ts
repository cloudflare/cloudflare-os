import {
  openAgentSession, type AgentSessionOptions, type WorkshopAgentSession,
} from "@gadgets/integration-tests/agent-session";
import { startHarness, type WorkerConfig } from "@gadgets/integration-tests/harness";
import { NetworkInterceptor } from "@gadgets/integration-tests/network-interceptor";
import { HTTPS_ONLY_PROVIDERS, type AiModelProvider } from "@gadgets/workshop-shared/api";
import type { EvalModel } from "./config.js";

/**
 * Gateway access uses one of the backend's two AiGatewayConfig transports. With
 * CF_AI_GATEWAY_USE_BINDING unset, a CF_AI_GATEWAY_API_TOKEN selects HTTPS and its absence selects
 * the Workers AI binding; the flag overrides that choice either way, and "true" keeps any token
 * available for providers whose inference cannot ride the binding. Direct access is Workers AI's
 * own REST endpoint.
 */
export type LocalModelAccess = {
  kind: "gateway";
  gateway: string;
  accountId: string;
  transport: "binding";
  apiToken?: string;
} | {
  kind: "gateway";
  gateway: string;
  accountId: string;
  transport: "https";
  apiToken: string;
} | {
  kind: "direct";
  accountId: string;
  apiToken: string;
};

type GatewayAccess = Extract<LocalModelAccess, { kind: "gateway" }>;

const GATEWAY_COST_ACCOUNTING_TIMEOUT_MS = 10_000;

/** The gateway route each provider's inference is addressed through (see gatewayNativeModel). */
const GATEWAY_ROUTES: Readonly<Partial<Record<AiModelProvider, string>>> = {
  cloudflare: "workers-ai",
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
};

export type LocalEvalTarget = AsyncDisposable & { session: WorkshopAgentSession };

function value(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const candidate = environment[key]?.trim();
  return candidate === "" ? undefined : candidate;
}

/** Resolve the model transport used by the local Workshop. */
export function resolveModelAccess(
    environment: NodeJS.ProcessEnv = process.env): LocalModelAccess {
  const gateway = value(environment, "CF_AI_GATEWAY");
  const gatewayAccountId = value(environment, "CF_AI_GATEWAY_ACCOUNT_ID");
  const gatewayApiToken = value(environment, "CF_AI_GATEWAY_API_TOKEN");
  // Normalized like the backend, so a stray " False " opts out rather than reading as unset.
  const useBinding = value(environment, "CF_AI_GATEWAY_USE_BINDING")?.toLowerCase();
  if (gateway !== undefined || gatewayAccountId !== undefined || gatewayApiToken !== undefined ||
      useBinding !== undefined) {
    if (gateway === undefined || gatewayAccountId === undefined) {
      throw new Error(
        "Local AI Gateway evals require CF_AI_GATEWAY and CF_AI_GATEWAY_ACCOUNT_ID together",
      );
    }
    if (useBinding !== undefined && useBinding !== "true" && useBinding !== "false") {
      throw new Error('CF_AI_GATEWAY_USE_BINDING must be "true" or "false"');
    }
    // Unset: the token decides, so an injected token rides HTTPS unless the binding is asked for.
    const ridesHttps =
        useBinding === undefined ? gatewayApiToken !== undefined : useBinding === "false";
    if (ridesHttps) {
      if (gatewayApiToken === undefined) {
        throw new Error(
          "CF_AI_GATEWAY_API_TOKEN must be set when CF_AI_GATEWAY_USE_BINDING is false: " +
          "opting out of the Workers AI binding leaves HTTPS as the only gateway transport",
        );
      }
      return {
        kind: "gateway", gateway, accountId: gatewayAccountId, transport: "https",
        apiToken: gatewayApiToken,
      };
    }
    return gatewayApiToken === undefined
      ? { kind: "gateway", gateway, accountId: gatewayAccountId, transport: "binding" }
      : {
        kind: "gateway", gateway, accountId: gatewayAccountId, transport: "binding",
        apiToken: gatewayApiToken,
      };
  }

  const accountId = value(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = value(environment, "CLOUDFLARE_API_TOKEN");
  if (accountId !== undefined && apiToken !== undefined) {
    return { kind: "direct", accountId, apiToken };
  }
  throw new Error(
    "Local Workshop evals need model access: configure an AI Gateway name and account, or " +
    "CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN",
  );
}

/**
 * Reject a model the configured access cannot serve, mirroring the backend's AiGatewayConfig
 * constructor and getModelViaGateway checks so a misconfigured matrix fails before inference.
 */
export function assertModelAccess(access: LocalModelAccess, model: EvalModel): void {
  if (access.kind === "direct") {
    if (model.provider !== "cloudflare") {
      throw new Error(
        `Direct Workers AI credentials only run cloudflare models, not ${model.provider} ` +
        `(${model.model}); configure an AI Gateway to run it.`,
      );
    }
    return;
  }
  if (access.transport === "binding" && HTTPS_ONLY_PROVIDERS.has(model.provider) &&
      access.apiToken === undefined) {
    throw new Error(
      `${model.provider} inference cannot ride the Workers AI binding transport, so running a ` +
      `${model.provider} model requires CF_AI_GATEWAY_API_TOKEN.`,
    );
  }
}

function configureGateway(config: WorkerConfig, access: GatewayAccess, model: EvalModel): void {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: access.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: access.accountId,
    CF_AI_GATEWAY_PROVIDERS: model.provider,
    // Explicit, so the backend fails loudly if the binding it expects went missing.
    CF_AI_GATEWAY_USE_BINDING: access.transport === "binding" ? "true" : "false",
    ...(access.apiToken === undefined ? {} : { CF_AI_GATEWAY_API_TOKEN: access.apiToken }),
  };
  if (access.transport === "binding") {
    config.account_id = access.accountId;
    config.ai = { binding: "WORKERS_AI", remote: true };
  } else {
    delete config.ai;
  }
}

function allowsModelEgress(
    access: LocalModelAccess, model: EvalModel, url: URL, method: string): boolean {
  const account = encodeURIComponent(access.accountId);
  if (access.kind === "gateway") {
    const gateway = encodeURIComponent(access.gateway);
    if (method === "POST") {
      // Inference rides HTTPS when the binding is opted out, or for providers whose adapter
      // cannot ride the binding at all (the backend's AiGatewayConfig.bindingFor).
      const route = GATEWAY_ROUTES[model.provider];
      const ridesHttps =
          access.transport === "https" || HTTPS_ONLY_PROVIDERS.has(model.provider);
      return route !== undefined && ridesHttps &&
        url.origin === "https://gateway.ai.cloudflare.com" &&
        url.pathname.startsWith(`/v1/${account}/${gateway}/${route}/`);
    }
    // Cost-log reads are same-account, so the backend reads them through the binding whenever
    // the binding transport is active, even for HTTPS-only inference providers.
    if (access.transport !== "https") return false;
    const logPrefix =
        `/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs/`;
    const logId = url.pathname.slice(logPrefix.length);
    return method === "GET" && url.origin === "https://api.cloudflare.com" &&
      url.pathname.startsWith(logPrefix) && logId !== "" && !logId.includes("/");
  }
  return method === "POST" && url.origin === "https://api.cloudflare.com" &&
    url.pathname === `/client/v4/accounts/${account}/ai/v1/chat/completions`;
}

/** Start an isolated local workerd Workshop and one fresh agent session. */
export async function openLocalEvalTarget(
    access: LocalModelAccess, model: EvalModel, turnTimeoutMs: number): Promise<LocalEvalTarget> {
  const interceptor = new NetworkInterceptor({
    handlers: [
      () => new Response("External network access is disabled during this eval.", { status: 403 }),
    ],
    allow: (url, method) => allowsModelEgress(access, model, url, method),
    allowLoopback: false,
  });

  const harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    ...(access.kind === "gateway"
      ? { patchWorkshop: (config: WorkerConfig) => configureGateway(config, access, model) }
      : {}),
  });
  interceptor.install();

  const options: AgentSessionOptions = {
    modelId: model.model,
    turnTimeoutMs,
    costAccountingTimeoutMs: access.kind === "gateway" ? GATEWAY_COST_ACCOUNTING_TIMEOUT_MS : 0,
    userModel: {
      profile: { type: "agent", id: model.model, name: model.model },
      config: {
        provider: model.provider,
        model: model.model,
        accountId: access.accountId,
        // Gateway mode takes transport credentials from the Worker environment.
        apiToken: access.kind === "direct" ? access.apiToken : "",
      },
    },
  };

  try {
    const session = await openAgentSession(harness.url, options);
    return {
      session,
      [Symbol.asyncDispose]: async () => {
        const failures: Error[] = [];
        try {
          await session.close();
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
        try {
          await harness.server.close();
          interceptor.uninstall();
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
        const first = failures.at(0);
        if (failures.length === 1 && first !== undefined) throw first;
        if (failures.length > 1) throw new AggregateError(failures, "Eval target cleanup failed");
      },
    };
  } catch (error) {
    const setupError = error instanceof Error ? error : new Error(String(error));
    try {
      await harness.server.close();
      interceptor.uninstall();
    } catch (failure) {
      const closeError = failure instanceof Error ? failure : new Error(String(failure));
      const aggregate = new AggregateError(
        [setupError, closeError],
        "Eval session setup and cleanup failed",
      );
      aggregate.cause = failure;
      throw aggregate;
    }
    throw setupError;
  }
}
