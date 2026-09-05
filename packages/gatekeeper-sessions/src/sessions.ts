import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import { ContainerProxy, getSandbox, Sandbox, type Terminal } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  SUGGESTED_MODELS,
  type CodingSessionApplicationCapability,
  type CodingSessionAttachCapability,
  type CodingSessionDevelopmentCatalog,
  type CodingSessionDevelopmentPlan,
  type CodingSessionDevelopmentStatus,
  type CodingSessionEditorCapability,
  type CodingSessionFileUploadRequest,
  type CodingSessionFileUploadResult,
  type CodingSessionInstanceTier,
  type CodingSessionOpenCodeCapability,
  type CodingSessionRepository,
  type CodingSessionRuntime,
  type CodingSessionSummary,
  type CodingSessionTerminalKind,
  type CreateCodingSessionRequest,
  type OpenCodeUserCustomization,
} from "@gadgets/workshop-shared/api";
import {
  type CodingSessionOwner,
  type CodingSessionReadResourceResult,
  type CodingSessionResource,
  type CodingSessionTool,
  type CodingSessionToolHost,
  type CodingSessionToolResult,
  type CodingSessionsService,
  type ProductFeedbackEvidenceBundle,
  validateCodingSessionFileUploadRequest,
} from "@gadgets/workshop-shared/coding-sessions";
import type { ProductFeedbackStatus, ProductFeedbackSubmissionResult } from "@gadgets/workshop-shared/product-feedback";
import type { ProductFeedbackNotifier } from "@gadgets/workshop-shared/product-feedback";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  mintGitHubCodingSessionToken,
  mintGitHubProductFeedbackReadToken,
  type GitHubAppEnv,
  type GitHubInstallationToken,
} from "./github-app.js";
import {
  isSupportedWorkshopMcpProtocolVersion,
  isValidWorkshopMcpRequestId,
  negotiateWorkshopMcpProtocolVersion,
  workshopMcpToolDefinition,
  WORKSHOP_MCP_HOST,
  validateWorkshopMcpRequestTarget,
} from "./mcp-policy.js";
import { DEVELOPMENT_CATALOG, publicDevelopmentCatalog } from "./development-catalog.js";
import {
  cloneDevelopmentGenerationIntent,
  createDevelopmentGenerationIntent,
  type DevelopmentGenerationIntent,
} from "./development-intent.js";
import { planDevelopmentStack } from "./development-planner.js";
import {
  cleanupDevelopmentGeneration,
  createDevelopmentSupervisorState,
  publicDevelopmentSupervisorUpdate,
  reconcileDevelopmentGeneration,
  type DevelopmentSupervisorState,
} from "./development-supervisor.js";
import { validateRepositories } from "./policy.js";
import {
  CodingSessionApplicationPreview,
  handleApplicationPreviewIngress,
  type ApplicationPreviewEnv,
} from "./application-preview.js";
import { sandboxFor, sandboxObjectId } from "./sandbox-routing.js";
import {
  type CapacityReservationKey,
  type CapacityReservationRecord,
  type CapacityReplacement,
  type CodingSessionCapacity,
  type HeavySessionTier,
  HEAVY_SESSION_TIERS,
} from "./capacity.js";
import {
  assertRuntimeEnabled,
  codingSessionRuntime,
  openCodeCommand,
  PI_CONFIG_DIR,
  PI_EXTENSION_PATH,
  piCommand,
  piEnvironment,
  piExtensionSource,
  PRIME_AGENT_CONFIG_DIR,
  PRIME_AGENT_EXTENSION_PATH,
  primeAgentCommand,
  primeAgentEnvironment,
  primeAgentExtensionSource,
  primeAgentSettings,
} from "./runtime.js";
import {
  createDraftPullRequest,
  feedbackBranch,
  productFeedbackPrompt,
  PRODUCT_FEEDBACK_REPOSITORY,
  summarizeProductFeedbackDiff,
  validateSafeDiff,
  type ProductFeedbackJob,
} from "./product-feedback.js";

export { ContainerProxy, CodingSessionApplicationPreview };

const ATTACH_TTL_MS = 60_000;
const EDITOR_CAPABILITY_TTL_MS = 30 * 60 * 1_000;
const EDITOR_PORT = 13_337;
const OPENCODE_SERVER_CAPABILITY_TTL_MS = 10 * 60 * 1_000;
const OPENCODE_SERVER_PORT = 40_913;
const OPENCODE_SERVER_MAX_POST_BYTES = 12 * 1024 * 1024;
const OPENCODE_SERVER_VERSION = 1;
const TEAM_PI_CODEX_MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const TEAM_PI_CODEX_MAX_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS_PER_USER = 5;
const MAX_TITLE_LENGTH = 120;
const GITHUB_ORIGIN = "https://github.com";
const OPENCODE_CONFIG_DIR = "/workspace/.odie-opencode";
const OPENCODE_TEAM_PI_MODEL_ID = "gpt-6-astra";
const OPENCODE_TEAM_PI_MODEL = SUGGESTED_MODELS.openai[OPENCODE_TEAM_PI_MODEL_ID]!;
const OPENCODE_SOL_MODEL_ID = "gpt-5.6-sol";
const OPENCODE_SOL_MODEL = SUGGESTED_MODELS.openai[OPENCODE_SOL_MODEL_ID]!;
const UPLOAD_DIR = "/workspace/.odie-uploads";
const STARTUP_ALARM_DELAY_MS = 1_000;
const STARTUP_MAX_ATTEMPTS = 3;
const STARTUP_CLONE_CONCURRENCY = 2;
const DEVELOPMENT_RECONCILE_INTERVAL_MS = 5_000;
// Bound attach/reconnect replay so fresh input is not queued behind a large TUI history.
const TERMINAL_REPLAY_BUFFER_SIZE = 256 * 1024;

type SessionsLogFields = {
  sessionId?: string;
  userId?: string;
  repositoryCount?: number;
  startupDurationMs?: number;
  mcpMethod?: string;
  status?: number;
  phase?: string;
  terminalKind?: CodingSessionTerminalKind;
  reason?: string;
};

const logger = createLogger<SessionsLogFields>({ component: "gatekeeper.sessions" });

interface Env extends GitHubAppEnv, ApplicationPreviewEnv {
  SESSION_CAPACITY: DurableObjectNamespace<CodingSessionCapacity>;
  SESSION_POLICIES: DurableObjectNamespace<CodingSessionPolicy>;
  WORKSHOP_TOOLS: Service<CodingSessionToolHost>;
  BASE_URL?: string;
  EDITOR_BASE_URL?: string;
  EDITOR_CAPABILITY_HMAC_SECRET?: string;
  SESSION_ALLOWED_ORIGIN?: string;
  TEAM_PI_CODEX_BASE_URL?: string;
  TEAM_PI_CODEX_HMAC_SECRET?: string;
  CODING_SESSION_PI_RUNTIME_ENABLED?: string;
  CODING_SESSION_DURABLE_LIFECYCLE_ENABLED?: string;
  PRODUCT_FEEDBACK_NOTIFIER?: Service<ProductFeedbackNotifier>;
  PRODUCT_FEEDBACK_SANDBOX: DurableObjectNamespace<ProductFeedbackSandbox>;
}

type SessionRecord = Omit<CodingSessionSummary, "runtime"> & {
  runtime?: CodingSessionRuntime;
  /** Keeps old deployments able to read Prime records as Pi during the rollout rollback window. */
  primeAgent?: true;
  sandboxId: string;
  terminalId?: string;
  shellTerminalId?: string;
  editorProcessId?: string;
  opencodeServerProcessId?: string;
  opencodeServerVersion?: number;
  /** Public generation. Historical terminal-only sessions default to generation zero. */
  generation?: number;
  /** Fixed sandbox tier. Historical terminal-only sessions default to standard-1. */
  instanceTier?: CodingSessionInstanceTier;
  /** Exact heavy-capacity reservation held by this generation. */
  capacityLease?: CapacityReservationKey;
};

type AttachTicket = {
  sandboxId: string;
  terminalId: string;
  userId: string;
  sessionId: string;
  terminalKind: CodingSessionTerminalKind;
  generation?: number;
  instanceTier?: CodingSessionInstanceTier;
  expiresAt: number;
};

type EditorTicket = {
  sandboxId: string;
  userId: string;
  sessionId: string;
  generation?: number;
  instanceTier?: CodingSessionInstanceTier;
  expiresAt: number;
};

type OpenCodeTicket = EditorTicket;

type SessionPolicy = {
  sessionId: string;
  sandboxId?: string;
  generation?: number;
  instanceTier?: CodingSessionInstanceTier;
  runtime?: CodingSessionRuntime;
  owner: CodingSessionOwner;
  repositories: CodingSessionRepository[];
  /** Complete server-authored execution authority for this generation, when selected. */
  developmentIntent?: DevelopmentGenerationIntent;
};

type StartupPhase = "authorize" | "clone" | "materialize" | "terminal";

type StartupRecord = {
  generation?: number;
  phase: StartupPhase;
  nextRepositoryIndex: number;
  completedRepositoryIndexes?: number[];
  cloneProcesses?: Array<{ repositoryIndex: number; processId: string }>;
  failureError?: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
};

type StartRecord = {
  sessionId: string;
  owner: CodingSessionOwner;
  sandboxId: string;
  generation: number;
  attempts: number;
  phase: "configure" | "schedule";
  developmentIntent?: DevelopmentGenerationIntent;
};

type StopRecord = {
  sessionId: string;
  sandboxId: string;
  generation: number;
  instanceTier: CodingSessionInstanceTier;
  lease?: CapacityReservationKey;
  development?: true;
  phase: "cancel" | "cleanup" | "destroy" | "release" | "finalize";
};

type RestartRecord = {
  sessionId: string;
  owner: CodingSessionOwner;
  oldSandboxId: string;
  oldGeneration: number;
  instanceTier: CodingSessionInstanceTier;
  oldLease?: CapacityReservationKey;
  newSandboxId: string;
  newGeneration: number;
  replacement?: CapacityReplacement;
  newLease?: CapacityReservationKey;
  development?: true;
  phase: "prepare" | "cleanup" | "destroy" | "transfer" | "schedule";
};

type FeedbackSandbox = StartupSandbox & {
  readFile: InstanceType<typeof CodingSessionSandbox>["readFile"];
};

type StartupProcess = {
  id: string;
  kill(signal?: number): Promise<void>;
  waitForExit(options?: { timeout?: number }): Promise<{ code: number; timedOut?: boolean }>;
  waitForPort(port: number, options?: {
    mode?: "http" | "tcp";
    path?: string;
    status?: { min: number; max: number };
    timeout?: number;
  }): Promise<unknown>;
  status(): Promise<
    | { state: "running" }
    | { state: "exited"; exit: { code: number; timedOut?: boolean } }
    | { state: "error" }
  >;
};

type StartupTerminalOptions = Parameters<InstanceType<typeof CodingSessionSandbox>["createTerminal"]>[0];

type StartupSandbox = {
  configureGitHubAuth(token: string): Promise<void>;
  destroy(): Promise<void>;
  exec(command: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): Promise<StartupProcess>;
  getProcess(id: string): Promise<StartupProcess | null>;
  createTerminal(options: StartupTerminalOptions): Promise<Terminal>;
  listTerminals(): Promise<Terminal[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string | ReadableStream<Uint8Array>, options?: { encoding?: string }): Promise<unknown>;
};

/** Isolated Linux environment used by one coding session. */
export class CodingSessionSandbox extends Sandbox<Env> {
  sleepAfter = "10m";
  enableInternet = true;
  interceptHttps = true;
  entrypoint = [
    "sh", "-lc",
    "cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates && exec /usr/bin/tini -- /container-server/sandbox",
  ];
  /** Installs GitHub authentication in the Worker-side credential proxy. */
  async configureGitHubAuth(token: string): Promise<void> {
    await this.registerGitAuthInterceptor({
      hosts: { "github.com": { token, username: "x-access-token", type: "basic" } },
    });
  }

}

/** Standard-2 isolated Linux environment for one heavy coding-session generation. */
export class CodingSessionSandboxStandard2 extends CodingSessionSandbox {}

/** Standard-3 isolated Linux environment for one heavy coding-session generation. */
export class CodingSessionSandboxStandard3 extends CodingSessionSandbox {}

/** Standard-4 isolated Linux environment for one heavy coding-session generation. */
export class CodingSessionSandboxStandard4 extends CodingSessionSandbox {}

/** Deny-by-default sandbox used only for autonomous product-feedback analysis. */
export class ProductFeedbackSandbox extends CodingSessionSandbox {
  override enableInternet = false;
  override allowedHosts = ["github.com", "team-pi-proxy.unison.totango.com"];
}

// Assignment must invoke Container's inherited static setter, which installs these handlers in the
// registry used by ContainerProxy. A static class field would shadow the setter without registering.
const codingSessionOutboundHandlers = {
  "team-pi-proxy.unison.totango.com":
    (request: Request, env: Env, ctx: OutboundHandlerContext) =>
      policyFor(env, ctx.containerId).forwardTeamPiCodexRequest(request),
  [WORKSHOP_MCP_HOST]:
    (request: Request, env: Env, ctx: OutboundHandlerContext) =>
      policyFor(env, ctx.containerId).handleWorkshopMcpRequest(request),
  "registry.npmjs.org": publicReadOnlyRequest,
  "pypi.org": publicReadOnlyRequest,
  "files.pythonhosted.org": publicReadOnlyRequest,
  "proxy.golang.org": publicReadOnlyRequest,
  "sum.golang.org": publicReadOnlyRequest,
};
CodingSessionSandbox.outboundByHost = codingSessionOutboundHandlers;
CodingSessionSandboxStandard2.outboundByHost = codingSessionOutboundHandlers;
CodingSessionSandboxStandard3.outboundByHost = codingSessionOutboundHandlers;
CodingSessionSandboxStandard4.outboundByHost = codingSessionOutboundHandlers;
// The SDK registry is shared across subclasses; ProductFeedbackSandbox.allowedHosts is its narrower authority.
ProductFeedbackSandbox.outboundByHost = codingSessionOutboundHandlers;

/** Durable repository and model egress policy for one sandbox instance. */
export class CodingSessionPolicy extends DurableObject<Env> {
  #lifecycleTail: Promise<void> = Promise.resolve();

  /** Installs the immutable owner and repository set before the sandbox starts. */
  configure(policy: SessionPolicy): void {
    const existing = this.ctx.storage.kv.get<SessionPolicy>("policy");
    if (existing) {
      if (JSON.stringify({ sessionId: existing.sessionId, generation: existing.generation ?? 0,
            instanceTier: existing.instanceTier ?? "standard-1", owner: existing.owner,
            repositories: existing.repositories, developmentIntent: existing.developmentIntent }) !==
          JSON.stringify({ sessionId: policy.sessionId, generation: policy.generation ?? 0,
            instanceTier: policy.instanceTier ?? "standard-1", owner: policy.owner,
            repositories: policy.repositories,
            developmentIntent: policy.developmentIntent ?? existing.developmentIntent })) {
        throw new Error("Coding session policy is immutable.");
      }
      // Policy DOs are keyed by container ID, so another sandbox generation must use another DO.
      if (existing.sandboxId && policy.sandboxId && existing.sandboxId !== policy.sandboxId) {
        throw new Error("Coding session policy is immutable.");
      }
      if (!existing.sandboxId && policy.sandboxId) {
        this.ctx.storage.kv.put("policy", { ...existing, sandboxId: policy.sandboxId });
      }
      return;
    }
    this.ctx.storage.kv.put("policy", policy);
  }

  /** Persists bounded startup progress and schedules the first asynchronous startup alarm. */
  async startSessionStartup(record: StartupRecord): Promise<void> {
    await this.#withLifecycleLock(async () => {
      const policy = this.#policy();
      const sandboxId = required(policy.sandboxId, "startup sandboxId");
      if (this.ctx.storage.kv.get<boolean>(startupCancellationKey(policy.sessionId, record.generation ?? 0, sandboxId))) {
        throw new Error("Coding session startup was cancelled.");
      }
      const existing = this.ctx.storage.kv.get<StartupRecord>("startup");
      if (existing && (existing.generation ?? 0) !== (record.generation ?? 0)) {
        throw new Error("Coding session startup generation is already in progress.");
      }
      if (!existing) this.ctx.storage.kv.put("startup", record);
      try {
        await this.#armPolicyAlarm(Date.now() + 1);
      } catch (error) {
        if (!existing) this.ctx.storage.kv.delete("startup");
        throw error;
      }
    });
  }

  /** Cancels asynchronous startup for the configured session generation. */
  async cancelSessionStartup(sessionId: string, generation: number, sandboxId: string): Promise<void> {
    await this.#withLifecycleLock(async () => {
      const policy = this.ctx.storage.kv.get<SessionPolicy>("policy");
      if (policy && (policy.sessionId !== sessionId || (policy.generation ?? 0) !== generation ||
          policy.sandboxId !== sandboxId)) return;
      this.ctx.storage.kv.put(startupCancellationKey(sessionId, generation, sandboxId), true);
      this.ctx.storage.kv.delete("startup");
      await this.#scheduleNextPolicyAlarm();
    });
  }

  /** Stores a short-lived terminal ticket in a token-addressed policy object. */
  async storeTicket(ticket: AttachTicket): Promise<void> {
    this.ctx.storage.kv.put("ticket", ticket);
    await this.#armPolicyAlarm(ticket.expiresAt);
  }

  /** Atomically consumes a terminal ticket. */
  consumeTicket(now: number): AttachTicket | null {
    const ticket = this.ctx.storage.kv.get<AttachTicket>("ticket");
    this.ctx.storage.kv.delete("ticket");
    if (!ticket || ticket.expiresAt < now) return null;
    return ticket;
  }

  /** Stores a reusable but short-lived browser-editor ticket. */
  async storeEditorTicket(ticket: EditorTicket): Promise<void> {
    this.ctx.storage.kv.put("editorTicket", ticket);
    await this.#armPolicyAlarm(ticket.expiresAt);
  }

  /** Reads a browser-editor ticket without consuming it. */
  getEditorTicket(now: number): EditorTicket | null {
    const ticket = this.ctx.storage.kv.get<EditorTicket>("editorTicket");
    if (!ticket || ticket.expiresAt < now) return null;
    return ticket;
  }

  /** Stores a reusable but short-lived OpenCode HTTP workbench ticket. */
  async storeOpenCodeTicket(ticket: OpenCodeTicket): Promise<void> {
    this.ctx.storage.kv.put("opencodeTicket", ticket);
    await this.#armPolicyAlarm(ticket.expiresAt);
  }

  /** Reads an OpenCode HTTP workbench ticket without consuming it. */
  getOpenCodeTicket(now: number): OpenCodeTicket | null {
    const ticket = this.ctx.storage.kv.get<OpenCodeTicket>("opencodeTicket");
    if (!ticket || ticket.expiresAt < now) return null;
    return ticket;
  }

  /** Multiplexes startup, ticket expiry, and component supervision without clobbering wakeups. */
  async alarm(): Promise<void> {
    this.ctx.storage.kv.delete("policy-alarm-at");
    const startup = this.ctx.storage.kv.get<StartupRecord>("startup");
    if (startup) {
      await this.#withLifecycleLock(async () => {
        const current = this.ctx.storage.kv.get<StartupRecord>("startup");
        if (!current) return;
        const policy = this.#policy();
        const sandboxId = required(policy.sandboxId, "startup sandboxId");
        if (this.ctx.storage.kv.get<boolean>(startupCancellationKey(policy.sessionId, current.generation ?? 0, sandboxId))) {
          this.ctx.storage.kv.delete("startup");
          return;
        }
        // Pre-arm recovery before any remote authorization, sandbox, or registry work.
        await this.#armPolicyAlarm(Date.now() + STARTUP_ALARM_DELAY_MS);
        await this.#advanceStartup(current);
      });
      return;
    }

    await this.#withLifecycleLock(async () => {
      const supervision = this.ctx.storage.kv.get<DevelopmentSupervisorState>("development-supervision");
      if (!supervision || this.ctx.storage.kv.get<boolean>("development-cleaned")) return;
      const policy = this.#policy();
      const intent = policy.developmentIntent;
      if (!intent) throw new Error("Development generation intent is missing.");
      await this.#armPolicyAlarm(Date.now() + DEVELOPMENT_RECONCILE_INTERVAL_MS);
      const sandbox = sandboxFor(this.env, storedPolicyTier(policy), required(policy.sandboxId, "development sandboxId"));
      const terminalId = this.ctx.storage.kv.get<string>("primary-terminal-id");
      const terminals = await sandbox.listTerminals();
      if (!terminalId || !terminals.some(terminal => terminal.id === terminalId)) {
        for (const component of Object.values(supervision.components)) {
          component.status = "failed";
          component.message = "The component container is unavailable. Restart the session.";
          component.updatedAt = Date.now();
        }
        supervision.updatedAt = Date.now();
        this.ctx.storage.kv.put("development-supervision", supervision);
        await this.#registry().developmentUpdated(publicDevelopmentSupervisorUpdate(intent, supervision));
        this.ctx.storage.kv.put("development-cleaned", true);
      } else {
        const next = await reconcileDevelopmentGeneration(
          intent, supervision, sandbox, {}, Date.now(), async checkpoint => {
            this.ctx.storage.kv.put("development-supervision", checkpoint);
          },
        );
        if (!this.ctx.storage.kv.get<boolean>("development-cleaned")) {
          this.ctx.storage.kv.put("development-supervision", next);
          await this.#registry().developmentUpdated(publicDevelopmentSupervisorUpdate(intent, next));
        }
      }
    });
    const now = Date.now();
    const ticket = this.ctx.storage.kv.get<AttachTicket>("ticket");
    if (ticket && ticket.expiresAt <= now) this.ctx.storage.kv.delete("ticket");
    const editorTicket = this.ctx.storage.kv.get<EditorTicket>("editorTicket");
    if (editorTicket && editorTicket.expiresAt <= now) this.ctx.storage.kv.delete("editorTicket");
    const openCodeTicket = this.ctx.storage.kv.get<OpenCodeTicket>("opencodeTicket");
    if (openCodeTicket && openCodeTicket.expiresAt <= now) this.ctx.storage.kv.delete("opencodeTicket");
    await this.#scheduleNextPolicyAlarm();
  }

  /** Checks whether an exact dark-rollout generation has private restart authority. */
  hasDevelopmentIntent(sessionId: string, generation: number, sandboxId: string): boolean {
    const policy = this.#policy();
    return policy.sessionId === sessionId && (policy.generation ?? 0) === generation &&
      policy.sandboxId === sandboxId && policy.developmentIntent !== undefined;
  }

  /** Copies private generation authority directly into a fenced replacement policy object. */
  async prepareDevelopmentRestart(
    sessionId: string,
    generation: number,
    sandboxId: string,
    newSandboxId: string,
    newGeneration: number,
  ): Promise<boolean> {
    const policy = this.#policy();
    if (policy.sessionId !== sessionId || (policy.generation ?? 0) !== generation || policy.sandboxId !== sandboxId) {
      throw new Error("Coding session restart generation is stale.");
    }
    const intent = policy.developmentIntent;
    if (!intent) return false;
    const replacementIntent = cloneDevelopmentGenerationIntent({
      ...intent,
      sandboxId: newSandboxId,
      generation: newGeneration,
    });
    await policyForSandbox(this.env, storedPolicyTier(policy), newSandboxId).configure({
      ...policy,
      sandboxId: newSandboxId,
      generation: newGeneration,
      developmentIntent: replacementIntent,
    });
    return true;
  }

  /** Cleans up catalog services only for the exact configured generation before sandbox destroy. */
  async cleanupDevelopment(sessionId: string, generation: number, sandboxId: string): Promise<void> {
    await this.#withLifecycleLock(async () => {
      const policy = this.ctx.storage.kv.get<SessionPolicy>("policy");
      if (!policy) return;
      if (policy.sessionId !== sessionId || (policy.generation ?? 0) !== generation || policy.sandboxId !== sandboxId) return;
      const intent = policy.developmentIntent;
      const state = this.ctx.storage.kv.get<DevelopmentSupervisorState>("development-supervision");
      if (!intent || !state) return;
      // Fence reconciliation before the first remote cleanup operation. Retries remain idempotent.
      this.ctx.storage.kv.put("development-cleaned", true);
      await this.#armPolicyAlarm(Date.now() + DEVELOPMENT_RECONCILE_INTERVAL_MS);
      const sandbox = sandboxFor(this.env, storedPolicyTier(policy), sandboxId);
      const stopped = await cleanupDevelopmentGeneration(intent, state, sandbox, Date.now(), async checkpoint => {
        this.ctx.storage.kv.put("development-supervision", checkpoint);
      });
      this.ctx.storage.kv.put("development-supervision", stopped);
      await this.#registry().developmentUpdated(publicDevelopmentSupervisorUpdate(intent, stopped));
      // Public stopped status is durable in the registry; discard private process/log state now.
      this.ctx.storage.kv.delete("development-supervision");
      await this.#scheduleNextPolicyAlarm();
    });
  }

  /** Mints or reuses a GitHub token scoped to this session's repositories. */
  async getInstallationToken(): Promise<string> {
    const policy = this.#policy();
    return this.#installationToken(policy.repositories);
  }

  /** Signs and proxies one Team PI Codex Responses request for the authenticated owner. */
  async forwardTeamPiCodexRequest(request: Request): Promise<Response> {
    const policy = this.#policy();
    const baseUrl = required(this.env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
    const secret = required(this.env.TEAM_PI_CODEX_HMAC_SECRET, "TEAM_PI_CODEX_HMAC_SECRET");
    const expected = new URL("codex/responses", ensureTrailingSlash(baseUrl));
    const url = new URL(request.url);
    if (request.method !== "POST" || url.origin !== expected.origin || url.pathname !== expected.pathname) {
      return new Response("Codex request is not allowed.", { status: 403 });
    }

    const encoding = request.headers.get("Content-Encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity" && encoding !== "zstd") {
      return new Response("Codex request encoding is not supported.", { status: 415 });
    }
    const encodedLimit = encoding === "zstd"
      ? TEAM_PI_CODEX_MAX_COMPRESSED_BYTES
      : TEAM_PI_CODEX_MAX_DECODED_BYTES;
    const contentLength = request.headers.get("Content-Length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > encodedLimit)) {
      return new Response("Codex request is too large.", { status: 413 });
    }
    let body = await readBoundedBody(request.body, encodedLimit);
    if (!body) return new Response("Codex request is too large.", { status: 413 });
    if (encoding === "zstd") {
      try {
        body = Uint8Array.from(zstdDecompressSync(body, { maxOutputLength: TEAM_PI_CODEX_MAX_DECODED_BYTES }));
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "ERR_BUFFER_TOO_LARGE") {
          return new Response("Codex request is too large.", { status: 413 });
        }
        return new Response("Codex request compression is invalid.", { status: 400 });
      }
    }
    const timestamp = Date.now().toString();
    const clientRequestId = crypto.randomUUID();
    const sessionId = this.ctx.id.toString();
    const user = policy.owner.email.toLowerCase();
    const canonical = [
      "odie-v1",
      "team-pi-codex",
      "POST",
      "/api/odie/codex/responses",
      timestamp,
      user,
      sessionId,
      clientRequestId,
      await sha256Hex(body),
    ].join("\n");
    const headers = new Headers();
    for (const name of ["Content-Type", "Accept", "OpenAI-Beta", "Originator"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("Content-Encoding", "identity");
    headers.set("session-id", sessionId);
    headers.set("x-client-request-id", clientRequestId);
    headers.set("x-team-pi-odie-key-id", "odie-v1");
    headers.set("x-team-pi-odie-audience", "team-pi-codex");
    headers.set("x-team-pi-odie-timestamp", timestamp);
    headers.set("x-team-pi-odie-user", user);
    headers.set("x-team-pi-odie-signature", `v1=${await hmacBase64Url(secret, canonical)}`);
    const response = await fetch(expected, { method: "POST", headers, body, redirect: "manual" });
    if (!response.ok) {
      logger.warn("Team PI Codex request rejected", {
        event: "coding.session.codex.rejected",
        sessionId: policy.sessionId,
        status: response.status,
      });
    }
    return response;
  }

  /** Terminates the session-scoped Workshop MCP protocol without exposing account credentials. */
  async handleWorkshopMcpRequest(request: Request): Promise<Response> {
    const rejectedTarget = validateWorkshopMcpRequestTarget(request);
    if (rejectedTarget) return rejectedTarget;
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return new Response("Workshop MCP requires JSON.", { status: 415 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 1024 * 1024) return new Response("Workshop MCP request is too large.", { status: 413 });
    let message: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      message = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return mcpError(null, -32700, "Parse error");
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return mcpError(message.id ?? null, -32600, "Invalid Request");
    }
    const protocolVersion = request.headers.get("MCP-Protocol-Version");
    if (message.method !== "initialize" && protocolVersion !== null &&
        !isSupportedWorkshopMcpProtocolVersion(protocolVersion)) {
      return new Response("Unsupported MCP protocol version.", { status: 400 });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if ((message.method === "initialize" || message.method === "tools/list" ||
         message.method === "resources/list" || message.method === "resources/read" ||
         message.method === "tools/call") && !isValidWorkshopMcpRequestId(message.id)) {
      return mcpError(null, -32600, "A non-null request id is required");
    }
    const policy = this.#policy();
    try {
      const sandboxId = required(policy.sandboxId, "Workshop MCP sandboxId");
      if (message.method === "initialize") {
        const params = message.params as { protocolVersion?: unknown } | undefined;
        const negotiatedProtocolVersion = negotiateWorkshopMcpProtocolVersion(params?.protocolVersion);
        if (negotiatedProtocolVersion === null) {
          return mcpError(message.id, -32602, "A valid protocolVersion is required");
        }
        return mcpResult(message.id, {
          protocolVersion: negotiatedProtocolVersion,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "Workshop connections", version: "1.0.0" },
        });
      }
      if (message.method === "tools/list") {
        const tools = await this.env.WORKSHOP_TOOLS.listTools(
          policy.owner, policy.sessionId, sandboxId) as unknown as CodingSessionTool[];
        return mcpResult(message.id, {
          tools: [
            ...tools.map(workshopMcpToolDefinition),
            {
              name: "workshop_action_result",
              title: "Collect an approved Workshop action",
              description: "Collect the result of a connected-service action after Workshop approval.",
              _meta: { ui: { visibility: ["model"] } },
              inputSchema: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  actionId: { type: "integer" },
                },
                required: ["tool", "actionId"],
                additionalProperties: false,
              },
            },
          ],
        });
      }
      if (message.method === "resources/list") {
        const resources = await this.env.WORKSHOP_TOOLS.listResources(
          policy.owner, policy.sessionId, sandboxId) as unknown as CodingSessionResource[];
        return mcpResult(message.id, { resources });
      }
      if (message.method === "resources/read") {
        const params = message.params as { uri?: unknown } | undefined;
        if (typeof params?.uri !== "string") {
          return mcpError(message.id, -32602, "uri is required");
        }
        const result = await this.env.WORKSHOP_TOOLS.readResource(
          policy.owner, policy.sessionId, params.uri, sandboxId) as unknown as CodingSessionReadResourceResult;
        return mcpResult(message.id, result);
      }
      if (message.method === "tools/call") {
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
        if (!params || typeof params.name !== "string" ||
            (params.arguments !== undefined &&
             (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments)))) {
          return mcpError(message.id, -32602, "Invalid tool arguments");
        }
        let result: CodingSessionToolResult;
        if (params.name === "workshop_action_result") {
          const args = params.arguments as { tool?: unknown; actionId?: unknown } | undefined;
          if (typeof args?.tool !== "string" || !Number.isInteger(args.actionId)) {
            return mcpError(message.id, -32602, "tool and actionId are required");
          }
          result = await this.env.WORKSHOP_TOOLS.getActionResult(
            policy.owner, policy.sessionId, args.tool,
            args.actionId as number, sandboxId) as unknown as CodingSessionToolResult;
        } else {
          result = await this.env.WORKSHOP_TOOLS.callTool(
            policy.owner, policy.sessionId, params.name,
            params.arguments as Record<string, unknown> | undefined, sandboxId) as unknown as CodingSessionToolResult;
        }
        if (result.pendingActionId !== undefined) {
          result.content = [{
            type: "text",
            text: `This action is awaiting Workshop approval. After it is resolved, call ` +
              `workshop_action_result with tool=${JSON.stringify(params.name)} and ` +
              `actionId=${result.pendingActionId}. Do not repeat the original action.`,
          }];
        }
        return mcpResult(message.id, result);
      }
      return mcpError(message.id, -32601, "Method not found");
    } catch (error) {
      logger.warn("Workshop MCP request failed", {
        event: "coding.session.mcp.failed",
        sessionId: policy.sessionId,
        mcpMethod: message.method.slice(0, 128),
        error,
      });
      return mcpError(message.id, -32603, boundedError(error));
    }
  }

  #policy(): SessionPolicy {
    const policy = this.ctx.storage.kv.get<SessionPolicy>("policy");
    if (!policy) throw new Error("Coding session policy has not been configured.");
    return policy;
  }

  async #installationToken(repositories: CodingSessionRepository[]): Promise<string> {
    const cached = this.ctx.storage.kv.get<GitHubInstallationToken>("githubToken");
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const result = await mintGitHubCodingSessionToken(this.env, repositories);
    this.ctx.storage.kv.put("githubToken", result);
    return result.token;
  }

  async #advanceStartup(startup: StartupRecord): Promise<void> {
    if ((startup.generation ?? 0) !== (this.#policy().generation ?? 0)) {
      this.ctx.storage.kv.delete("startup");
      return;
    }
    if (startup.failureError !== undefined) {
      await this.#finalizeStartupFailure(startup, startup.failureError);
      return;
    }
    try {
      await this.#advanceStartupOnce(startup);
    } catch (error) {
      const current = this.ctx.storage.kv.get<StartupRecord>("startup");
      const policy = this.#policy();
      if (!current) return;
      if (current.failureError !== undefined) {
        await this.#finalizeStartupFailure(current, current.failureError);
        return;
      }
      if (current.attempt + 1 < STARTUP_MAX_ATTEMPTS) {
        if (current.phase === "clone") await this.#stopCloneProcesses(current);
        this.#putStartup({
          ...current,
          attempt: current.attempt + 1,
          ...(current.phase === "clone" ? { nextRepositoryIndex: 0, cloneProcesses: undefined } : {}),
        });
        await this.#scheduleStartup();
        logger.warn("coding session startup phase will retry", {
          event: "coding.session.startup.retry",
          sessionId: policy.sessionId,
          phase: startup.phase,
          error,
        });
        return;
      }
      const failed = { ...current, failureError: boundedError(error), updatedAt: Date.now() };
      this.#putStartup(failed);
      await this.#finalizeStartupFailure(failed, failed.failureError);
      logger.error("coding session startup failed", {
        event: "coding.session.startup.failed",
        sessionId: policy.sessionId,
        phase: startup.phase,
        error,
      });
    }
  }

  async #finalizeStartupFailure(startup: StartupRecord, error: string): Promise<void> {
    const policy = this.#policy();
    const sandboxId = required(policy.sandboxId, "startup sandboxId");
    if (startup.phase === "clone") {
      try {
        await this.#stopCloneProcesses(startup);
      } catch (stopError) {
        logger.warn("coding session startup clone cleanup failed", {
          event: "coding.session.startup.clone.cleanup.failed",
          sessionId: policy.sessionId,
          phase: startup.phase,
          error: stopError,
        });
      }
    }
    try {
      await sandboxFor(this.env, storedPolicyTier(policy), sandboxId).destroy();
    } catch (destroyError) {
      await this.#registry().startupFailed(
        policy.sessionId, policy.generation ?? 0, sandboxId, error, false);
      await this.#scheduleStartup();
      logger.error("coding session failed sandbox cleanup will retry", {
        event: "coding.session.startup.cleanup.retry", sessionId: policy.sessionId, error: destroyError,
      });
      return;
    }
    await this.#registry().startupFailed(policy.sessionId, policy.generation ?? 0, sandboxId, error, true);
    this.ctx.storage.kv.delete("startup");
  }

  async #advanceStartupOnce(startup: StartupRecord): Promise<void> {
    const policy = this.#policy();
    const sandboxId = required(policy.sandboxId, "startup sandboxId");
    const runtime = codingSessionRuntime(policy.runtime);
    const sandbox = sandboxFor(this.env, storedPolicyTier(this.#policy()), sandboxId) as unknown as StartupSandbox;
    if (startup.phase === "authorize") {
      await this.env.WORKSHOP_TOOLS.prepareSessionStartup(policy.owner, policy.sessionId, policy.repositories);
      await sandbox.configureGitHubAuth(await this.#installationToken(policy.repositories));
      this.#putStartup({
        ...startup,
        phase: "clone",
        nextRepositoryIndex: 0,
        completedRepositoryIndexes: [],
        cloneProcesses: [],
        attempt: 0,
        updatedAt: Date.now(),
      });
      await this.#scheduleStartup(1);
      return;
    }

    if (startup.phase === "clone") {
      await this.#advanceClone(startup, policy.repositories);
      return;
    }

    if (startup.phase === "materialize") {
      const customization = await this.env.WORKSHOP_TOOLS.prepareSessionStartup(
        policy.owner, policy.sessionId, policy.repositories);
      await materializeRuntime(sandbox, this.env, runtime, customization);
      this.#putStartup({ ...startup, phase: "terminal", attempt: 0, updatedAt: Date.now() });
      await this.#scheduleStartup(1);
      return;
    }

    const customization = await this.env.WORKSHOP_TOOLS.prepareSessionStartup(
      policy.owner, policy.sessionId, policy.repositories);
    const terminal = await this.#runningOrCreatedPrimaryTerminal(sandboxId, runtime, policy.repositories, customization);
    const applied = await this.#registry().startupSucceeded(policy.sessionId, policy.generation ?? 0, sandboxId, terminal.id);
    if (!applied) {
      await sandbox.destroy();
      this.ctx.storage.kv.delete("startup");
      return;
    }
    this.ctx.storage.kv.put("primary-terminal-id", terminal.id);
    this.ctx.storage.kv.delete("startup");
    if (policy.developmentIntent) {
      this.ctx.storage.kv.delete("development-cleaned");
      const state = this.ctx.storage.kv.get<DevelopmentSupervisorState>("development-supervision") ??
        createDevelopmentSupervisorState(policy.developmentIntent);
      this.ctx.storage.kv.put("development-supervision", state);
      await this.#registry().developmentUpdated(publicDevelopmentSupervisorUpdate(policy.developmentIntent, state));
      await this.#armPolicyAlarm(Date.now() + 1);
    } else {
      await this.#scheduleNextPolicyAlarm();
    }
  }

  async #advanceClone(startup: StartupRecord, repositories: CodingSessionRepository[]): Promise<void> {
    const sandbox = sandboxFor(this.env, storedPolicyTier(this.#policy()), required(this.#policy().sandboxId, "startup sandboxId")) as unknown as StartupSandbox;
    const completed = new Set(startup.completedRepositoryIndexes ?? []);
    const active: NonNullable<StartupRecord["cloneProcesses"]> = [];
    let nextRepositoryIndex = startup.nextRepositoryIndex;

    for (const clone of startup.cloneProcesses ?? []) {
      if (completed.has(clone.repositoryIndex)) continue;
      const repository = repositories[clone.repositoryIndex];
      if (!repository) throw new Error("Invalid repository clone checkpoint.");
      const process = await sandbox.getProcess(clone.processId);
      if (!process) {
        if (await repositoryReady(sandbox, repository)) {
          completed.add(clone.repositoryIndex);
          continue;
        }
        nextRepositoryIndex = Math.min(nextRepositoryIndex, clone.repositoryIndex);
        continue;
      }
      const status = await process.status();
      if (status.state === "running") {
        active.push(clone);
        continue;
      }
      if (status.state === "error" || status.exit.code !== 0 || !(await repositoryReady(sandbox, repository))) {
        throw new Error(`Failed to clone ${repository}.`);
      }
      completed.add(clone.repositoryIndex);
    }

    while (active.length < STARTUP_CLONE_CONCURRENCY && nextRepositoryIndex < repositories.length) {
      const repositoryIndex = nextRepositoryIndex++;
      if (completed.has(repositoryIndex) || active.some(clone => clone.repositoryIndex === repositoryIndex)) continue;
      const repository = repositories[repositoryIndex]!;
      if (await repositoryReady(sandbox, repository)) {
        completed.add(repositoryIndex);
        continue;
      }
      await waitForOk(await sandbox.exec(["rm", "-rf", `/workspace/${repository}`], { timeout: 30_000 }), 35_000);
      const process = await sandbox.exec([
        "git", "clone", "--depth=1", "--filter=blob:none",
        `${GITHUB_ORIGIN}/totango/${repository}.git`, `/workspace/${repository}`,
      ], { timeout: 120_000 });
      active.push({ repositoryIndex, processId: process.id });
    }

    if (completed.size >= repositories.length) {
      this.#putStartup({
        ...startup,
        phase: "materialize",
        nextRepositoryIndex: repositories.length,
        completedRepositoryIndexes: [...completed].toSorted((a, b) => a - b),
        cloneProcesses: undefined,
        attempt: 0,
        updatedAt: Date.now(),
      });
      await this.#scheduleStartup(1);
      return;
    }

    this.#putStartup({
      ...startup,
      nextRepositoryIndex,
      completedRepositoryIndexes: [...completed].toSorted((a, b) => a - b),
      cloneProcesses: active,
      updatedAt: Date.now(),
    });
    await this.#scheduleStartup();
  }

  async #runningOrCreatedPrimaryTerminal(
    sandboxId: string,
    runtime: CodingSessionRuntime,
    repositories: CodingSessionRepository[],
    customization: OpenCodeUserCustomization,
  ): Promise<Terminal> {
    const sandbox = sandboxFor(this.env, storedPolicyTier(this.#policy()), sandboxId) as unknown as StartupSandbox;
    const options = primaryTerminalOptions(runtime, repositories[0]!, this.env, customization);
    const existing = await matchingRunningTerminals(sandbox, options.command, options.cwd);
    if (existing.length > 0) {
      for (const duplicate of existing.slice(1)) await duplicate.terminate();
      return existing[0]!;
    }
    return sandbox.createTerminal(options);
  }

  async #stopCloneProcesses(startup: StartupRecord): Promise<void> {
    const sandboxId = required(this.#policy().sandboxId, "startup sandboxId");
    const sandbox = sandboxFor(this.env, storedPolicyTier(this.#policy()), sandboxId) as unknown as StartupSandbox;
    await Promise.allSettled((startup.cloneProcesses ?? []).map(async ({ processId }) => {
      const process = await sandbox.getProcess(processId);
      if (process) await process.kill(15);
    }));
  }

  #putStartup(startup: StartupRecord): void {
    this.ctx.storage.kv.put("startup", startup);
  }

  async #withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    let release!: () => void;
    this.#lifecycleTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #scheduleStartup(delayMs = STARTUP_ALARM_DELAY_MS): Promise<void> {
    return this.#armPolicyAlarm(Date.now() + delayMs);
  }

  async #armPolicyAlarm(at: number): Promise<void> {
    const current = this.ctx.storage.kv.get<number>("policy-alarm-at");
    if (current !== undefined && current <= at) return;
    await this.ctx.storage.setAlarm(at);
    this.ctx.storage.kv.put("policy-alarm-at", at);
  }

  async #scheduleNextPolicyAlarm(): Promise<void> {
    const deadlines: number[] = [];
    if (this.ctx.storage.kv.get<StartupRecord>("startup")) deadlines.push(Date.now() + STARTUP_ALARM_DELAY_MS);
    const supervision = this.ctx.storage.kv.get<DevelopmentSupervisorState>("development-supervision");
    if (supervision && !this.ctx.storage.kv.get<boolean>("development-cleaned")) {
      const restartAt = Object.values(supervision.components)
        .map(component => component.restartAfter).filter((value): value is number => value !== undefined);
      deadlines.push(restartAt.length > 0 ? Math.min(...restartAt) : Date.now() + DEVELOPMENT_RECONCILE_INTERVAL_MS);
    }
    const ticket = this.ctx.storage.kv.get<AttachTicket>("ticket");
    if (ticket) deadlines.push(ticket.expiresAt);
    const editorTicket = this.ctx.storage.kv.get<EditorTicket>("editorTicket");
    if (editorTicket) deadlines.push(editorTicket.expiresAt);
    const openCodeTicket = this.ctx.storage.kv.get<OpenCodeTicket>("opencodeTicket");
    if (openCodeTicket) deadlines.push(openCodeTicket.expiresAt);
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.kv.delete("policy-alarm-at");
    } else {
      const next = Math.min(...deadlines);
      await this.ctx.storage.setAlarm(next);
      this.ctx.storage.kv.put("policy-alarm-at", next);
    }
  }

  #registry(): DurableObjectStub<CodingSessionRegistry> {
    return registryFor(this.ctx as unknown as ExecutionContext, this.#policy().owner.userId);
  }
}

/** Per-user registry for coding-session lifecycle and terminal metadata. */
export class CodingSessionRegistry extends DurableObject<Env> {
  readonly #shellTerminalCreations = new Map<string, Promise<string>>();
  readonly #editorProcessCreations = new Map<string, Promise<string>>();
  readonly #opencodeServerProcessCreations = new Map<string, Promise<string>>();

  /** Retries durable restart work and capacity releases after pre-arming the next wakeup. */
  async alarm(): Promise<void> {
    if (this.#hasRegistryWork()) await this.#requireRegistryRetryAlarm();
    for (const [storageKey, evidence] of this.ctx.storage.kv.list<ProductFeedbackEvidenceBundle>({ prefix: "feedback-evidence:" })) {
      if (evidence.expiresAt.valueOf() > Date.now()) continue;
      const id = storageKey.slice("feedback-evidence:".length);
      const job = this.ctx.storage.kv.get<ProductFeedbackJob>(`feedback:${id}`);
      this.ctx.storage.kv.delete(`feedback:${id}`);
      this.ctx.storage.kv.delete(storageKey);
      this.ctx.storage.kv.delete(`feedback-diff:${id}`);
      this.ctx.storage.kv.delete(`feedback-log:${id}`);
      await bestEffortDestroyFeedbackSandbox(this.env, job?.sandboxId ?? `feedback-${id}`);
      await bestEffortDestroyFeedbackSandbox(this.env, job?.publisherSandboxId ?? `feedback-publish-${id}`);
    }
    for (const [, stop] of this.ctx.storage.kv.list<StopRecord>({ prefix: "stop:" })) {
      try {
        await this.#resumeStop(stop);
      } catch (error) {
        logger.warn("coding session stop will retry", {
          event: "coding.session.stop.retry", sessionId: stop.sessionId, error,
        });
      }
    }
    for (const [, start] of this.ctx.storage.kv.list<StartRecord>({ prefix: "start:" })) {
      await this.#resumeStart(start);
    }
    for (const [, restart] of this.ctx.storage.kv.list<RestartRecord>({ prefix: "restart:" })) {
      try {
        await this.#resumeRestart(restart);
      } catch (error) {
        logger.warn("coding session restart will retry", {
          event: "coding.session.restart.retry", sessionId: restart.sessionId, error,
        });
      }
    }
    for (const [storageKey, lease] of this.ctx.storage.kv.list<CapacityReservationKey>({ prefix: "pending-release:" })) {
      try {
        await capacityFor(this.env, lease.tier).release(lease);
        this.ctx.storage.kv.delete(storageKey);
      } catch (error) {
        logger.warn("coding session capacity release will retry", {
          event: "coding.session.capacity.release.retry", sessionId: lease.sessionId, error,
        });
      }
    }
    for (const [, job] of this.ctx.storage.kv.list<ProductFeedbackJob>({ prefix: "feedback:" })) {
      if (["no-safe-fix", "failed"].includes(job.state) || (job.state === "pr-created" && job.stage !== "slack")) continue;
      try {
        await this.#resumeFeedbackJob(job);
      } catch (error) {
        const current = this.ctx.storage.kv.get<ProductFeedbackJob>(`feedback:${job.id}`) ?? job;
        const exhausted = current.attempts >= 2;
        this.ctx.storage.kv.put(`feedback:${job.id}`, {
          ...current,
          state: exhausted ? "failed" : "queued",
          attempts: current.attempts + 1,
          message: exhausted ? boundedError(error) : "Feedback automation will retry.",
          updatedAt: new Date(),
        });
        if (exhausted) {
          await bestEffortDestroyFeedbackSandbox(this.env, current.sandboxId ?? `feedback-${job.id}`);
          await bestEffortDestroyFeedbackSandbox(this.env,
            current.publisherSandboxId ?? `feedback-publish-${job.id}`);
        }
        await this.#scheduleRegistryRetry();
        logger.warn("product feedback job will retry", {
          event: "product.feedback.job.retry", sessionId: job.id, error,
        });
      }
    }
    if (!this.#hasRegistryWork()) {
      const evidenceExpiry = this.#nextFeedbackEvidenceExpiry();
      try {
        if (evidenceExpiry === undefined) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(evidenceExpiry);
      } catch (error) {
        logger.warn("coding session registry alarm could not be updated", {
          event: "coding.session.registry.alarm.update.failed", error,
        });
      }
    }
  }

  /** Lists this user's sessions newest first. */
  async listSessions(): Promise<CodingSessionSummary[]> {
    return [...this.#records()].map(publicSummary)
      .toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /** Plans a development stack from current capacity snapshots without reserving capacity. */
  async preflightSession(request: CreateCodingSessionRequest, userId: string): Promise<CodingSessionDevelopmentPlan> {
    const active = [...this.#records()].filter(record =>
      !record.archivedAt && ["starting", "running", "stopping"].includes(record.status)).length;
    const enabledHeavy = HEAVY_SESSION_TIERS.filter(tier => DEVELOPMENT_CATALOG.enabledTiers.includes(tier));
    const heavy = await Promise.all(enabledHeavy.map(async tier =>
      [tier, await capacityFor(this.env, tier).snapshot(tier, userId)] as const));
    return planDevelopmentStack(DEVELOPMENT_CATALOG, request, {
      "standard-1": { available: active < MAX_SESSIONS_PER_USER, active, limit: MAX_SESSIONS_PER_USER },
      ...Object.fromEntries(heavy),
    });
  }

  /** Returns the separate public-safe lifecycle snapshot persisted for the current generation. */
  getDevelopmentStatus(sessionId: string): CodingSessionDevelopmentStatus {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) throw new Error("Coding session was not found.");
    const status = this.ctx.storage.kv.get<CodingSessionDevelopmentStatus>(`development-status:${sessionId}`);
    if (status && status.generation === storedSessionGeneration(record)) return status;
    return {
      sessionId,
      generation: storedSessionGeneration(record),
      components: [],
      applications: [],
      updatedAt: record.lastActiveAt,
    };
  }

  /** Persists a display-safe component snapshot only when its exact sandbox generation is current. */
  developmentUpdated(update: ReturnType<typeof publicDevelopmentSupervisorUpdate>): boolean {
    const record = this.#get(update.sessionId);
    if (!record || record.archivedAt || record.sandboxId !== update.sandboxId ||
        storedSessionGeneration(record) !== update.generation) return false;
    if (record.status !== "running" && !(record.status === "stopping" &&
        update.components.every(component => component.status === "stopping" || component.status === "stopped"))) return false;
    const status: CodingSessionDevelopmentStatus = {
      sessionId: update.sessionId,
      generation: update.generation,
      components: update.components,
      applications: update.applications,
      updatedAt: new Date(),
    };
    this.ctx.storage.kv.put(`development-status:${update.sessionId}`, status);
    return true;
  }

  /** Rejects application previews until the reviewed preview gateway is available. */
  mintApplicationCapability(sessionId: string, _applicationId: string): CodingSessionApplicationCapability {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) throw new Error("Coding session was not found.");
    throw new Error("Coding session application previews are not available yet.");
  }

  /** Retrieves and reconciles one non-archived session without exposing internal runtime handles. */
  async getSession(sessionId: string): Promise<CodingSessionSummary | undefined> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) return undefined;
    if (record.status === "running") await this.#runningPrimaryTerminal(record);
    return publicSummary(this.#get(sessionId) ?? record);
  }

  /** Retrieves one non-archived session from persisted metadata without contacting its sandbox. */
  getSessionMetadata(sessionId: string): CodingSessionSummary | undefined {
    const record = this.#get(sessionId);
    return record && !record.archivedAt ? publicSummary(record) : undefined;
  }

  /** Returns whether persisted metadata still points at the supplied running sandbox generation. */
  isCurrentSessionGeneration(sessionId: string, sandboxId: string, generation?: number): boolean {
    const record = this.#get(sessionId);
    return !!record && !record.archivedAt && record.status === "running" && record.sandboxId === sandboxId &&
      (generation === undefined || storedSessionGeneration(record) === generation);
  }

  /** Creates and initializes one multi-repository coding session. */
  async createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    _customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    const repositories = validateRepositories(request.repositories);
    const plan = request.developmentStack === undefined ? undefined :
      await this.preflightSession({ ...request, repositories }, owner.userId);
    if (plan && !plan.canCreate) {
      throw new Error(plan.issues[0]?.message ?? "Development stack is unavailable.");
    }
    const durableLifecycle = durableLifecycleEnabled(this.env);
    if (plan && !durableLifecycle) {
      throw new Error("Development sessions require durable lifecycle support.");
    }
    if ([...this.#records()].filter(record =>
      !record.archivedAt && ["starting", "running", "stopping"].includes(record.status)).length >= MAX_SESSIONS_PER_USER) {
      throw new Error(`A user may have at most ${MAX_SESSIONS_PER_USER} active coding sessions.`);
    }
    const title = request.title.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new Error(`Session title must be between 1 and ${MAX_TITLE_LENGTH} characters.`);
    }
    const runtime = codingSessionRuntime(request.runtime);
    assertRuntimeConfigured(this.env, runtime);

    const id = crypto.randomUUID();
    const sandboxId = id;
    const generation = plan ? 1 : 0;
    const instanceTier = plan?.selectedTier ?? "standard-1";
    const developmentIntent = plan ? createDevelopmentGenerationIntent(
      DEVELOPMENT_CATALOG, plan, { sessionId: id, sandboxId, generation },
    ) : undefined;
    let capacityLease: CapacityReservationKey | undefined;
    if (isHeavyTier(instanceTier)) {
      const key: CapacityReservationKey = {
        tier: instanceTier, reservationId: crypto.randomUUID(), sessionId: id,
        generation, sandboxId, userId: owner.userId,
      };
      capacityLease = capacityKey(await capacityFor(this.env, instanceTier).reserve(key));
    }
    const now = new Date();
    let record: SessionRecord = {
      id,
      title,
      repositories,
      runtime: runtime === "prime-agent" ? "pi" : runtime,
      primeAgent: runtime === "prime-agent" ? true : undefined,
      status: "starting",
      createdAt: now,
      lastActiveAt: now,
      sandboxId,
      ...(plan ? {
        generation,
        instanceTier,
        development: {
          catalogRevision: plan.catalogRevision,
          ...(plan.selection.profileId ? { profileId: plan.selection.profileId } : {}),
          componentIds: plan.resolvedComponentIds,
          instanceTier,
        },
      } : {}),
      ...(capacityLease ? { capacityLease } : {}),
    };
    if (!durableLifecycle) {
      this.#put(record);
      try {
        await this.#scheduleStart(record, owner);
        logger.info("coding session startup scheduled", {
          event: "coding.session.start.scheduled", sessionId: id, userId: owner.userId,
          repositoryCount: repositories.length,
        });
      } catch (error) {
        try {
          await sandboxFor(this.env, storedSessionTier(record), record.sandboxId).destroy();
          if (record.capacityLease) {
            this.ctx.storage.kv.put(`pending-release:${record.capacityLease.reservationId}`, record.capacityLease);
            const lease = record.capacityLease;
            record = { ...record, capacityLease: undefined };
            this.#put(record);
            await this.#releaseCapacity(lease);
          }
        } catch {
          // Retain an exact heavy lease when destruction may be incomplete.
        }
        record = {
          ...record, status: record.capacityLease ? "stopping" : "failed",
          error: boundedError(error), lastActiveAt: new Date(),
        };
        this.#put(record);
        logger.error("coding session startup could not be scheduled", {
          event: "coding.session.start.schedule.failed", sessionId: id, userId: owner.userId, error,
        });
      }
      return publicSummary(record);
    }

    try {
      await this.#beginStart(record, owner, developmentIntent);
      record = this.#get(id) ?? record;
      logger.info("coding session startup scheduled", {
        event: "coding.session.start.scheduled",
        sessionId: id,
        userId: owner.userId,
        repositoryCount: repositories.length,
      });
    } catch (error) {
      record = {
        ...record,
        status: "stopping",
        error: "Coding session startup could not be scheduled.",
        lastActiveAt: new Date(),
      };
      const stop: StopRecord = {
        sessionId: record.id,
        sandboxId: record.sandboxId,
        generation: storedSessionGeneration(record),
        instanceTier: storedSessionTier(record),
        ...(record.capacityLease ? { lease: record.capacityLease } : {}),
        ...(record.development?.componentIds.length ? { development: true as const } : {}),
        phase: "destroy",
      };
      await this.#requireRegistryRetryAlarm();
      this.ctx.storage.transactionSync(() => {
        this.#put(record);
        this.ctx.storage.kv.put(`stop:${record.id}`, stop);
      });
      this.#setDevelopmentLifecycle(record, "stopping");
      try {
        await this.#resumeStop(stop);
        record = this.#get(record.id) ?? record;
      } catch (stopError) {
        logger.warn("coding session startup cleanup will retry", {
          event: "coding.session.start.cleanup.retry", sessionId: record.id, error: stopError,
        });
      }
      logger.error("coding session startup could not be scheduled", {
        event: "coding.session.start.schedule.failed",
        sessionId: id,
        userId: owner.userId,
        error,
      });
    }
    return publicSummary(record);
  }

  /** Destroys and rebuilds one session from its authorized repositories. */
  async restartSession(
    sessionId: string,
    owner: CodingSessionOwner,
    _customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    const record = this.#get(sessionId);
    if (!record || record.archivedAt) throw new Error("Coding session was not found.");
    if (record.status === "starting" || record.status === "stopping") {
      throw new Error("Coding session is already changing state.");
    }
    assertRuntimeConfigured(this.env, storedSessionRuntime(record));
    if (record.development?.componentIds.length &&
        !(await policyForSandbox(this.env, storedSessionTier(record), record.sandboxId).hasDevelopmentIntent(
          record.id, storedSessionGeneration(record), record.sandboxId,
        ))) {
      throw new Error("Development restart requires a new session.");
    }
    const reactivating = record.status === "stopped" || record.status === "failed";
    if (reactivating) this.#assertActiveSessionLimit(sessionId);
    const instanceTier = storedSessionTier(record);
    const newSandboxId = crypto.randomUUID();
    const newGeneration = record.development ? storedSessionGeneration(record) + 1 : 0;
    let freshLease: CapacityReservationKey | undefined;
    if (isHeavyTier(instanceTier) && !record.capacityLease) {
      if (record.status !== "stopped" && record.status !== "failed") {
        throw new Error("Heavy coding session has no capacity lease.");
      }
      const requested: CapacityReservationKey = {
        tier: instanceTier,
        reservationId: crypto.randomUUID(),
        sessionId,
        generation: newGeneration,
        sandboxId: newSandboxId,
        userId: owner.userId,
      };
      const reserved = await capacityFor(this.env, instanceTier).reserve(requested);
      if (!sameCapacityKey(requested, reserved)) {
        await this.#releaseCapacity(requested);
        throw new Error("Capacity reservation returned a different reservation.");
      }
      freshLease = capacityKey(reserved);
      try {
        if (!this.#isRestartSourceCurrent(record)) throw new Error("Coding session restart was cancelled.");
        this.#assertActiveSessionLimit(sessionId);
      } catch (error) {
        await this.#releaseCapacity(freshLease);
        throw error;
      }
    }
    const stopping: SessionRecord = {
      ...record,
      status: "stopping",
      error: undefined,
      terminalId: undefined,
      shellTerminalId: undefined,
      editorProcessId: undefined,
      opencodeServerProcessId: undefined,
      opencodeServerVersion: undefined,
      lastActiveAt: new Date(),
    };
    const restart: RestartRecord = {
      sessionId,
      owner,
      oldSandboxId: record.sandboxId,
      oldGeneration: storedSessionGeneration(record),
      instanceTier,
      ...(record.capacityLease ? {
        oldLease: record.capacityLease,
        replacement: { reservationId: crypto.randomUUID(), generation: newGeneration, sandboxId: newSandboxId },
      } : {}),
      ...(freshLease ? { newLease: freshLease } : {}),
      newSandboxId,
      newGeneration,
      ...(record.development?.componentIds.length ? { development: true as const } : {}),
      phase: record.development?.componentIds.length ? "prepare" : "destroy",
    };
    // Arm recovery while the old record is still exact. A crash before the transaction leaves only
    // a harmless empty alarm; a crash after it leaves durable, wakeable restart work.
    try {
      await this.#requireRegistryRetryAlarm();
      if (!this.#isRestartSourceCurrent(record)) throw new Error("Coding session restart was cancelled.");
      this.ctx.storage.transactionSync(() => {
        if (!this.#isRestartSourceCurrent(record)) throw new Error("Coding session restart was cancelled.");
        if (reactivating) this.#assertActiveSessionLimit(sessionId);
        this.#put(stopping);
        this.ctx.storage.kv.put(`restart:${sessionId}`, restart);
      });
    } catch (error) {
      if (freshLease) await this.#releaseCapacity(freshLease);
      throw error;
    }
    try {
      await this.#resumeRestart(restart);
    } catch (error) {
      logger.warn("coding session restart will retry", {
        event: "coding.session.restart.retry", sessionId, userId: owner.userId, error,
      });
    }
    return publicSummary(this.#get(sessionId) ?? stopping);
  }

  /** Starts or resumes durable cleanup, destroy, release, and finalize phases for one session. */
  async stopSession(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    if (!record) return;
    if (this.ctx.storage.kv.get<RestartRecord>(`restart:${sessionId}`)) {
      throw new Error("Coding session is already changing state.");
    }
    const existing = this.ctx.storage.kv.get<StopRecord>(`stop:${sessionId}`);
    if (existing) {
      await this.#resumeStop(existing);
      return;
    }
    const existingStart = this.ctx.storage.kv.get<StartRecord>(`start:${sessionId}`);
    if (record.status === "stopped" && !existingStart) return;
    if (!durableLifecycleEnabled(this.env) && !existingStart && !record.development) {
      const stopping: SessionRecord = { ...record, status: "stopping", lastActiveAt: new Date() };
      this.#put(stopping);
      if (record.status === "starting") {
        try {
          await policyForSandbox(this.env, storedSessionTier(record), record.sandboxId).cancelSessionStartup(
            record.id, storedSessionGeneration(record), record.sandboxId,
          );
        } catch (error) {
          logger.warn("coding session startup cancellation failed", {
            event: "coding.session.startup.cancel.failed", sessionId, error,
          });
        }
      }
      try {
        await sandboxFor(this.env, storedSessionTier(record), record.sandboxId).destroy();
        if (record.capacityLease) await this.#releaseCapacity(record.capacityLease);
      } catch (error) {
        const current = this.#get(sessionId);
        if (current?.sandboxId === record.sandboxId && current.status === "stopping") {
          this.#put({
            ...stopping, status: record.capacityLease ? "stopping" : "failed",
            error: boundedError(error), lastActiveAt: new Date(),
          });
        }
        logger.error("coding session failed to stop", {
          event: "coding.session.stop.failed", sessionId, error,
        });
        throw error;
      }
      this.#put({
        ...record, status: "stopped", terminalId: undefined, shellTerminalId: undefined,
        editorProcessId: undefined, opencodeServerProcessId: undefined, opencodeServerVersion: undefined,
        capacityLease: undefined, lastActiveAt: new Date(),
      });
      return;
    }
    const operation: StopRecord = {
      sessionId,
      sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      ...(record.capacityLease ? { lease: record.capacityLease } : {}),
      ...(record.development?.componentIds.length ? { development: true as const } : {}),
      phase: "cancel",
    };
    await this.#requireRegistryRetryAlarm();
    this.ctx.storage.transactionSync(() => {
      const current = this.#get(sessionId);
      if (!current || current.sandboxId !== record.sandboxId ||
          storedSessionGeneration(current) !== storedSessionGeneration(record)) {
        throw new Error("Coding session stop was cancelled.");
      }
      this.#put({ ...current, status: "stopping", lastActiveAt: new Date() });
      this.ctx.storage.kv.delete(`start:${sessionId}`);
      this.ctx.storage.kv.put(`stop:${sessionId}`, operation);
    });
    await this.#resumeStop(operation);
  }

  /** Stops and hides a session from the default session list. */
  async archiveSession(sessionId: string): Promise<void> {
    const record = this.#get(sessionId);
    if (!record) return;
    if (this.ctx.storage.kv.get<RestartRecord>(`restart:${sessionId}`)) {
      throw new Error("Coding session is already changing state.");
    }
    if (record.archivedAt) return;
    if (record.status !== "stopped") await this.stopSession(sessionId);
    const stopped = this.#get(sessionId) ?? record;
    this.#put({
      ...stopped,
      status: "stopped",
      terminalId: undefined,
      shellTerminalId: undefined,
      editorProcessId: undefined,
      opencodeServerProcessId: undefined,
      opencodeServerVersion: undefined,
      archivedAt: new Date(),
      lastActiveAt: new Date(),
    });
  }

  /** Mints one single-use terminal attachment URL. */
  async mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    terminal: CodingSessionTerminalKind = "opencode",
  ): Promise<CodingSessionAttachCapability> {
    const record = this.#get(sessionId);
    if (!record || record.status !== "running" || !record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    if (terminal !== "opencode" && terminal !== "shell") throw new Error("Invalid terminal type.");
    const sandbox = sandboxFor(this.env, storedSessionTier(record), record.sandboxId);
    const primary = await this.#runningPrimaryTerminal(record);
    if (!primary) throw new Error("Coding session environment expired. Restart the session to continue.");
    await policyForSandbox(this.env, storedSessionTier(record), record.sandboxId).configure({
      sessionId: record.id,
      sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      owner,
      repositories: record.repositories,
    });
    let terminalId = record.terminalId;
    const generationKey = sessionGenerationKey(record);
    if (terminal === "shell") {
      let shell = record.shellTerminalId ? await sandbox.getTerminal(record.shellTerminalId) : undefined;
      if (!shell) {
        let creation = this.#shellTerminalCreations.get(generationKey);
        if (!creation) {
          creation = sandbox.createTerminal({
            command: ["/bin/bash", "-l"],
            cwd: `/workspace/${record.repositories[0]}`,
            cols: 120,
            rows: 40,
            bufferSize: TERMINAL_REPLAY_BUFFER_SIZE,
          }).then(created => created.id);
          this.#shellTerminalCreations.set(generationKey, creation);
        }
        try {
          terminalId = await creation;
        } finally {
          if (this.#shellTerminalCreations.get(generationKey) === creation) {
            this.#shellTerminalCreations.delete(generationKey);
          }
        }
      } else {
        terminalId = shell.id;
      }
    }
    const current = this.#get(sessionId);
    if (!current || current.status !== "running" ||
        storedSessionGeneration(current) !== storedSessionGeneration(record) ||
        current.sandboxId !== record.sandboxId || current.terminalId !== record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const updated = terminal === "shell" ? { ...current, shellTerminalId: terminalId } : current;
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ATTACH_TTL_MS);
    await (await ticketFor(this.env, token)).storeTicket({
      sandboxId: record.sandboxId,
      terminalId,
      userId: owner.userId,
      sessionId: record.id,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      terminalKind: terminal,
      expiresAt: expiresAt.valueOf(),
    });
    const latest = this.#get(sessionId);
    if (!latest || latest.status !== "running" ||
        storedSessionGeneration(latest) !== storedSessionGeneration(record) ||
        latest.sandboxId !== record.sandboxId || latest.terminalId !== record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    this.#put({
      ...latest,
      ...(terminal === "shell" ? { shellTerminalId: updated.shellTerminalId } : {}),
      lastActiveAt: new Date(),
    });
    const baseUrl = this.env.BASE_URL?.replace(/\/$/, "") ?? "/gatekeeper/sessions";
    return { url: `${baseUrl}/attach/${token}`, expiresAt };
  }

  /** Starts browser VS Code if needed and mints a capability bound to this sandbox generation. */
  async mintEditorCapability(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionEditorCapability> {
    const baseUrl = requiredEditorBaseUrl(this.env.EDITOR_BASE_URL);
    required(this.env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET");
    const record = this.#get(sessionId);
    if (!record || record.status !== "running" || !record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const generationKey = sessionGenerationKey(record);
    const sandbox = sandboxFor(this.env, storedSessionTier(record), record.sandboxId);
    if (!(await this.#runningPrimaryTerminal(record))) {
      throw new Error("Coding session environment expired. Restart the session to continue.");
    }
    await policyForSandbox(this.env, storedSessionTier(record), record.sandboxId).configure({
      sessionId: record.id,
      sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      owner,
      repositories: record.repositories,
    });

    let creation = this.#editorProcessCreations.get(generationKey);
    if (!creation) {
      creation = (async () => {
        const persistedProcessId = record.editorProcessId;
        const existing = persistedProcessId ? await sandbox.getProcess(persistedProcessId) : null;
        const existingStatus = existing ? await existing.status() : null;
        if (persistedProcessId && existing && existingStatus?.state === "running") {
          return persistedProcessId;
        }
        const userDataDir = "/workspace/.odie-code-server/user-data";
        await sandbox.mkdir(`${userDataDir}/User`, { recursive: true });
        await sandbox.writeFile(`${userDataDir}/User/settings.json`, JSON.stringify({
          "extensions.autoCheckUpdates": false,
          "extensions.autoUpdate": false,
          "telemetry.telemetryLevel": "off",
          "update.mode": "none",
        }));
        const process = await sandbox.exec([
          "code-server",
          "--bind-addr", `0.0.0.0:${EDITOR_PORT}`,
          "--auth", "none",
          "--disable-telemetry",
          "--disable-update-check",
          "--disable-workspace-trust",
          "--extensions-dir", "/opt/odie-code-server/extensions",
          "--user-data-dir", userDataDir,
          "/workspace",
        ], {
          cwd: "/workspace",
          env: {
            CS_DISABLE_GETTING_STARTED_OVERRIDE: "1",
            EXTENSIONS_GALLERY: "{}",
            VSCODE_PROXY_URI: "./proxy/{{port}}",
          },
        });
        try {
          await process.waitForPort(EDITOR_PORT, {
            mode: "http", path: "/", status: { min: 200, max: 399 }, timeout: 30_000,
          });
        } catch (error) {
          if (!(await stopProcess(process))) {
            await sandbox.destroy().catch(() => undefined);
            this.markTerminalUnavailable(
              sessionId,
              record.sandboxId,
              record.terminalId,
              "Browser VS Code failed to stop. Restart the session to continue.",
              storedSessionGeneration(record),
            );
          }
          throw error;
        }
        const stillRunning = this.#get(sessionId);
        if (!stillRunning || stillRunning.status !== "running" ||
            storedSessionGeneration(stillRunning) !== storedSessionGeneration(record) ||
            stillRunning.sandboxId !== record.sandboxId) {
          await stopProcess(process);
          throw new Error("Coding session is not running.");
        }
        this.#put({ ...stillRunning, editorProcessId: process.id });
        return process.id;
      })();
      this.#editorProcessCreations.set(generationKey, creation);
    }
    let processId: string;
    try {
      processId = await creation;
    } finally {
      if (this.#editorProcessCreations.get(generationKey) === creation) {
        this.#editorProcessCreations.delete(generationKey);
      }
    }

    const current = this.#get(sessionId);
    if (!current || current.status !== "running" || storedSessionGeneration(current) !== storedSessionGeneration(record) ||
        current.sandboxId !== record.sandboxId) {
      throw new Error("Coding session is not running.");
    }
    const token = await editorCapabilityToken(this.env);
    const expiresAt = new Date(Date.now() + EDITOR_CAPABILITY_TTL_MS);
    await (await editorTicketFor(this.env, token)).storeEditorTicket({
      sandboxId: record.sandboxId,
      userId: owner.userId,
      sessionId: record.id,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      expiresAt: expiresAt.valueOf(),
    });
    const latest = this.#get(sessionId);
    if (!latest || latest.status !== "running" || storedSessionGeneration(latest) !== storedSessionGeneration(record) ||
        latest.sandboxId !== record.sandboxId) {
      throw new Error("Coding session is not running.");
    }
    this.#put({ ...latest, editorProcessId: processId, lastActiveAt: new Date() });
    return { url: `${baseUrl}/c/${token}/`, expiresAt };
  }

  /** Starts OpenCode's HTTP server if needed and mints a same-origin generation-bound capability. */
  async mintOpenCodeCapability(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionOpenCodeCapability> {
    required(this.env.BASE_URL, "BASE_URL");
    required(this.env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET");
    const record = this.#get(sessionId);
    if (!record || record.status !== "running" || !record.terminalId || storedSessionRuntime(record) !== "opencode") {
      throw new Error("Coding session is not running.");
    }
    const sandbox = sandboxFor(this.env, storedSessionTier(record), record.sandboxId);
    if (!(await this.#runningPrimaryTerminal(record))) {
      throw new Error("Coding session environment expired. Restart the session to continue.");
    }
    const customization = await this.env.WORKSHOP_TOOLS.prepareSessionStartup(owner, record.id, record.repositories);
    await policyForSandbox(this.env, storedSessionTier(record), record.sandboxId).configure({
      sessionId: record.id,
      sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      owner,
      repositories: record.repositories,
    });

    const generationKey = sessionGenerationKey(record);
    let creation = this.#opencodeServerProcessCreations.get(generationKey);
    if (!creation) {
      creation = this.#runningOrCreatedOpenCodeServer(record, customization);
      this.#opencodeServerProcessCreations.set(generationKey, creation);
    }
    let processId: string;
    try {
      processId = await creation;
    } finally {
      if (this.#opencodeServerProcessCreations.get(generationKey) === creation) {
        this.#opencodeServerProcessCreations.delete(generationKey);
      }
    }

    const current = this.#get(sessionId);
    if (!current || current.status !== "running" || current.sandboxId !== record.sandboxId ||
        storedSessionGeneration(current) !== storedSessionGeneration(record) || current.terminalId !== record.terminalId) {
      const stale = await sandbox.getProcess(processId).catch(() => null);
      if (stale) await stopProcess(stale);
      throw new Error("Coding session is not running.");
    }
    const expiresAt = new Date(Date.now() + OPENCODE_SERVER_CAPABILITY_TTL_MS);
    const token = await openCodeCapabilityToken(this.env, {
      userId: owner.userId,
      sessionId: record.id,
      sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      expiresAt: expiresAt.valueOf(),
    });
    await (await openCodeTicketFor(this.env, token)).storeOpenCodeTicket({
      sandboxId: record.sandboxId,
      userId: owner.userId,
      sessionId: record.id,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      expiresAt: expiresAt.valueOf(),
    });
    const latest = this.#get(sessionId);
    if (!latest || latest.status !== "running" || latest.sandboxId !== record.sandboxId ||
        storedSessionGeneration(latest) !== storedSessionGeneration(record) || latest.terminalId !== record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const baseUrl = this.env.BASE_URL!.replace(/\/$/, "");
    this.#put({ ...latest, opencodeServerProcessId: processId, lastActiveAt: new Date() });
    return { url: `${baseUrl}/opencode/${token}/`, expiresAt };
  }

  async #runningOrCreatedOpenCodeServer(
    record: SessionRecord,
    customization: OpenCodeUserCustomization,
  ): Promise<string> {
    const sandbox = sandboxFor(this.env, storedSessionTier(record), record.sandboxId);
    const persistedProcessId = record.opencodeServerProcessId;
    const existing = persistedProcessId ? await sandbox.getProcess(persistedProcessId) : null;
    const existingStatus = existing ? await existing.status() : null;
    if (persistedProcessId && existing && existingStatus?.state === "running" &&
        record.opencodeServerVersion === OPENCODE_SERVER_VERSION) return persistedProcessId;
    if (existing && existingStatus?.state === "running" && !(await stopProcess(existing))) {
      await sandbox.destroy().catch(() => undefined);
      this.markTerminalUnavailable(
        record.id,
        record.sandboxId,
        record.terminalId,
        "OpenCode server failed to stop. Restart the session to continue.",
        storedSessionGeneration(record),
      );
      throw new Error("OpenCode server failed to stop. Restart the session to continue.");
    }
    const process = await sandbox.exec([
      "opencode", "serve",
      "--hostname", "0.0.0.0",
      "--port", String(OPENCODE_SERVER_PORT),
      "--mdns", "false",
    ], {
      cwd: `/workspace/${record.repositories[0]}`,
      env: opencodeEnvironment(this.env, customization),
    });
    try {
      await process.waitForPort(OPENCODE_SERVER_PORT, {
        mode: "http", path: "/global/health", status: { min: 200, max: 399 }, timeout: 30_000,
      });
    } catch (error) {
      if (!(await stopProcess(process))) {
        await sandbox.destroy().catch(() => undefined);
        this.markTerminalUnavailable(
          record.id,
          record.sandboxId,
          record.terminalId,
          "OpenCode server failed to stop. Restart the session to continue.",
          storedSessionGeneration(record),
        );
      }
      throw error;
    }
    const current = this.#get(record.id);
    if (!current || current.status !== "running" || current.sandboxId !== record.sandboxId ||
        storedSessionGeneration(current) !== storedSessionGeneration(record)) {
      await stopProcess(process);
      throw new Error("Coding session is not running.");
    }
    this.#put({ ...current, opencodeServerProcessId: process.id, opencodeServerVersion: OPENCODE_SERVER_VERSION });
    return process.id;
  }

  /** Writes one validated file into this running session's private upload directory. */
  async uploadFile(
    owner: CodingSessionOwner,
    request: CodingSessionFileUploadRequest,
  ): Promise<CodingSessionFileUploadResult> {
    const upload = validateCodingSessionFileUploadRequest(request);
    const record = this.#get(upload.sessionId);
    if (!record || record.status !== "running" || !record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    if (!(await this.#runningPrimaryTerminal(record))) {
      throw new Error("Coding session environment expired. Restart the session to continue.");
    }
    await policyForSandbox(this.env, storedSessionTier(record), record.sandboxId).configure({
      sessionId: record.id,
      sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record),
      instanceTier: storedSessionTier(record),
      owner,
      repositories: record.repositories,
    });

    const current = this.#get(upload.sessionId);
    if (!current || current.status !== "running" || current.sandboxId !== record.sandboxId ||
        storedSessionGeneration(current) !== storedSessionGeneration(record) || current.terminalId !== record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    const sandbox = sandboxFor(this.env, storedSessionTier(record), record.sandboxId) as unknown as StartupSandbox;
    const path = `${UPLOAD_DIR}/${crypto.randomUUID()}-${upload.filename}`;
    await sandbox.mkdir(UPLOAD_DIR, { recursive: true });
    await sandbox.writeFile(path, bytesToStream(upload.content));
    const latest = this.#get(upload.sessionId);
    if (!latest || latest.status !== "running" || latest.sandboxId !== record.sandboxId ||
        storedSessionGeneration(latest) !== storedSessionGeneration(record) || latest.terminalId !== record.terminalId) {
      throw new Error("Coding session is not running.");
    }
    this.#put({ ...latest, lastActiveAt: new Date() });
    return { filename: upload.filename, path, bytesWritten: upload.content.byteLength };
  }

  /** Records that the persisted primary terminal can no longer serve this session. */
  markTerminalUnavailable(
    sessionId: string, sandboxId: string, terminalId: string | undefined, reason: string, generation = 0,
  ): void {
    const record = this.#get(sessionId);
    if (!record || storedSessionGeneration(record) !== generation || record.sandboxId !== sandboxId ||
        terminalId !== undefined && record.terminalId !== terminalId || record.status !== "running") return;
    this.#put({
      ...record,
      status: "failed",
      terminalId: undefined,
      shellTerminalId: undefined,
      editorProcessId: undefined,
      opencodeServerProcessId: undefined,
      opencodeServerVersion: undefined,
      error: reason,
      lastActiveAt: new Date(),
    });
  }

  async #runningPrimaryTerminal(record: SessionRecord): Promise<Terminal | undefined> {
    const terminalId = record.terminalId;
    if (!terminalId) {
      this.markTerminalUnavailable(record.id, record.sandboxId, undefined, "Coding session environment expired. Restart the session to continue.", storedSessionGeneration(record));
      return undefined;
    }
    const terminal = await sandboxFor(this.env, storedSessionTier(record), record.sandboxId).getTerminal(terminalId);
    if (!terminal) {
      this.markTerminalUnavailable(record.id, record.sandboxId, terminalId, "Coding session environment expired. Restart the session to continue.", storedSessionGeneration(record));
      return undefined;
    }
    const snapshot = await terminal.getSnapshot();
    if (snapshot.status !== "running") {
      this.markTerminalUnavailable(record.id, record.sandboxId, terminalId, "Coding session terminal exited. Restart the session to continue.", storedSessionGeneration(record));
      return undefined;
    }
    return terminal;
  }

  *#records(): Generator<SessionRecord> {
    for (const [, record] of this.ctx.storage.kv.list<SessionRecord>({ prefix: "session:" })) yield record;
  }

  #get(id: string): SessionRecord | undefined {
    return this.ctx.storage.kv.get<SessionRecord>(`session:${id}`);
  }

  #put(record: SessionRecord): void {
    this.ctx.storage.kv.put(`session:${record.id}`, record);
  }

  #setDevelopmentLifecycle(
    record: SessionRecord,
    status: CodingSessionDevelopmentStatus["components"][number]["status"],
    message?: string,
  ): void {
    if (!record.development) return;
    const previous = this.ctx.storage.kv.get<CodingSessionDevelopmentStatus>(`development-status:${record.id}`);
    if (!previous) return;
    const now = new Date();
    this.ctx.storage.kv.put(`development-status:${record.id}`, {
      sessionId: record.id,
      generation: storedSessionGeneration(record),
      components: previous.components.map(component => ({
        ...component, status, updatedAt: now, message,
      })),
      applications: previous.applications.map(application => ({
        ...application, status, message, previewAvailable: false,
      })),
      updatedAt: now,
    });
  }

  #isRestartSourceCurrent(source: SessionRecord): boolean {
    const current = this.#get(source.id);
    if (!current || current.archivedAt || current.status !== source.status ||
        current.sandboxId !== source.sandboxId ||
        storedSessionGeneration(current) !== storedSessionGeneration(source)) return false;
    if (!current.capacityLease || !source.capacityLease) return current.capacityLease === source.capacityLease;
    return sameCapacityKey(source.capacityLease, current.capacityLease as CapacityReservationRecord);
  }

  #assertActiveSessionLimit(excludedSessionId: string): void {
    const active = [...this.#records()].filter(record => record.id !== excludedSessionId &&
      !record.archivedAt && ["starting", "running", "stopping"].includes(record.status)).length;
    if (active >= MAX_SESSIONS_PER_USER) {
      throw new Error(`A user may have at most ${MAX_SESSIONS_PER_USER} active coding sessions.`);
    }
  }

  async #scheduleStart(record: SessionRecord, owner: CodingSessionOwner): Promise<void> {
    const runtime = storedSessionRuntime(record);
    assertRuntimeConfigured(this.env, runtime);
    const policy = policyForSandbox(this.env, storedSessionTier(record), record.sandboxId);
    await policy.configure({
      sessionId: record.id, sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record), instanceTier: storedSessionTier(record),
      runtime, owner, repositories: record.repositories,
    });
    const now = Date.now();
    await policy.startSessionStartup({
      generation: storedSessionGeneration(record), phase: "authorize", nextRepositoryIndex: 0,
      attempt: 0, createdAt: now, updatedAt: now,
    });
  }

  async #beginStart(
    record: SessionRecord,
    owner: CodingSessionOwner,
    developmentIntent?: DevelopmentGenerationIntent,
  ): Promise<void> {
    const start: StartRecord = {
      sessionId: record.id, owner, sandboxId: record.sandboxId,
      generation: storedSessionGeneration(record), attempts: 0, phase: "configure",
      ...(developmentIntent ? { developmentIntent } : {}),
    };
    await this.#requireRegistryRetryAlarm();
    this.ctx.storage.transactionSync(() => {
      this.#put(record);
      this.ctx.storage.kv.put(`start:${record.id}`, start);
      if (developmentIntent) {
        const initial = createDevelopmentSupervisorState(developmentIntent, record.createdAt.valueOf());
        this.ctx.storage.kv.put(`development-status:${record.id}`, publicStatusFromSupervisor(developmentIntent, initial));
      }
    });
    await this.#resumeStart(start);
  }

  async #resumeStart(start: StartRecord): Promise<void> {
    let operation = this.ctx.storage.kv.get<StartRecord>(`start:${start.sessionId}`) ?? start;
    try {
      const record = this.#get(operation.sessionId);
      if (!record || record.status !== "starting" || record.sandboxId !== operation.sandboxId ||
          storedSessionGeneration(record) !== operation.generation) {
        this.ctx.storage.kv.delete(`start:${operation.sessionId}`);
        return;
      }
      const policy = policyForSandbox(this.env, storedSessionTier(record), record.sandboxId);
      if (operation.phase === "configure") {
        const runtime = storedSessionRuntime(record);
        assertRuntimeConfigured(this.env, runtime);
        await policy.configure({
          sessionId: record.id, sandboxId: record.sandboxId,
          generation: storedSessionGeneration(record), instanceTier: storedSessionTier(record),
          runtime, owner: operation.owner, repositories: record.repositories,
          ...(operation.developmentIntent ? { developmentIntent: operation.developmentIntent } : {}),
        });
        const persisted = this.ctx.storage.kv.get<StartRecord>(`start:${operation.sessionId}`);
        const current = this.#get(operation.sessionId);
        if (!persisted || !current || current.status !== "starting" ||
            current.sandboxId !== operation.sandboxId || storedSessionGeneration(current) !== operation.generation) return;
        operation = { ...persisted, phase: "schedule" };
        delete operation.developmentIntent;
        this.ctx.storage.kv.put(`start:${operation.sessionId}`, operation);
      }
      const now = Date.now();
      await policy.startSessionStartup({
        generation: operation.generation, phase: "authorize", nextRepositoryIndex: 0,
        attempt: 0, createdAt: now, updatedAt: now,
      });
      this.ctx.storage.kv.delete(`start:${operation.sessionId}`);
    } catch (error) {
      const persisted = this.ctx.storage.kv.get<StartRecord>(`start:${operation.sessionId}`);
      const current = this.#get(operation.sessionId);
      if (!persisted || !current || current.status !== "starting" || current.sandboxId !== operation.sandboxId ||
          storedSessionGeneration(current) !== operation.generation) return;
      operation = persisted;
      const attempts = operation.attempts + 1;
      if (attempts < STARTUP_MAX_ATTEMPTS) {
        this.ctx.storage.kv.put(`start:${operation.sessionId}`, { ...operation, attempts });
        logger.warn("coding session durable start will retry", {
          event: "coding.session.start.retry", sessionId: operation.sessionId, reason: `attempt-${attempts}`, error,
        });
        return;
      }
      logger.error("coding session durable start exhausted", {
        event: "coding.session.start.exhausted", sessionId: operation.sessionId, reason: `attempt-${attempts}`, error,
      });
      const record = this.#get(operation.sessionId);
      if (!record || record.sandboxId !== operation.sandboxId || record.status !== "starting") {
        this.ctx.storage.kv.delete(`start:${operation.sessionId}`);
        return;
      }
      const stopping = { ...record, status: "stopping" as const,
        error: "Coding session startup could not be scheduled.", lastActiveAt: new Date() };
      const stop: StopRecord = {
        sessionId: record.id, sandboxId: record.sandboxId, generation: operation.generation,
        instanceTier: storedSessionTier(record), ...(record.capacityLease ? { lease: record.capacityLease } : {}),
        ...(record.development?.componentIds.length ? { development: true as const } : {}), phase: "cancel",
      };
      this.ctx.storage.transactionSync(() => {
        this.#put(stopping);
        this.ctx.storage.kv.delete(`start:${operation.sessionId}`);
        this.ctx.storage.kv.put(`stop:${operation.sessionId}`, stop);
      });
      this.#setDevelopmentLifecycle(stopping, "stopping");
    }
  }

  async #resumeStop(stop: StopRecord): Promise<void> {
    let operation = this.ctx.storage.kv.get<StopRecord>(`stop:${stop.sessionId}`) ?? stop;
    if (operation.phase === "cancel") {
      await policyForSandbox(this.env, operation.instanceTier, operation.sandboxId).cancelSessionStartup(
        operation.sessionId, operation.generation, operation.sandboxId,
      );
      operation = { ...operation, phase: "cleanup" };
      this.ctx.storage.kv.put(`stop:${operation.sessionId}`, operation);
    }
    if (operation.phase === "cleanup") {
      if (operation.development) await policyForSandbox(this.env, operation.instanceTier, operation.sandboxId).cleanupDevelopment(
        operation.sessionId, operation.generation, operation.sandboxId,
      );
      operation = { ...operation, phase: "destroy" };
      this.ctx.storage.kv.put(`stop:${operation.sessionId}`, operation);
    }
    if (operation.phase === "destroy") {
      await sandboxFor(this.env, operation.instanceTier, operation.sandboxId).destroy();
      operation = { ...operation, phase: "release" };
      this.ctx.storage.kv.put(`stop:${operation.sessionId}`, operation);
    }
    if (operation.phase === "release") {
      if (operation.lease) await capacityFor(this.env, operation.lease.tier).release(operation.lease);
      operation = { ...operation, phase: "finalize" };
      this.ctx.storage.kv.put(`stop:${operation.sessionId}`, operation);
    }
    const current = this.#get(operation.sessionId);
    if (current && current.sandboxId === operation.sandboxId &&
        storedSessionGeneration(current) === operation.generation && current.status === "stopping") {
      const stoppedRecord: SessionRecord = {
        ...current,
        status: "stopped",
        terminalId: undefined,
        shellTerminalId: undefined,
        editorProcessId: undefined,
        opencodeServerProcessId: undefined,
        opencodeServerVersion: undefined,
        capacityLease: undefined,
        lastActiveAt: new Date(),
      };
      this.#put(stoppedRecord);
      this.#setDevelopmentLifecycle(stoppedRecord, "stopped");
    }
    this.ctx.storage.kv.delete(`stop:${operation.sessionId}`);
  }

  async #resumeRestart(restart: RestartRecord): Promise<void> {
    let operation = this.ctx.storage.kv.get<RestartRecord>(`restart:${restart.sessionId}`) ?? restart;
    if (operation.phase === "prepare") {
      const prepared = await policyForSandbox(this.env, operation.instanceTier, operation.oldSandboxId).prepareDevelopmentRestart(
        operation.sessionId, operation.oldGeneration, operation.oldSandboxId,
        operation.newSandboxId, operation.newGeneration,
      );
      if (prepared === false) {
        const current = this.#get(operation.sessionId);
        if (current && current.status === "stopping" && current.sandboxId === operation.oldSandboxId) {
          this.#put({ ...current, status: "failed", error: "Development restart requires a new session.", lastActiveAt: new Date() });
        }
        this.ctx.storage.kv.delete(`restart:${operation.sessionId}`);
        return;
      }
      operation = { ...operation, phase: "cleanup" };
      this.ctx.storage.kv.put(`restart:${operation.sessionId}`, operation);
    }
    if (operation.phase === "cleanup") {
      await policyForSandbox(this.env, operation.instanceTier, operation.oldSandboxId).cleanupDevelopment(
        operation.sessionId, operation.oldGeneration, operation.oldSandboxId,
      );
      operation = { ...operation, phase: "destroy" };
      this.ctx.storage.kv.put(`restart:${operation.sessionId}`, operation);
    }
    if (operation.phase === "destroy") {
      await sandboxFor(this.env, operation.instanceTier, operation.oldSandboxId).destroy();
      operation = { ...operation, phase: "transfer" };
      this.ctx.storage.kv.put(`restart:${operation.sessionId}`, operation);
    }
    if (operation.phase === "transfer") {
      let newLease = operation.newLease;
      if (operation.oldLease) {
        const replacement = operation.replacement;
        if (!replacement) throw new Error("Capacity restart replacement is missing.");
        newLease = capacityKey(await capacityFor(this.env, operation.oldLease.tier)
          .transfer(operation.oldLease, replacement));
      } else if (isHeavyTier(operation.instanceTier) && !newLease) {
        const malformed = this.#get(operation.sessionId);
        if (malformed && !malformed.archivedAt && malformed.status === "stopping" &&
            malformed.sandboxId === operation.oldSandboxId &&
            storedSessionGeneration(malformed) === operation.oldGeneration) {
          this.#put({
            ...malformed, status: "failed", error: "Coding session capacity lease is missing.",
            lastActiveAt: new Date(),
          });
        }
        this.ctx.storage.kv.delete(`restart:${operation.sessionId}`);
        return;
      }
      operation = { ...operation, ...(newLease ? { newLease } : {}), phase: "schedule" };
      this.ctx.storage.kv.put(`restart:${operation.sessionId}`, operation);
    }

    const current = this.#get(operation.sessionId);
    if (!current || current.archivedAt) throw new Error("Coding session restart was cancelled.");
    const isNewGeneration = current.sandboxId === operation.newSandboxId &&
      storedSessionGeneration(current) === operation.newGeneration;
    if (isNewGeneration && ["running", "failed", "stopped"].includes(current.status)) {
      this.ctx.storage.kv.delete(`restart:${operation.sessionId}`);
      return;
    }
    let starting: SessionRecord;
    if (isNewGeneration && current.status === "starting") {
      starting = current;
    } else {
      if (current.sandboxId !== operation.oldSandboxId ||
          storedSessionGeneration(current) !== operation.oldGeneration || current.status !== "stopping") {
        throw new Error("Coding session restart was cancelled.");
      }
      starting = {
        ...current,
        status: "starting",
        sandboxId: operation.newSandboxId,
        ...(current.development ? { generation: operation.newGeneration } : {}),
        capacityLease: operation.newLease,
        lastActiveAt: new Date(),
      };
      this.#put(starting);
      this.#setDevelopmentLifecycle(starting, "pending");
    }
    if (durableLifecycleEnabled(this.env) || operation.development) {
      await this.#beginStart(starting, operation.owner);
    } else {
      await this.#scheduleStart(starting, operation.owner);
    }
    this.ctx.storage.kv.delete(`restart:${operation.sessionId}`);
  }

  #hasRegistryWork(): boolean {
    for (const _entry of this.ctx.storage.kv.list({ prefix: "start:" })) return true;
    for (const _entry of this.ctx.storage.kv.list({ prefix: "restart:" })) return true;
    for (const _entry of this.ctx.storage.kv.list({ prefix: "stop:" })) return true;
    for (const _entry of this.ctx.storage.kv.list({ prefix: "pending-release:" })) return true;
    for (const [, job] of this.ctx.storage.kv.list<ProductFeedbackJob>({ prefix: "feedback:" })) {
      if (!["no-safe-fix", "pr-created", "failed"].includes(job.state) || job.stage === "slack") return true;
    }
    return false;
  }

  #nextFeedbackEvidenceExpiry(): number | undefined {
    let next: number | undefined;
    for (const [, evidence] of this.ctx.storage.kv.list<ProductFeedbackEvidenceBundle>({ prefix: "feedback-evidence:" })) {
      const expiry = evidence.expiresAt.valueOf();
      if (next === undefined || expiry < next) next = expiry;
    }
    return next;
  }

  #requireRegistryRetryAlarm(): Promise<void> {
    return this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  async #scheduleRegistryRetry(): Promise<void> {
    try {
      await this.#requireRegistryRetryAlarm();
    } catch (error) {
      logger.error("coding session registry retry alarm could not be scheduled", {
        event: "coding.session.registry.retry.schedule.failed", error,
      });
    }
  }

  /** Enqueues first-party feedback automation and stores private evidence with a 30-day TTL. */
  async submitProductFeedback(evidence: ProductFeedbackEvidenceBundle): Promise<ProductFeedbackSubmissionResult> {
    const existing = this.ctx.storage.kv.get<ProductFeedbackJob>(`feedback:${evidence.id}`);
    if (existing) return { id: evidence.id, status: publicFeedbackStatus(existing) };
    // A harmless empty wakeup is preferable to a durable job stranded by a crash after storage.
    await this.#requireRegistryRetryAlarm();
    const now = new Date();
    const job: ProductFeedbackJob = {
      id: evidence.id,
      kind: evidence.kind,
      title: evidence.title,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      stage: "queued",
      sandboxId: `feedback-${evidence.id}`,
      publisherSandboxId: `feedback-publish-${evidence.id}`,
    };
    this.ctx.storage.kv.put(`feedback-evidence:${evidence.id}`, evidence);
    this.ctx.storage.kv.put(`feedback:${evidence.id}`, job);
    return { id: evidence.id, status: publicFeedbackStatus(job) };
  }

  /** Lists display-safe product feedback statuses newest first. */
  listProductFeedbackStatuses(): ProductFeedbackStatus[] {
    return [...this.ctx.storage.kv.list<ProductFeedbackJob>({ prefix: "feedback:" })].map(([, value]) => value)
      .map(publicFeedbackStatus)
      .toSorted((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());
  }

  /** Reads one display-safe product feedback status. */
  getProductFeedbackStatus(id: string): ProductFeedbackStatus | undefined {
    const job = this.ctx.storage.kv.get<ProductFeedbackJob>(`feedback:${id}`);
    return job && publicFeedbackStatus(job);
  }

  async #resumeFeedbackJob(job: ProductFeedbackJob): Promise<void> {
    let current = this.ctx.storage.kv.get<ProductFeedbackJob>(`feedback:${job.id}`) ?? job;
    const evidence = this.ctx.storage.kv.get<ProductFeedbackEvidenceBundle>(`feedback-evidence:${job.id}`);
    if (!evidence) {
      this.ctx.storage.kv.delete(`feedback:${job.id}`);
      this.ctx.storage.kv.delete(`feedback-diff:${job.id}`);
      this.ctx.storage.kv.delete(`feedback-log:${job.id}`);
      await bestEffortDestroyFeedbackSandbox(this.env, current.sandboxId ?? `feedback-${job.id}`);
      await bestEffortDestroyFeedbackSandbox(this.env,
        current.publisherSandboxId ?? `feedback-publish-${job.id}`);
      return;
    }
    if (current.state === "queued") {
      const stage = current.stage === undefined || current.stage === "queued" ? "sandbox" : current.stage;
      current = { ...current, state: "running", stage, updatedAt: new Date() };
      this.ctx.storage.kv.put(`feedback:${job.id}`, current);
    }
    const branch = current.branch ?? feedbackBranch(job.id);
    const sandboxId = current.sandboxId ?? `feedback-${job.id}`;
    const sandbox = getSandbox(this.env.PRODUCT_FEEDBACK_SANDBOX, sandboxId) as unknown as FeedbackSandbox;
    if (current.stage === "sandbox" || current.stage === "queued" || current.stage === undefined) {
      const policyId = this.env.PRODUCT_FEEDBACK_SANDBOX.idFromName(sandboxId).toString();
      await policyFor(this.env, policyId).configure({
        sessionId: `product-feedback:${job.id}`,
        sandboxId: policyId,
        owner: evidence.owner,
        repositories: [PRODUCT_FEEDBACK_REPOSITORY],
      });
      await sandbox.configureGitHubAuth((await mintGitHubProductFeedbackReadToken(this.env)).token);
      await waitForOk(await sandbox.exec(["rm", "-rf", `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`], { timeout: 30_000 }), 35_000);
      await waitForOk(await sandbox.exec(["git", "clone", `https://github.com/totango/${PRODUCT_FEEDBACK_REPOSITORY}.git`, `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`], { timeout: 180_000 }), 190_000);
      await sandbox.writeFile("/tmp/odie-feedback-prompt.txt", productFeedbackPrompt(evidence));
      const { owner: _owner, ...agentEvidence } = evidence;
      await sandbox.writeFile("/tmp/odie-feedback-evidence.json", JSON.stringify(agentEvidence, null, 2));
      const agentProcess = await sandbox.exec([
        "sh", "-lc",
        "opencode run --pure --auto --model openai/gpt-6-astra \"$(cat /tmp/odie-feedback-prompt.txt)\" > /tmp/feedback-agent.log 2>&1",
      ], {
        cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`,
        env: opencodeEnvironment(this.env, { plugins: [], skills: [] }, false),
        timeout: 20 * 60_000,
      });
      const agentExit = await agentProcess.waitForExit({ timeout: 21 * 60_000 });
      const agentLog = await readSandboxText(sandbox, "/tmp/feedback-agent.log", 8_000);
      if (agentExit.code !== 0 || agentExit.timedOut) {
        this.ctx.storage.kv.put(`feedback:${job.id}`, {
          ...current, state: "failed", stage: "done", message: "OpenCode feedback agent failed.", updatedAt: new Date(),
        });
        this.ctx.storage.kv.put(`feedback-log:${job.id}`, agentLog);
        await bestEffortDestroy(sandbox);
        return;
      }
      await waitForOk(await sandbox.exec(["git", "add", "-N", "."], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      await waitForOk(await sandbox.exec(["git", "diff", "--binary"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      await waitForOk(await sandbox.exec(["sh", "-lc", "git diff --binary > /tmp/feedback.diff"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      current = { ...current, branch, sandboxId, stage: "diff", updatedAt: new Date() };
      this.ctx.storage.kv.put(`feedback:${job.id}`, current);
    }
    if (current.stage === "diff") {
      const diffKey = `feedback-diff:${job.id}`;
      const diff = this.ctx.storage.kv.get<string>(diffKey) ??
        await readSandboxText(sandbox, "/tmp/feedback.diff", 128 * 1024);
      const safe = validateSafeDiff(diff, evidence);
      if (!safe.ok) {
        this.ctx.storage.kv.put(`feedback:${job.id}`, {
          ...current, state: "no-safe-fix", stage: "done", message: safe.reason, updatedAt: new Date(),
        });
        await bestEffortDestroy(sandbox);
        return;
      }
      const changeSummary = summarizeProductFeedbackDiff(diff);
      this.ctx.storage.kv.put(diffKey, diff);
      await bestEffortDestroy(sandbox);
      const publisherSandboxId = current.publisherSandboxId ?? `feedback-publish-${job.id}`;
      const publisher = getSandbox(this.env.PRODUCT_FEEDBACK_SANDBOX, publisherSandboxId) as unknown as FeedbackSandbox;
      await publisher.configureGitHubAuth((await mintGitHubProductFeedbackReadToken(this.env)).token);
      await waitForOk(await publisher.exec(["rm", "-rf", `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`], { timeout: 30_000 }), 35_000);
      await waitForOk(await publisher.exec(["git", "clone", `https://github.com/totango/${PRODUCT_FEEDBACK_REPOSITORY}.git`, `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`], { timeout: 180_000 }), 190_000);
      await publisher.writeFile("/tmp/feedback.diff", diff);
      await waitForOk(await publisher.exec(["git", "checkout", "-B", branch], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      await waitForOk(await publisher.exec(["git", "apply", "--index", "--whitespace=error-all", "/tmp/feedback.diff"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      await waitForOk(await publisher.exec(["sh", "-lc", "git diff --cached --binary > /tmp/feedback-staged.diff"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      const stagedDiff = await readSandboxText(publisher, "/tmp/feedback-staged.diff", 128 * 1024);
      const stagedSafe = validateSafeDiff(stagedDiff, evidence);
      if (!stagedSafe.ok) {
        this.ctx.storage.kv.put(`feedback:${job.id}`, {
          ...current, state: "no-safe-fix", stage: "done", message: stagedSafe.reason, updatedAt: new Date(),
        });
        await bestEffortDestroy(publisher);
        return;
      }
      await waitForOk(await publisher.exec(["git", "config", "user.name", "Odie Product Feedback"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      await waitForOk(await publisher.exec(["git", "config", "user.email", "odie-feedback@totango.com"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      await waitForOk(await publisher.exec(["git", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-m", `Product feedback ${job.id}`], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 60_000 }), 65_000);
      await waitForOk(await publisher.exec(["sh", "-lc", "git show --format= --binary HEAD > /tmp/feedback-committed.diff"], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 30_000 }), 35_000);
      const committedDiff = await readSandboxText(publisher, "/tmp/feedback-committed.diff", 128 * 1024);
      const committedSafe = validateSafeDiff(committedDiff, evidence);
      if (!committedSafe.ok || committedDiff !== stagedDiff) {
        this.ctx.storage.kv.put(`feedback:${job.id}`, {
          ...current, state: "no-safe-fix", stage: "done",
          message: committedSafe.ok ? "Committed diff did not match the validated patch." : committedSafe.reason,
          updatedAt: new Date(),
        });
        await bestEffortDestroy(publisher);
        return;
      }
      current = { ...current, changeSummary, publisherSandboxId, stage: "push", updatedAt: new Date() };
      this.ctx.storage.kv.put(`feedback:${job.id}`, current);
    }
    if (current.stage === "push") {
      const publisher = getSandbox(this.env.PRODUCT_FEEDBACK_SANDBOX,
        required(current.publisherSandboxId, "feedback publisherSandboxId")) as unknown as FeedbackSandbox;
      await publisher.configureGitHubAuth((await mintGitHubCodingSessionToken(this.env, [PRODUCT_FEEDBACK_REPOSITORY])).token);
      await waitForOk(await publisher.exec(["git", "-c", "core.hooksPath=/dev/null", "push", "--no-verify", "origin", branch], { cwd: `/workspace/${PRODUCT_FEEDBACK_REPOSITORY}`, timeout: 120_000 }), 125_000);
      current = { ...current, stage: "pr", updatedAt: new Date() };
      this.ctx.storage.kv.put(`feedback:${job.id}`, current);
      this.ctx.storage.kv.delete(`feedback-diff:${job.id}`);
      await bestEffortDestroy(publisher);
    }
    const pr = current.prUrl && current.prNumber
      ? { url: current.prUrl, number: current.prNumber }
      : await createDraftPullRequest(
        this.env,
        evidence,
        branch,
        current.changeSummary ?? "Applies a small automated source fix.",
      );
    current = { ...current, state: "pr-created", prUrl: pr.url, prNumber: pr.number, stage: "slack", updatedAt: new Date() };
    this.ctx.storage.kv.put(`feedback:${job.id}`, current);
    try {
      await notifyFeedbackSlack(this.env, current);
    } catch (error) {
      const slackAttempts = (current.slackAttempts ?? 0) + 1;
      const retrying = slackAttempts < 3;
      this.ctx.storage.kv.put(`feedback:${job.id}`, {
        ...current,
        slackAttempts,
        stage: retrying ? "slack" : "done",
        message: retrying ? "Draft PR created; Slack notification will retry." : "Draft PR created; Slack notification failed.",
        updatedAt: new Date(),
      });
      if (retrying) await this.#scheduleRegistryRetry();
      logger.warn("product feedback Slack notification failed", {
        event: "product.feedback.slack.failed", sessionId: job.id, error,
      });
      await bestEffortDestroy(sandbox);
      await bestEffortDestroyFeedbackSandbox(this.env,
        current.publisherSandboxId ?? `feedback-publish-${job.id}`);
      return;
    }
    this.ctx.storage.kv.put(`feedback:${job.id}`, {
      ...current, stage: "done", message: undefined, slackAttempts: undefined, updatedAt: new Date(),
    });
    await bestEffortDestroy(sandbox);
    await bestEffortDestroyFeedbackSandbox(this.env,
      current.publisherSandboxId ?? `feedback-publish-${job.id}`);
  }

  async #releaseCapacity(lease: CapacityReservationKey): Promise<void> {
    try {
      await capacityFor(this.env, lease.tier).release(lease);
      this.ctx.storage.kv.delete(`pending-release:${lease.reservationId}`);
    } catch (error) {
      this.ctx.storage.kv.put(`pending-release:${lease.reservationId}`, lease);
      await this.#scheduleRegistryRetry();
      logger.warn("coding session capacity release will retry", {
        event: "coding.session.capacity.release.retry", sessionId: lease.sessionId, error,
      });
    }
  }

  /** Applies successful asynchronous startup only to the current starting generation. */
  async startupSucceeded(sessionId: string, generation: number, sandboxId: string, terminalId: string): Promise<boolean> {
    const current = this.#get(sessionId);
    if (!current || current.archivedAt || storedSessionGeneration(current) !== generation || current.sandboxId !== sandboxId) return false;
    if (current.status === "running" && current.terminalId === terminalId) return true;
    if (current.status !== "starting") return false;
    if (current.capacityLease) {
      const activated = await capacityFor(this.env, current.capacityLease.tier).activate(current.capacityLease);
      if (!sameCapacityKey(current.capacityLease, activated)) {
        throw new Error("Capacity activation returned a different reservation.");
      }
    }
    const running = { ...current, status: "running" as const, terminalId, lastActiveAt: new Date() };
    this.#put(running);
    logger.info("coding session environment ready", {
      event: "coding.session.environment.ready",
      sessionId,
      repositoryCount: current.repositories.length,
    });
    return true;
  }

  /** Applies asynchronous startup failure only to the current starting generation. */
  async startupFailed(
    sessionId: string, generation: number, sandboxId: string, error: string, destroyed: boolean,
  ): Promise<boolean> {
    const current = this.#get(sessionId);
    if (!current || current.archivedAt || storedSessionGeneration(current) !== generation ||
        current.sandboxId !== sandboxId || !["starting", "failed", "stopping"].includes(current.status)) return false;
    if (!destroyed) {
      const failed = {
        ...current, status: current.capacityLease ? "stopping" as const : "failed" as const,
        terminalId: undefined, shellTerminalId: undefined,
        editorProcessId: undefined, opencodeServerProcessId: undefined, opencodeServerVersion: undefined,
        error, lastActiveAt: new Date(),
      };
      this.#put(failed);
      this.#setDevelopmentLifecycle(failed, "failed", "Development component startup failed.");
      return true;
    }
    if (current.capacityLease) {
      this.ctx.storage.kv.put(`pending-release:${current.capacityLease.reservationId}`, current.capacityLease);
    }
    const failed: SessionRecord = {
      ...current,
      status: "failed",
      terminalId: undefined,
      shellTerminalId: undefined,
      editorProcessId: undefined,
      opencodeServerProcessId: undefined,
      opencodeServerVersion: undefined,
      capacityLease: undefined,
      error,
      lastActiveAt: new Date(),
    };
    this.#put(failed);
    this.#setDevelopmentLifecycle(failed, "failed", "Development component startup failed.");
    if (current.capacityLease) await this.#releaseCapacity(current.capacityLease);
    return true;
  }
}

/** Private control-plane entrypoint called by the authenticated Workshop backend. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements CodingSessionsService {
  /** Deliberately fails connector discovery because Sessions is a Workshop feature, not a connector. */
  async describe(): Promise<VendorDescription> {
    throw new Error("Coding Sessions is an internal Workshop service, not a connector.");
  }

  /** Reports whether this deployment can mint separate-origin browser editor capabilities. */
  editorAvailable(): Promise<boolean> {
    try {
      requiredEditorBaseUrl(this.env.EDITOR_BASE_URL);
      required(this.env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET");
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  /** Lists sessions for the supplied authenticated owner. */
  async listSessions(owner: CodingSessionOwner): Promise<CodingSessionSummary[]> {
    const read = () => registryFor(this.ctx, owner.userId).listSessions();
    try {
      return await read();
    } catch (error) {
      if (!isDurableObjectReset(error)) throw error;
      await scheduler.wait(Math.random() * 250);
      const sessions = await read();
      logger.info("coding session list recovered after registry reset", {
        event: "coding.session.registry.reset.recovered",
      });
      return sessions;
    }
  }

  /** Returns the display-safe server-owned development catalog. */
  getDevelopmentCatalog(_owner: CodingSessionOwner): Promise<CodingSessionDevelopmentCatalog> {
    return Promise.resolve(publicDevelopmentCatalog());
  }

  /** Checks a development request without reserving capacity or contacting a sandbox. */
  preflightSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
  ): Promise<CodingSessionDevelopmentPlan> {
    return registryFor(this.ctx, owner.userId).preflightSession(request, owner.userId);
  }

  /** Returns persisted development lifecycle for one owned session. */
  getDevelopmentStatus(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionDevelopmentStatus> {
    return registryFor(this.ctx, owner.userId).getDevelopmentStatus(sessionId);
  }

  /** Retrieves one session for the supplied authenticated owner. */
  getSession(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined> {
    return registryFor(this.ctx, owner.userId).getSession(sessionId);
  }

  /** Retrieves one owned session from persisted metadata without contacting its sandbox. */
  getSessionMetadata(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined> {
    return registryFor(this.ctx, owner.userId).getSessionMetadata(sessionId);
  }

  /** Checks persisted running session generation without contacting its sandbox. */
  isCurrentSessionGeneration(owner: CodingSessionOwner, sessionId: string, sandboxId: string): Promise<boolean> {
    return registryFor(this.ctx, owner.userId).isCurrentSessionGeneration(sessionId, sandboxId);
  }

  /** Creates a session for the supplied authenticated owner. */
  createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    return registryFor(this.ctx, owner.userId).createSession(owner, request, customization);
  }

  /** Stops a session for the supplied authenticated owner. */
  stopSession(owner: CodingSessionOwner, sessionId: string): Promise<void> {
    return registryFor(this.ctx, owner.userId).stopSession(sessionId);
  }

  /** Rebuilds a session for the supplied authenticated owner. */
  restartSession(
    owner: CodingSessionOwner,
    sessionId: string,
    customization?: OpenCodeUserCustomization,
  ): Promise<CodingSessionSummary> {
    return registryFor(this.ctx, owner.userId).restartSession(sessionId, owner, customization);
  }

  /** Stops and archives a session for the supplied authenticated owner. */
  archiveSession(owner: CodingSessionOwner, sessionId: string): Promise<void> {
    return registryFor(this.ctx, owner.userId).archiveSession(sessionId);
  }

  /** Mints a terminal capability for the supplied authenticated owner. */
  mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    terminal?: CodingSessionTerminalKind,
  ): Promise<CodingSessionAttachCapability> {
    return registryFor(this.ctx, owner.userId).mintAttachCapability(owner, sessionId, terminal);
  }

  /** Mints a browser VS Code capability for the supplied authenticated owner. */
  mintEditorCapability(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionEditorCapability> {
    return registryFor(this.ctx, owner.userId).mintEditorCapability(owner, sessionId);
  }

  /** Mints a same-origin OpenCode server capability for the supplied authenticated owner. */
  mintOpenCodeCapability(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionOpenCodeCapability> {
    return registryFor(this.ctx, owner.userId).mintOpenCodeCapability(owner, sessionId);
  }

  /** Rejects application preview minting until the preview gateway is available. */
  mintApplicationCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    applicationId: string,
  ): Promise<CodingSessionApplicationCapability> {
    return registryFor(this.ctx, owner.userId).mintApplicationCapability(sessionId, applicationId);
  }

  /** Uploads one file into a running session owned by the supplied authenticated owner. */
  uploadFile(
    owner: CodingSessionOwner,
    request: CodingSessionFileUploadRequest,
  ): Promise<CodingSessionFileUploadResult> {
    return registryFor(this.ctx, owner.userId).uploadFile(owner, request);
  }

  /** Durably enqueues a first-party feedback automation job. */
  submitProductFeedback(
    owner: CodingSessionOwner,
    evidence: ProductFeedbackEvidenceBundle,
  ): Promise<ProductFeedbackSubmissionResult> {
    if (owner.email !== evidence.submitterEmail || owner.email !== evidence.owner.email || owner.userId !== evidence.owner.userId) {
      throw new Error("Feedback submitter mismatch.");
    }
    return registryFor(this.ctx, owner.userId).submitProductFeedback(evidence);
  }

  /** Lists first-party feedback automation statuses for the supplied owner. */
  listProductFeedbackStatuses(owner: CodingSessionOwner): Promise<ProductFeedbackStatus[]> {
    return registryFor(this.ctx, owner.userId).listProductFeedbackStatuses();
  }

  /** Reads one first-party feedback automation status for the supplied owner. */
  getProductFeedbackStatus(owner: CodingSessionOwner, id: string): Promise<ProductFeedbackStatus | undefined> {
    return registryFor(this.ctx, owner.userId).getProductFeedbackStatus(id);
  }
}

async function handleHttp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const applicationPreview = await handleApplicationPreviewIngress(request, env);
  if (applicationPreview) return applicationPreview;
  const url = new URL(request.url);
  const openCodeMatch = /^\/gatekeeper\/sessions\/opencode\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (openCodeMatch) return handleOpenCodeHttp(request, env, ctx, openCodeMatch[1]!, openCodeMatch[2]!);
  const editorMatch = /^\/c\/([A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43})(\/.*)$/.exec(url.pathname);
  if (editorMatch) return handleEditorHttp(request, env, ctx, editorMatch[1]!, editorMatch[2]!);
  const match = /^\/gatekeeper\/sessions\/attach\/([^/]+)$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const expectedOrigin = env.SESSION_ALLOWED_ORIGIN ?? (env.BASE_URL ? new URL(env.BASE_URL).origin : url.origin);
  if (request.headers.get("Origin") !== expectedOrigin) {
    return new Response("Origin is not allowed", { status: 403 });
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor && cursor.length > 1024) return new Response("Invalid terminal cursor", { status: 400 });

  const ticket = await (await ticketFor(env, match[1])).consumeTicket(Date.now());
  if (!ticket) {
    logger.warn("coding session terminal attach rejected", {
      event: "coding.session.terminal.attach.rejected",
      status: 403,
      reason: "invalid_ticket",
    });
    return new Response("Attachment capability is invalid or expired", { status: 403 });
  }
  if (!(await registryFor(ctx, ticket.userId).isCurrentSessionGeneration(
    ticket.sessionId, ticket.sandboxId, ticket.generation ?? 0))) {
    return new Response("Terminal is no longer available", { status: 410 });
  }
  try {
    const terminal = await sandboxFor(env, storedTicketTier(ticket), ticket.sandboxId).getTerminal(ticket.terminalId);
    if (!terminal) {
      if (ticket.terminalKind === "opencode") {
        await registryFor(ctx, ticket.userId).markTerminalUnavailable(ticket.sessionId, ticket.sandboxId, ticket.terminalId, "Coding session environment expired. Restart the session to continue.", ticket.generation ?? 0);
      }
      logger.warn("coding session terminal attach failed", {
        event: "coding.session.terminal.attach.failed",
        sessionId: ticket.sessionId,
        terminalKind: ticket.terminalKind,
        status: 410,
        reason: "terminal_missing",
      });
      return new Response("Terminal is no longer available", { status: 410 });
    }
    logger.debug("coding session terminal attaching", {
      event: "coding.session.terminal.attach",
      sessionId: ticket.sessionId,
      terminalKind: ticket.terminalKind,
    });
    return terminal.connect(request, { cursor, cols: 120, rows: 40 });
  } catch (error) {
    logger.error("coding session terminal attach failed", {
      event: "coding.session.terminal.attach.failed",
      sessionId: ticket.sessionId,
      terminalKind: ticket.terminalKind,
      error,
    });
    return new Response("Terminal connection failed", { status: 502 });
  }
}

async function handleOpenCodeHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  path: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const expectedOrigin = env.SESSION_ALLOWED_ORIGIN ?? (env.BASE_URL ? new URL(env.BASE_URL).origin : requestUrl.origin);
  if (requestUrl.origin !== expectedOrigin) return new Response("OpenCode capability is not accepted on this origin", { status: 403 });
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== expectedOrigin) return new Response("Origin is not allowed", { status: 403 });
  const tokenTicket = await validOpenCodeCapabilityToken(env, token);
  if (!tokenTicket) return new Response("OpenCode capability is invalid or expired", { status: 403 });
  const route = allowedOpenCodeRoute(request.method, path, requestUrl.searchParams);
  if (!route.ok) return new Response(route.message, { status: route.status });
  let body: Uint8Array | null = null;
  if (request.method === "POST") {
    const contentLength = request.headers.get("Content-Length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > OPENCODE_SERVER_MAX_POST_BYTES)) {
      return new Response("Request body is too large", { status: 413 });
    }
    body = await readBoundedBody(request.body, OPENCODE_SERVER_MAX_POST_BYTES);
    if (!body) return new Response("Request body is too large", { status: 413 });
  }
  const ticket = await (await openCodeTicketFor(env, token)).getOpenCodeTicket(Date.now());
  if (!ticket || ticket.userId !== tokenTicket.userId || ticket.sessionId !== tokenTicket.sessionId ||
      ticket.sandboxId !== tokenTicket.sandboxId || (ticket.generation ?? 0) !== tokenTicket.generation ||
      storedTicketTier(ticket) !== tokenTicket.instanceTier) {
    return new Response("OpenCode capability is invalid or expired", { status: 403 });
  }
  if (!(await registryFor(ctx, ticket.userId).isCurrentSessionGeneration(
    ticket.sessionId, ticket.sandboxId, ticket.generation ?? 0))) {
    return new Response("OpenCode session is no longer available", { status: 410 });
  }

  const target = new URL(`http://127.0.0.1:${OPENCODE_SERVER_PORT}${path}`);
  if (route.preserveQuery) target.search = requestUrl.search;
  const headers = openCodeProxyHeaders(request.headers);
  if (body) headers.set("Content-Length", String(body.byteLength));
  const proxyRequest = new Request(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  try {
    const response = await sandboxFor(env, storedTicketTier(ticket), ticket.sandboxId)
      .containerFetch(proxyRequest, OPENCODE_SERVER_PORT);
    if (response.headers.has("Location") || response.status >= 300 && response.status < 400) {
      return new Response("OpenCode redirect rejected", { status: 502, headers: secureProxyResponseHeaders() });
    }
    const responseHeaders = secureProxyResponseHeaders();
    responseHeaders.set("Content-Type", path === "/event" ? "text/event-stream" : "application/json; charset=utf-8");
    responseHeaders.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    responseHeaders.set("Cross-Origin-Resource-Policy", "same-origin");
    responseHeaders.set("X-Frame-Options", "DENY");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    logger.error("OpenCode server proxy failed", {
      event: "coding.session.opencode.proxy.failed",
      sessionId: ticket.sessionId,
      error,
    });
    return new Response("OpenCode server is unavailable", { status: 502 });
  }
}

async function handleEditorHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  path: string,
): Promise<Response> {
  let editorBaseUrl: string;
  try {
    editorBaseUrl = requiredEditorBaseUrl(env.EDITOR_BASE_URL);
  } catch {
    return new Response("Browser editor is not configured", { status: 404 });
  }
  const expectedOrigin = new URL(editorBaseUrl).origin;
  if (new URL(request.url).origin !== expectedOrigin) {
    return new Response("Editor capability is not accepted on this origin", { status: 403 });
  }
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== expectedOrigin) {
    return new Response("Origin is not allowed", { status: 403 });
  }
  if (!(await validEditorCapabilityToken(env, token))) {
    return new Response("Editor capability is invalid or expired", { status: 403 });
  }
  const ticket = await (await editorTicketFor(env, token)).getEditorTicket(Date.now());
  if (!ticket) return new Response("Editor capability is invalid or expired", { status: 403 });
  if (!(await registryFor(ctx, ticket.userId).isCurrentSessionGeneration(
    ticket.sessionId, ticket.sandboxId, ticket.generation ?? 0))) {
    return new Response("Editor session is no longer available", { status: 410 });
  }

  const prefix = `/c/${token}/`;
  const target = new URL(`http://localhost:${EDITOR_PORT}${path}`);
  target.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  headers.set("Host", new URL(editorBaseUrl).host);
  headers.set("X-Forwarded-Host", new URL(editorBaseUrl).host);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Prefix", prefix.slice(0, -1));
  const proxyRequest = new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
  const sandbox = sandboxFor(env, storedTicketTier(ticket), ticket.sandboxId);
  try {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return await sandbox.wsConnect(proxyRequest, EDITOR_PORT);
    }
    const response = await sandbox.containerFetch(proxyRequest, EDITOR_PORT);
    const responseHeaders = new Headers(response.headers);
    const location = responseHeaders.get("Location");
    if (location) {
      responseHeaders.set("Location", rewriteEditorLocation(location, expectedOrigin, prefix));
    }
    responseHeaders.set("Cache-Control", "private, no-store");
    responseHeaders.set("Referrer-Policy", "no-referrer");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    if (path === "/") responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Service-Worker-Allowed", prefix);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    logger.error("browser editor proxy failed", {
      event: "coding.session.editor.proxy.failed",
      sessionId: ticket.sessionId,
      error,
    });
    return new Response("Browser editor is unavailable", { status: 502 });
  }
}

export default { fetch: handleHttp };

function registryFor(ctx: ExecutionContext, userId: string): DurableObjectStub<CodingSessionRegistry> {
  const namespace = (ctx as ExecutionContext & {
    exports: { CodingSessionRegistry: DurableObjectNamespace<CodingSessionRegistry> };
  }).exports.CodingSessionRegistry;
  return namespace.get(namespace.idFromName(userId));
}

function isDurableObjectReset(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const flags = error as { durableObjectReset?: unknown; retryable?: unknown; overloaded?: unknown };
  if (flags.durableObjectReset === true) return true;
  return flags.retryable === true && flags.overloaded !== true;
}

function policyFor(env: Env, containerId: string): DurableObjectStub<CodingSessionPolicy> {
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`container:${containerId}`));
}

function policyForSandbox(
  env: Env, tier: CodingSessionInstanceTier, sandboxId: string,
): DurableObjectStub<CodingSessionPolicy> {
  return policyFor(env, sandboxObjectId(env, tier, sandboxId).toString());
}

async function ticketFor(env: Env, token: string): Promise<DurableObjectStub<CodingSessionPolicy>> {
  const digest = await sha256Hex(new TextEncoder().encode(token));
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`ticket:${digest}`));
}

async function editorTicketFor(env: Env, token: string): Promise<DurableObjectStub<CodingSessionPolicy>> {
  const digest = await sha256Hex(new TextEncoder().encode(token));
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`editor-ticket:${digest}`));
}

async function openCodeTicketFor(env: Env, token: string): Promise<DurableObjectStub<CodingSessionPolicy>> {
  const digest = await sha256Hex(new TextEncoder().encode(token));
  return env.SESSION_POLICIES.get(env.SESSION_POLICIES.idFromName(`opencode-ticket:${digest}`));
}

function isHeavyTier(tier: CodingSessionInstanceTier): tier is HeavySessionTier {
  return (HEAVY_SESSION_TIERS as readonly CodingSessionInstanceTier[]).includes(tier);
}

function capacityKey(record: CapacityReservationRecord): CapacityReservationKey {
  const { tier, reservationId, sessionId, generation, sandboxId, userId } = record;
  return { tier, reservationId, sessionId, generation, sandboxId, userId };
}

function sameCapacityKey(key: CapacityReservationKey, record: CapacityReservationRecord): boolean {
  return key.tier === record.tier && key.reservationId === record.reservationId &&
    key.sessionId === record.sessionId && key.generation === record.generation &&
    key.sandboxId === record.sandboxId && key.userId === record.userId;
}

function sessionGenerationKey(record: SessionRecord): string {
  return `${record.id}:${record.sandboxId}:${storedSessionGeneration(record)}`;
}

function storedSessionGeneration(record: SessionRecord): number {
  return record.generation ?? 0;
}

function storedSessionTier(record: SessionRecord): CodingSessionInstanceTier {
  return record.instanceTier ?? record.development?.instanceTier ?? "standard-1";
}

function storedPolicyTier(policy: SessionPolicy): CodingSessionInstanceTier {
  return policy.instanceTier ?? "standard-1";
}

function storedTicketTier(ticket: AttachTicket | EditorTicket | OpenCodeTicket): CodingSessionInstanceTier {
  return ticket.instanceTier ?? "standard-1";
}

function capacityFor(env: Env, tier: HeavySessionTier): DurableObjectStub<CodingSessionCapacity> {
  return env.SESSION_CAPACITY.getByName(`tier:${tier}`);
}

function storedSessionRuntime(record: SessionRecord): CodingSessionRuntime {
  return record.primeAgent ? "prime-agent" : codingSessionRuntime(record.runtime);
}

function publicSummary(record: SessionRecord): CodingSessionSummary {
  const {
    sandboxId: _sandboxId,
    terminalId: _terminalId,
    shellTerminalId: _shellTerminalId,
    editorProcessId: _editorProcessId,
    opencodeServerProcessId: _opencodeServerProcessId,
    opencodeServerVersion: _opencodeServerVersion,
    primeAgent: _primeAgent,
    generation: _generation,
    instanceTier: _instanceTier,
    capacityLease: _capacityLease,
    ...summary
  } = record;
  return { ...summary, runtime: storedSessionRuntime(record) };
}

function publicFeedbackStatus(job: ProductFeedbackJob): ProductFeedbackStatus {
  const {
    attempts: _attempts,
    branch: _branch,
    prNumber: _prNumber,
    publisherSandboxId: _publisherSandboxId,
    sandboxId: _sandboxId,
    stage: _stage,
    slackAttempts: _slackAttempts,
    changeSummary: _changeSummary,
    ...status
  } = job;
  return status;
}

async function readSandboxText(sandbox: FeedbackSandbox, path: string, limit: number): Promise<string> {
  const result = await sandbox.readFile(path, { encoding: "utf-8" });
  const content = typeof result.content === "string" ? result.content : new TextDecoder().decode(result.content);
  return content.length <= limit ? content : `${content.slice(0, limit - 1)}…`;
}

async function bestEffortDestroy(sandbox: { destroy(): Promise<void> }): Promise<void> {
  try { await sandbox.destroy(); } catch (error) {
    logger.warn("product feedback sandbox cleanup failed", {
      event: "product.feedback.sandbox.cleanup.failed", error,
    });
  }
}

async function bestEffortDestroyFeedbackSandbox(env: Env, sandboxId: string): Promise<void> {
  try {
    await getSandbox(env.PRODUCT_FEEDBACK_SANDBOX, sandboxId).destroy();
  } catch (error) {
    logger.warn("product feedback sandbox cleanup failed", {
      event: "product.feedback.sandbox.cleanup.failed", error,
    });
  }
}

async function notifyFeedbackSlack(env: Env, job: ProductFeedbackJob): Promise<void> {
  if (!env.PRODUCT_FEEDBACK_NOTIFIER || !job.prUrl) return;
  await env.PRODUCT_FEEDBACK_NOTIFIER.notifyProductFeedbackPr({
    jobId: job.id,
    prUrl: job.prUrl,
    changeSummary: job.changeSummary ?? "Applies a small automated source fix.",
    idempotencyKey: `product-feedback:${job.id}:pr:${job.prNumber ?? "unknown"}`,
  });
}

function primaryTerminalOptions(
  runtime: CodingSessionRuntime,
  repository: CodingSessionRepository,
  env: Env,
  customization: OpenCodeUserCustomization,
): StartupTerminalOptions {
  const command = runtime === "opencode"
    ? openCodeCommand(repository)
    : runtime === "pi"
      ? piCommand()
      : primeAgentCommand();
  const runtimeEnv = runtime === "opencode"
    ? opencodeEnvironment(env, customization)
    : runtime === "pi"
      ? piEnvironment()
      : primeAgentEnvironment();
  return {
    command,
    cwd: `/workspace/${repository}`,
    env: runtimeEnv,
    cols: 120,
    rows: 40,
    bufferSize: TERMINAL_REPLAY_BUFFER_SIZE,
  };
}

async function repositoryReady(
  sandbox: Pick<StartupSandbox, "exec">,
  repository: CodingSessionRepository,
): Promise<boolean> {
  try {
    const check = await sandbox.exec([
      "git", "-C", `/workspace/${repository}`, "rev-parse", "--verify", "HEAD",
    ], { timeout: 10_000 });
    const exit = await check.waitForExit({ timeout: 15_000 });
    return exit.code === 0 && !exit.timedOut;
  } catch {
    return false;
  }
}

async function stopProcess(process: StartupProcess): Promise<boolean> {
  await process.kill(15).catch(() => undefined);
  const graceful = await process.waitForExit({ timeout: 5_000 }).catch(() => null);
  if (graceful && !graceful.timedOut) return true;
  await process.kill(9).catch(() => undefined);
  const forced = await process.waitForExit({ timeout: 5_000 }).catch(() => null);
  return !!forced && !forced.timedOut;
}

async function waitForOk(process: StartupProcess, timeout: number): Promise<void> {
  const exit = await process.waitForExit({ timeout });
  if (exit.code !== 0 || exit.timedOut) throw new Error("Startup command failed.");
}

async function matchingRunningTerminals(
  sandbox: Pick<StartupSandbox, "listTerminals">,
  command: readonly string[],
  cwd: string | undefined,
): Promise<Terminal[]> {
  const terminals = await sandbox.listTerminals();
  const result: Terminal[] = [];
  for (const terminal of terminals) {
    const snapshot = await terminal.getSnapshot();
    if (snapshot.status === "running" && snapshot.cwd === cwd && arraysEqual(snapshot.command, command)) {
      result.push(terminal);
    }
  }
  return result;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRuntimeConfigured(env: Env, runtime: CodingSessionRuntime): void {
  assertRuntimeEnabled(runtime, env.CODING_SESSION_PI_RUNTIME_ENABLED);
  if (runtime === "opencode") return;
  required(env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
  required(env.TEAM_PI_CODEX_HMAC_SECRET, "TEAM_PI_CODEX_HMAC_SECRET");
}

function opencodeEnvironment(
  env: Env,
  customization: OpenCodeUserCustomization,
  includeWorkshopMcp = true,
): Record<string, string> {
  const baseUrl = env.TEAM_PI_CODEX_BASE_URL;
  const provider = baseUrl ? {
    enabled_providers: ["openai"],
    provider: {
      openai: {
        name: "Team PI Codex",
        options: {
          baseURL: new URL("codex", ensureTrailingSlash(baseUrl)).toString(),
          apiKey: "synthetic",
        },
        models: {
          [OPENCODE_TEAM_PI_MODEL_ID]: {
            name: OPENCODE_TEAM_PI_MODEL.name,
            reasoning: true,
            temperature: false,
            tool_call: true,
            cost: openCodeModelCost(),
            limit: {
              context: OPENCODE_TEAM_PI_MODEL.contextWindow,
              output: OPENCODE_TEAM_PI_MODEL.outputLimit,
            },
          },
          [OPENCODE_SOL_MODEL_ID]: {
            name: OPENCODE_SOL_MODEL.name,
            reasoning: true,
            temperature: false,
            tool_call: true,
            limit: {
              context: OPENCODE_SOL_MODEL.contextWindow,
              output: OPENCODE_SOL_MODEL.outputLimit,
            },
          },
        },
      },
    },
  } : {};
  return {
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      ...(baseUrl ? {
        model: `openai/${OPENCODE_TEAM_PI_MODEL_ID}`,
        small_model: `openai/${OPENCODE_TEAM_PI_MODEL_ID}`,
      } : {}),
      ...provider,
      mcp: includeWorkshopMcp ? {
        workshop: {
          type: "remote",
          url: `https://${WORKSHOP_MCP_HOST}/mcp`,
          oauth: false,
          enabled: true,
          timeout: 30_000,
        },
      } : {},
      plugin: customization.plugins,
    }),
  };
}

function openCodeModelCost(): Record<string, unknown> | undefined {
  const cost = OPENCODE_TEAM_PI_MODEL.cost;
  if (!cost) return undefined;
  // OpenCode only supports a fixed >200K bucket, so Astra's >272K tier cannot be represented.
  // Omitting it makes OpenCode's displayed estimate use base rates for requests above 272K.
  return {
    input: cost.input,
    output: cost.output,
    cache_read: cost.cacheRead,
    cache_write: cost.cacheWrite,
  };
}

async function materializePiRuntime(
  sandbox: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    writeFile(path: string, content: string): Promise<unknown>;
  },
  env: Env,
): Promise<void> {
  const baseUrl = required(env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
  await sandbox.mkdir(PI_CONFIG_DIR, { recursive: true });
  await sandbox.writeFile(PI_EXTENSION_PATH, piExtensionSource(baseUrl));
}

async function materializePrimeAgentRuntime(
  sandbox: Parameters<typeof materializePiRuntime>[0],
  env: Env,
): Promise<void> {
  const baseUrl = required(env.TEAM_PI_CODEX_BASE_URL, "TEAM_PI_CODEX_BASE_URL");
  await sandbox.mkdir(PRIME_AGENT_CONFIG_DIR, { recursive: true });
  await sandbox.writeFile(PRIME_AGENT_EXTENSION_PATH, primeAgentExtensionSource(baseUrl));
  await sandbox.writeFile(`${PRIME_AGENT_CONFIG_DIR}/settings.json`, JSON.stringify(primeAgentSettings()));
}

async function materializeRuntime(
  sandbox: Parameters<typeof materializeOpenCodeCustomization>[0],
  env: Env,
  runtime: CodingSessionRuntime,
  customization: OpenCodeUserCustomization,
): Promise<void> {
  if (runtime === "opencode") return materializeOpenCodeCustomization(sandbox, customization);
  if (runtime === "pi") return materializePiRuntime(sandbox, env);
  return materializePrimeAgentRuntime(sandbox, env);
}

async function materializeOpenCodeCustomization(
  sandbox: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    exec(command: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): Promise<StartupProcess>;
    writeFile(path: string, content: string): Promise<unknown>;
  },
  customization: OpenCodeUserCustomization,
): Promise<void> {
  await sandbox.mkdir(`${OPENCODE_CONFIG_DIR}/command`, { recursive: true });
  await sandbox.mkdir(`${OPENCODE_CONFIG_DIR}/skills`, { recursive: true });
  await waitForOk(await sandbox.exec([
    "sh", "-lc",
    `if [ -d /opt/odie-valhalla/opencode ]; then ` +
      `cp -R /opt/odie-valhalla/opencode/command/. ${OPENCODE_CONFIG_DIR}/command/ && ` +
      `cp -R /opt/odie-valhalla/opencode/skills/. ${OPENCODE_CONFIG_DIR}/skills/; ` +
      `fi`,
  ], { timeout: 30_000 }), 35_000);
  for (const skill of customization.skills) {
    const skillDir = `${OPENCODE_CONFIG_DIR}/skills/${skill.name}`;
    await sandbox.mkdir(skillDir, { recursive: true });
    await sandbox.writeFile(`${skillDir}/SKILL.md`, openCodeSkillMarkdown(skill));
  }
}

function openCodeSkillMarkdown(skill: OpenCodeUserCustomization["skills"][number]): string {
  return `---\nname: ${yamlDoubleQuote(skill.name)}\ndescription: ${yamlDoubleQuote(skill.description)}\n---\n\n${skill.instructions}\n`;
}

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    `\\x${hex.slice(2)}`);
}

function mcpResult(id: unknown, result: unknown): Response {
  // MCP-Protocol-Version is a client request header after initialize, not a server response header.
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function mcpError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function rewriteEditorLocation(location: string, editorOrigin: string, prefix: string): string {
  if (location.startsWith(prefix)) return location;
  if (location.startsWith("/") && !location.startsWith("//")) {
    return `${prefix}${location.slice(1)}`;
  }
  let absolute: URL;
  try {
    absolute = location.startsWith("//") ? new URL(location, editorOrigin) : new URL(location);
  } catch {
    return location;
  }
  const editor = new URL(editorOrigin);
  const isEditorOrigin = absolute.origin === editor.origin;
  const isInternalOrigin = absolute.hostname === "localhost" && absolute.port === String(EDITOR_PORT);
  if (!isEditorOrigin && !isInternalOrigin) return location;
  if (isEditorOrigin && !location.startsWith("//") && absolute.pathname.startsWith(prefix)) {
    return location;
  }
  const pathname = absolute.pathname.startsWith(prefix)
    ? absolute.pathname
    : `${prefix}${absolute.pathname.slice(1)}`;
  return `${pathname}${absolute.search}${absolute.hash}`;
}

function requiredEditorBaseUrl(value: string | undefined): string {
  const configured = new URL(required(value, "EDITOR_BASE_URL"));
  if (configured.protocol !== "https:" || configured.username || configured.password ||
      configured.search || configured.hash || configured.pathname !== "/") {
    throw new Error("EDITOR_BASE_URL must be an HTTPS origin.");
  }
  return configured.origin;
}

type OpenCodeTokenTicket = {
  userId: string;
  sessionId: string;
  sandboxId: string;
  generation: number;
  instanceTier: CodingSessionInstanceTier;
  expiresAt: number;
};

function allowedOpenCodeRoute(
  method: string,
  path: string,
  searchParams: URLSearchParams,
): { ok: true; preserveQuery: boolean } | { ok: false; status: number; message: string } {
  if (path.includes("..") || /%2f|%5c/i.test(path)) return { ok: false, status: 404, message: "OpenCode route is not allowed" };
  const getExact = new Set([
    "/global/health", "/project/current", "/session", "/session/status", "/file/status", "/mcp", "/agent", "/command", "/event",
  ]);
  const getParameterized = /^\/session\/[A-Za-z0-9._:-]{1,128}(?:\/(?:message|diff|todo))?$/.test(path);
  const postAllowed = path === "/session" || /^\/session\/[A-Za-z0-9._:-]{1,128}\/(?:prompt_async|command|abort)$/.test(path);
  if (method === "GET") {
    if (!getExact.has(path) && !getParameterized) return { ok: false, status: 404, message: "OpenCode route is not allowed" };
    const preserveQuery = path === "/event";
    if (!preserveQuery && [...searchParams].length) {
      return { ok: false, status: 400, message: "OpenCode route does not accept query parameters" };
    }
    return { ok: true, preserveQuery };
  }
  if (method === "POST" && postAllowed) {
    if ([...searchParams].length) return { ok: false, status: 400, message: "OpenCode route does not accept query parameters" };
    return { ok: true, preserveQuery: false };
  }
  return { ok: false, status: method === "GET" || method === "POST" ? 404 : 405, message: "OpenCode route is not allowed" };
}

function openCodeProxyHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["Accept", "Content-Type", "Last-Event-ID"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Host", `127.0.0.1:${OPENCODE_SERVER_PORT}`);
  return headers;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function secureProxyResponseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function openCodeCapabilityToken(env: Env, ticket: OpenCodeTokenTicket): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ ...ticket, nonce: randomToken() })));
  const signature = await hmacBase64Url(
    required(env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET"),
    `odie-opencode-server-v1:${payload}`,
  );
  return `${payload}.${signature}`;
}

async function validOpenCodeCapabilityToken(env: Env, token: string): Promise<OpenCodeTokenTicket | null> {
  const [payload, signature, extra] = token.split(".");
  if (extra !== undefined || !payload || !signature) return null;
  let expected: string;
  try {
    expected = await hmacBase64Url(
      required(env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET"),
      `odie-opencode-server-v1:${payload}`,
    );
  } catch {
    return null;
  }
  if (!constantTimeEqual(signature, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (!isOpenCodeTokenTicket(parsed) || parsed.expiresAt < Date.now()) return null;
  return parsed;
}

function isOpenCodeTokenTicket(value: unknown): value is OpenCodeTokenTicket {
  if (!value || typeof value !== "object") return false;
  const ticket = value as Partial<Record<keyof OpenCodeTokenTicket, unknown>>;
  return typeof ticket.userId === "string" && typeof ticket.sessionId === "string" &&
    typeof ticket.sandboxId === "string" && typeof ticket.generation === "number" &&
    typeof ticket.expiresAt === "number" &&
    (ticket.instanceTier === "standard-1" || DEVELOPMENT_CATALOG.enabledTiers.includes(ticket.instanceTier as CodingSessionInstanceTier));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < right.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function editorCapabilityToken(env: Env): Promise<string> {
  const nonce = randomToken();
  const signature = await hmacBase64Url(
    required(env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET"),
    `odie-editor-v1:${nonce}`,
  );
  return `${nonce}.${signature}`;
}

async function validEditorCapabilityToken(env: Env, token: string): Promise<boolean> {
  const [nonce, signature, extra] = token.split(".");
  if (extra !== undefined || !nonce || !signature) return false;
  let expected: string;
  try {
    expected = await hmacBase64Url(
      required(env.EDITOR_CAPABILITY_HMAC_SECRET, "EDITOR_CAPABILITY_HMAC_SECRET"),
      `odie-editor-v1:${nonce}`,
    );
  } catch {
    return false;
  }
  return constantTimeEqual(signature, expected);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

function durableLifecycleEnabled(env: Env): boolean {
  return env.CODING_SESSION_DURABLE_LIFECYCLE_ENABLED === "true";
}

function startupCancellationKey(sessionId: string, generation: number, sandboxId: string): string {
  return `startup-cancelled:${sessionId}:${generation}:${sandboxId}`;
}

function publicStatusFromSupervisor(
  intent: DevelopmentGenerationIntent,
  state: DevelopmentSupervisorState,
): CodingSessionDevelopmentStatus {
  const update = publicDevelopmentSupervisorUpdate(intent, state);
  return {
    sessionId: intent.sessionId,
    generation: intent.generation,
    components: update.components,
    applications: update.applications,
    updatedAt: new Date(state.updatedAt),
  };
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function publicReadOnlyRequest(request: Request): Promise<Response> | Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Package registry request method is not allowed.", { status: 405 });
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return fetch(new Request(request, { headers, redirect: "manual" }));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToStream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
