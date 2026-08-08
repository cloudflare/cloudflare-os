import { DurableObject } from "cloudflare:workers";
import type { RpcStub, RpcTarget } from "cloudflare:workers";
import { reportIssue } from "@gadgets/backend-utils/error-reporting";
import type { ApprovalQueue, HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import {
  buildEvent,
  hashToken,
  MAX_DELIVERIES_PER_MINUTE,
  MAX_DELIVERY_ATTEMPTS,
  MAX_ENDPOINTS_PER_ACCOUNT,
  MAX_ENDPOINTS_PER_WORKSPACE,
  MAX_RETAINED_DELIVERIES,
  mintToken,
  paginateManagementEndpoints,
  retryDelayMs,
  timingSafeEqual,
} from "./endpoint-core.js";
import { obsContext } from "./observability.js";
import type {
  ManagementEndpoint,
  ManagementEndpointPage,
  ManagementListOptions,
} from "./management-types.js";
import type {
  DeliverySummary,
  EndpointCredentials,
  EndpointStatus,
  EndpointSummary,
  WebhookHook,
} from "./types.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.webhook.registry",
  vendorId: "webhook",
});

const ALARM_BATCH_SIZE = 20;
const DELIVERY_CONCURRENCY = 4;
/** How long a claimed delivery may stay in flight before another alarm pass may retake it. */
const LEASE_MS = 5 * 60_000;
/** Consecutive exhausted deliveries before an endpoint reports `failing`. */
const FAILING_THRESHOLD = 1;

const METADATA_KEY = "metadata";
const ENDPOINT_PREFIX = "endpoint:";
const CAPABILITIES_PREFIX = "caps:";
const QUEUE_PREFIX = "queue:";
const LOG_PREFIX = "log:";
const RATE_PREFIX = "rate:";

type WebhookHookTarget = RpcTarget & WebhookHook;
type WebhookInitiator = Fetcher<HookInitiator<WebhookHookTarget>>;

type RegistryMetadata = {
  schemaVersion: 1;
  revoked: boolean;
};

type StoredCapabilities = {
  initiator: WebhookInitiator;
};

type HookResult = {
  callback: RpcStub<WebhookHookTarget>;
  approvalQueue: RpcStub<ApprovalQueue>;
};

/** One registered endpoint. Its identity outlives hook enablement, so a paused URL stays valid. */
export type EndpointRecord = {
  version: 1;
  endpointId: string;
  workspaceId: string;
  /**
   * HMAC of the current bearer token. The raw token is never stored. Absent on an endpoint created
   * from the workspace configurator, which issues no token — such an endpoint rejects every request
   * until the management app generates its first one.
   */
  tokenHash?: string;
  title: string;
  description: string;
  methods: string[];
  createdAt: number;
  /** True once the Workshop hook has been enabled in Connections. */
  enabled: boolean;
  /** The gadget the hook delivers into, when the hook is pinned to one. */
  gadgetId?: number;
  deliveryCount: number;
  failedCount: number;
  lastDeliveryAt?: number;
  consecutiveFailures: number;
};

/** A delivery awaiting its next attempt. Bodies live here only until the delivery settles. */
type QueuedDelivery = {
  version: 1;
  deliveryId: string;
  endpointId: string;
  workspaceId: string;
  receivedAt: number;
  attempt: number;
  dueAt: number;
  leaseExpiresAt?: number;
  method: string;
  subPath: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  bodyBytes: number;
};

/** What the public receiver should answer, decided entirely inside the registry. */
export type ReceiveResult =
  | { accepted: true; deliveryId: string }
  | { accepted: false; status: 401 | 404 | 405 | 429 | 503; message: string };

export type ReceiveInput = {
  endpointId: string;
  token: string | null;
  method: string;
  subPath: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
};

export class EndpointRegistry extends DurableObject<Cloudflare.Env> {
  // -------------------------------------------------------------------------------------------
  // Registration (called by the workspace session)

  /**
   * Creates an endpoint and returns its one-time credentials. The endpoint starts disabled: it
   * exists and holds a valid token, but the receiver answers 503 until its hook is enabled.
   */
  async register(
    workspaceId: string,
    endpointId: string,
    registration: { title: string; description: string; methods: string[] },
    now = Date.now(),
  ): Promise<EndpointCredentials> {
    const token = mintToken();
    await this.create(workspaceId, endpointId, registration, await hashToken(token), now);
    return { endpointId, url: this.#url(endpointId), token };
  }

  /**
   * Creates an endpoint with no token yet, for the workspace configurator: its render pass is
   * synchronous and its form closes on submit, so it has nowhere to show a token exactly once.
   * The endpoint answers 401 to everything until `rotateToken()` issues the first one from the
   * management app, which does have a once-only reveal — and creating a connection therefore never
   * mints a live credential the user might not have copied.
   */
  async createWithoutToken(
    workspaceId: string,
    endpointId: string,
    registration: { title: string; description: string; methods: string[] },
    now = Date.now(),
  ): Promise<{ endpointId: string; url: string }> {
    await this.create(workspaceId, endpointId, registration, undefined, now);
    return { endpointId, url: this.#url(endpointId) };
  }

  private async create(
    workspaceId: string,
    endpointId: string,
    registration: { title: string; description: string; methods: string[] },
    tokenHash: string | undefined,
    now: number,
  ): Promise<void> {
    this.#requireLive();
    this.ctx.storage.transactionSync(() => {
      this.#requireLive();
      this.#assertEndpointQuota(workspaceId);
      this.ctx.storage.kv.put<EndpointRecord>(endpointKey(workspaceId, endpointId), {
        version: 1,
        endpointId,
        workspaceId,
        ...(tokenHash !== undefined ? { tokenHash } : {}),
        title: registration.title,
        description: registration.description,
        methods: registration.methods,
        createdAt: now,
        enabled: false,
        deliveryCount: 0,
        failedCount: 0,
        consecutiveFailures: 0,
      });
    });
    logger.info("webhook endpoint registered", {
      event: "endpoint.registered",
      workspaceId,
      endpointId,
    });
  }

  /**
   * Re-keys an endpoint onto the workspace that bound it. The configurator runs in account context
   * with no workspace to attribute the endpoint to, so it creates the row unassigned; the endpoint
   * becomes a workspace's the first time that workspace opens a session for it.
   */
  async adopt(endpointId: string, workspaceId: string): Promise<void> {
    this.#requireLive();
    this.ctx.storage.transactionSync(() => {
      const found = this.#findEndpoint(endpointId);
      if (!found) throw new Error("Unknown webhook endpoint.");
      if (found.record.workspaceId === workspaceId) return;
      if (found.record.workspaceId) {
        // Re-binding into a second workspace would silently redirect a live URL's deliveries.
        throw new Error("This webhook endpoint is already bound to another workspace.");
      }
      this.#assertEndpointQuota(workspaceId);
      this.ctx.storage.kv.delete(found.key);
      this.ctx.storage.kv.put<EndpointRecord>(endpointKey(workspaceId, endpointId), {
        ...found.record,
        workspaceId,
      });
    });
    logger.info("webhook endpoint adopted", { event: "endpoint.adopted", workspaceId, endpointId });
  }

  /** One endpoint's summary, or undefined when it does not exist (or belongs elsewhere). */
  async getEndpoint(
    endpointId: string,
    workspaceId?: string,
  ): Promise<EndpointSummary | undefined> {
    if (this.#metadata().revoked) return undefined;
    const found = this.#findEndpoint(endpointId, workspaceId);
    return found ? this.#toSummary(found.record) : undefined;
  }

  /** Mints a replacement token, invalidating the previous one immediately. */
  async rotateToken(
    endpointId: string,
    workspaceId?: string,
  ): Promise<EndpointCredentials> {
    this.#requireLive();
    const token = mintToken();
    const tokenHash = await hashToken(token);
    this.ctx.storage.transactionSync(() => {
      const found = this.#findEndpoint(endpointId, workspaceId);
      if (!found) throw new Error("Unknown webhook endpoint.");
      this.ctx.storage.kv.put<EndpointRecord>(found.key, { ...found.record, tokenHash });
    });
    logger.info("webhook token rotated", { event: "endpoint.token.rotated", endpointId });
    return { endpointId, url: this.#url(endpointId), token };
  }

  /**
   * Deletes an endpoint: the URL stops resolving and queued deliveries are dropped. The Workshop
   * hook it was bound to is not ours to delete; it becomes inert and the user removes it in
   * Connections.
   */
  async revokeEndpoint(endpointId: string, workspaceId?: string): Promise<void> {
    let capabilities: StoredCapabilities | undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        const found = this.#findEndpoint(endpointId, workspaceId);
        if (!found) return;
        capabilities = this.ctx.storage.kv.get<StoredCapabilities>(capabilitiesKey(endpointId));
        this.ctx.storage.kv.delete(found.key);
        this.ctx.storage.kv.delete(capabilitiesKey(endpointId));
        this.ctx.storage.kv.delete(rateKey(endpointId));
        this.#deleteByPrefix(`${LOG_PREFIX}${endpointId}:`);
        this.#dropQueued(endpointId);
      });
    } finally {
      disposeCapabilities(capabilities);
    }
    await this.ctx.exports.EndpointIndex.getByName(endpointId).release();
    logger.info("webhook endpoint revoked", { event: "endpoint.revoked", endpointId });
  }

  // -------------------------------------------------------------------------------------------
  // Hook lifecycle (called by the hook controller)

  /** Marks the endpoint live and stores the capability used to reach its workspace callback. */
  async enable(
    workspaceId: string,
    endpointId: string,
    initiator: WebhookInitiator,
    gadgetId?: number,
  ): Promise<void> {
    this.#requireLive();
    let replaced: StoredCapabilities | undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        this.#requireLive();
        const key = endpointKey(workspaceId, endpointId);
        const record = this.ctx.storage.kv.get<EndpointRecord>(key);
        // The hook can outlive its endpoint (revoked here, deleted in Connections later), so a
        // missing record makes enablement a no-op rather than resurrecting a dead URL.
        if (!record) return;
        this.ctx.storage.kv.put<EndpointRecord>(key, {
          ...record,
          enabled: true,
          ...(gadgetId !== undefined ? { gadgetId } : {}),
        });
        replaced = this.ctx.storage.kv.get<StoredCapabilities>(capabilitiesKey(endpointId));
        this.ctx.storage.kv.put<StoredCapabilities>(capabilitiesKey(endpointId), { initiator });
      });
    } finally {
      disposeCapabilities(replaced);
    }
    await this.#planAlarm();
    logger.info("webhook endpoint enabled", { event: "endpoint.enabled", workspaceId, endpointId });
  }

  /**
   * Pauses the endpoint and drops its delivery capability. The endpoint keeps its ID and token, so
   * re-enabling the hook resumes the same URL — unlike a schedule, the URL is already in a third
   * party's configuration and must survive a pause.
   */
  async disable(workspaceId: string, endpointId: string): Promise<void> {
    let capabilities: StoredCapabilities | undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        if (this.#metadata().revoked) return;
        const key = endpointKey(workspaceId, endpointId);
        const record = this.ctx.storage.kv.get<EndpointRecord>(key);
        if (record) this.ctx.storage.kv.put<EndpointRecord>(key, { ...record, enabled: false });
        capabilities = this.ctx.storage.kv.get<StoredCapabilities>(capabilitiesKey(endpointId));
        this.ctx.storage.kv.delete(capabilitiesKey(endpointId));
        this.#dropQueued(endpointId);
      });
    } finally {
      disposeCapabilities(capabilities);
    }
    logger.info("webhook endpoint disabled", {
      event: "endpoint.disabled",
      workspaceId,
      endpointId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Public receive path

  /**
   * Authenticates one inbound request and queues it. Everything the receiver answers is decided
   * here, so the public Worker holds no policy of its own.
   */
  async receive(input: ReceiveInput, now = Date.now()): Promise<ReceiveResult> {
    if (this.#metadata().revoked) return { accepted: false, status: 404, message: "Not found" };
    const found = this.#findEndpoint(input.endpointId);
    if (!found) return { accepted: false, status: 404, message: "Not found" };
    const record = found.record;

    // Authenticate before revealing anything about the endpoint's configuration, so an unauthorized
    // caller cannot probe which methods it accepts or whether it is enabled.
    // An endpoint with no token yet cannot be authenticated against, so nothing is accepted for it.
    if (!input.token || !record.tokenHash) {
      return { accepted: false, status: 401, message: "Unauthorized" };
    }
    const presented = await hashToken(input.token);
    if (!timingSafeEqual(presented, record.tokenHash)) {
      return { accepted: false, status: 401, message: "Unauthorized" };
    }

    if (!record.methods.includes(input.method)) {
      return { accepted: false, status: 405, message: "Method not allowed" };
    }
    if (!record.enabled) {
      return {
        accepted: false,
        status: 503,
        message: "This endpoint is registered but its hook is not enabled yet.",
      };
    }
    if (!this.#admitRate(record.endpointId, now)) {
      return { accepted: false, status: 429, message: "Too many requests" };
    }

    const deliveryId = crypto.randomUUID();
    const bodyBytes = new TextEncoder().encode(input.body).length;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put<QueuedDelivery>(queueKey(now, deliveryId), {
        version: 1,
        deliveryId,
        endpointId: record.endpointId,
        workspaceId: record.workspaceId,
        receivedAt: now,
        attempt: 0,
        dueAt: now,
        method: input.method,
        subPath: input.subPath,
        query: input.query,
        headers: input.headers,
        body: input.body,
        truncated: input.truncated,
        bodyBytes,
      });
      this.ctx.storage.kv.put<EndpointRecord>(found.key, {
        ...record,
        deliveryCount: record.deliveryCount + 1,
        lastDeliveryAt: now,
      });
      this.#writeLog({
        deliveryId,
        endpointId: record.endpointId,
        receivedAt: now,
        method: input.method,
        bodyBytes,
        outcome: "queued",
        attempts: 0,
      });
    });
    await this.#planAlarm();
    logger.info("webhook delivery accepted", {
      event: "delivery.accepted",
      endpointId: record.endpointId,
      deliveryId,
    });
    return { accepted: true, deliveryId };
  }

  // -------------------------------------------------------------------------------------------
  // Reads

  async listWorkspace(workspaceId: string): Promise<EndpointSummary[]> {
    if (this.#metadata().revoked) return [];
    return this.#listEndpoints(`${ENDPOINT_PREFIX}${workspaceId}:`)
      .map((record) => this.#toSummary(record))
      .toSorted((a, b) => b.createdAt - a.createdAt);
  }

  async listAccount(options?: ManagementListOptions): Promise<ManagementEndpointPage> {
    if (this.#metadata().revoked) return { endpoints: [] };
    const endpoints: ManagementEndpoint[] = this.#listEndpoints().map((record) => ({
      ...this.#toSummary(record),
      workspaceId: record.workspaceId,
      ...(record.gadgetId !== undefined ? { gadgetId: record.gadgetId } : {}),
    }));
    return paginateManagementEndpoints(endpoints, options);
  }

  /** Recent deliveries, newest first, for one endpoint or for one workspace. */
  async listDeliveries(
    endpointId?: string,
    workspaceId?: string,
    limit = MAX_RETAINED_DELIVERIES,
  ): Promise<DeliverySummary[]> {
    if (this.#metadata().revoked) return [];
    const bounded = Math.min(Math.max(Math.floor(limit) || 0, 1), MAX_RETAINED_DELIVERIES);
    const allowed = workspaceId
      ? new Set(this.#listEndpoints(`${ENDPOINT_PREFIX}${workspaceId}:`).map((r) => r.endpointId))
      : undefined;
    if (endpointId !== undefined && allowed && !allowed.has(endpointId)) return [];

    const prefix = endpointId === undefined ? LOG_PREFIX : `${LOG_PREFIX}${endpointId}:`;
    const results: DeliverySummary[] = [];
    for (const [, value] of this.ctx.storage.kv.list<DeliverySummary>({ prefix })) {
      if (allowed && !allowed.has(value.endpointId)) continue;
      results.push(value);
    }
    // Log keys sort newest-first within an endpoint; a cross-endpoint scan still needs a merge.
    return results.toSorted((a, b) => b.receivedAt - a.receivedAt).slice(0, bounded);
  }

  // -------------------------------------------------------------------------------------------
  // Account lifecycle

  /** Permanently revokes the account: every endpoint stops resolving and all state is dropped. */
  async revoke(): Promise<void> {
    const endpointIds = this.#listEndpoints().map((record) => record.endpointId);
    for (const endpointId of endpointIds) {
      const capabilities = this.ctx.storage.kv.get<StoredCapabilities>(capabilitiesKey(endpointId));
      disposeCapabilities(capabilities);
    }
    this.ctx.storage.kv.put<RegistryMetadata>(METADATA_KEY, { schemaVersion: 1, revoked: true });
    this.#deleteByPrefix(ENDPOINT_PREFIX);
    this.#deleteByPrefix(CAPABILITIES_PREFIX);
    this.#deleteByPrefix(QUEUE_PREFIX);
    this.#deleteByPrefix(LOG_PREFIX);
    this.#deleteByPrefix(RATE_PREFIX);
    // Release the public IDs last: after this, the URLs 404 even if the registry write is retried.
    await Promise.all(
      endpointIds.map((endpointId) =>
        this.ctx.exports.EndpointIndex.getByName(endpointId).release(),
      ),
    );
    logger.info("webhook account revoked", { event: "account.revoked" });
  }

  // -------------------------------------------------------------------------------------------
  // Delivery

  async alarm(): Promise<void> {
    await obsContext.with({ accountId: this.ctx.id.toString(), operation: "alarm" }, async () => {
      const startedAt = Date.now();
      try {
        const { batchSize, backlogCount } = await this.#runAlarm();
        logger.debug("webhook alarm batch completed", {
          event: "webhook.alarm.completed",
          durationMs: Date.now() - startedAt,
          batchSize,
          backlogCount,
        });
      } catch (error) {
        logger.error("webhook alarm failed", { event: "webhook.alarm.failed", error });
        reportIssue("webhook.alarm", error, { attributes: obsContext.get() });
        throw error;
      }
    });
  }

  async #runAlarm(): Promise<{ batchSize: number; backlogCount: number }> {
    if (this.#metadata().revoked) return { batchSize: 0, backlogCount: 0 };
    const now = Date.now();
    const due = this.#claimDue(now);
    for (let i = 0; i < due.length; i += DELIVERY_CONCURRENCY) {
      await Promise.all(
        due.slice(i, i + DELIVERY_CONCURRENCY).map((delivery) => this.#deliverSafely(delivery)),
      );
    }
    const backlogCount = this.#queuedCount();
    await this.#planAlarm();
    return { batchSize: due.length, backlogCount };
  }

  /** Takes up to one batch of due deliveries, stamping a lease so a second pass can't double-send. */
  #claimDue(now: number): QueuedDelivery[] {
    return this.ctx.storage.transactionSync(() => {
      // Materialize before mutating: list() is a lazy generator over storage, so writing back into
      // the same prefix mid-iteration can yield a row twice — and a twice-claimed delivery is a
      // duplicate call into the workspace.
      const queued = [...this.ctx.storage.kv.list<QueuedDelivery>({ prefix: QUEUE_PREFIX })];
      const claimed: QueuedDelivery[] = [];
      for (const [key, delivery] of queued) {
        if (claimed.length >= ALARM_BATCH_SIZE) break;
        if (delivery.dueAt > now) continue;
        if (delivery.leaseExpiresAt !== undefined && delivery.leaseExpiresAt > now) continue;
        const next: QueuedDelivery = {
          ...delivery,
          attempt: delivery.attempt + 1,
          leaseExpiresAt: now + LEASE_MS,
        };
        this.ctx.storage.kv.put<QueuedDelivery>(key, next);
        claimed.push(next);
      }
      return claimed;
    });
  }

  async #deliverSafely(delivery: QueuedDelivery): Promise<void> {
    await obsContext.with(
      {
        endpointId: delivery.endpointId,
        workspaceId: delivery.workspaceId,
        deliveryId: delivery.deliveryId,
        attempt: delivery.attempt,
      },
      async () => {
        try {
          await this.#deliver(delivery);
        } catch (error) {
          logger.error("unexpected webhook delivery failure", {
            event: "delivery.unexpected",
            error,
          });
          reportIssue("webhook.delivery", error, { handled: true, attributes: obsContext.get() });
          this.#settleFailure(delivery, "Delivery failed unexpectedly.");
        }
      },
    );
  }

  async #deliver(delivery: QueuedDelivery): Promise<void> {
    const capabilities = this.ctx.storage.kv.get<StoredCapabilities>(
      capabilitiesKey(delivery.endpointId),
    );
    if (!capabilities) {
      // The hook was disabled between accept and delivery. Drop rather than retry: re-enabling
      // should not replay a payload the third party has long since moved past.
      this.#settleFailure(delivery, "The endpoint's hook was disabled before delivery.", true);
      return;
    }

    let hookResult: HookResult | undefined;
    try {
      // @ts-expect-error Worker RPC promises are disposable even though the mapped type omits it.
      using hookCall = capabilities.initiator.startHook();
      try {
        // Await admission rather than pipeline: a rejection must settle this delivery before either
        // returned capability is used.
        // @ts-expect-error Worker RPC's mapped return type wraps the already-stubbed hook result.
        hookResult = await hookCall;
      } catch {
        this.#settleFailure(delivery, "The workspace declined the delivery.");
        return;
      }
      if (!hookResult) {
        this.#settleFailure(delivery, "The workspace declined the delivery.");
        return;
      }

      const event = buildEvent({
        deliveryId: delivery.deliveryId,
        endpointId: delivery.endpointId,
        receivedAt: delivery.receivedAt,
        attempt: delivery.attempt,
        method: delivery.method,
        subPath: delivery.subPath,
        query: delivery.query,
        headers: delivery.headers,
        body: delivery.body,
        truncated: delivery.truncated,
      });

      try {
        // The payload is third-party input, so it enters the workspace as an observation. The
        // description names the source and shape only — never the body, which is untrusted and may
        // carry secrets the workspace should not have echoed into its action log.
        await hookResult.approvalQueue.authorizeObservation({
          title: `Webhook delivery: ${delivery.method} ${delivery.endpointId}`,
          description:
            `Deliver inbound webhook ${delivery.deliveryId} received at ` +
            `${new Date(delivery.receivedAt).toISOString()} (${delivery.bodyBytes} bytes).`,
        });
      } catch {
        this.#settleFailure(delivery, "Observation authorization was denied.");
        return;
      }

      try {
        await hookResult.callback.onWebhook(event);
      } catch {
        this.#settleFailure(delivery, "The workspace callback threw.");
        return;
      }
      this.#settleSuccess(delivery);
    } finally {
      disposeStub(capabilities.initiator);
    }
  }

  #settleSuccess(delivery: QueuedDelivery): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.delete(queueKey(delivery.receivedAt, delivery.deliveryId));
      this.#writeLog({
        deliveryId: delivery.deliveryId,
        endpointId: delivery.endpointId,
        receivedAt: delivery.receivedAt,
        method: delivery.method,
        bodyBytes: delivery.bodyBytes,
        outcome: "delivered",
        attempts: delivery.attempt,
      });
      this.#updateEndpoint(delivery, (record) => ({ ...record, consecutiveFailures: 0 }));
    });
    logger.info("webhook delivered", { event: "delivery.delivered" });
  }

  /** Records a failed attempt, rescheduling it unless the attempt budget is spent. */
  #settleFailure(delivery: QueuedDelivery, error: string, terminal = false): void {
    const exhausted = terminal || delivery.attempt >= MAX_DELIVERY_ATTEMPTS;
    this.ctx.storage.transactionSync(() => {
      const key = queueKey(delivery.receivedAt, delivery.deliveryId);
      if (exhausted) {
        this.ctx.storage.kv.delete(key);
        this.#updateEndpoint(delivery, (record) => ({
          ...record,
          failedCount: record.failedCount + 1,
          consecutiveFailures: record.consecutiveFailures + 1,
        }));
      } else {
        const { leaseExpiresAt: _lease, ...rest } = delivery;
        this.ctx.storage.kv.put<QueuedDelivery>(key, {
          ...rest,
          dueAt: Date.now() + retryDelayMs(delivery.attempt + 1),
        });
      }
      this.#writeLog({
        deliveryId: delivery.deliveryId,
        endpointId: delivery.endpointId,
        receivedAt: delivery.receivedAt,
        method: delivery.method,
        bodyBytes: delivery.bodyBytes,
        outcome: exhausted ? "failed" : "queued",
        attempts: delivery.attempt,
        error,
      });
    });
    logger.warn("webhook delivery attempt failed", {
      event: exhausted ? "delivery.failed" : "delivery.retry",
    });
  }

  // -------------------------------------------------------------------------------------------
  // Storage helpers

  #metadata(): RegistryMetadata {
    const stored = this.ctx.storage.kv.get<RegistryMetadata>(METADATA_KEY);
    if (stored) return stored;
    const fresh: RegistryMetadata = { schemaVersion: 1, revoked: false };
    this.ctx.storage.kv.put<RegistryMetadata>(METADATA_KEY, fresh);
    return fresh;
  }

  #requireLive(): void {
    if (this.#metadata().revoked) throw new Error("This Webhooks account has been disconnected.");
  }

  #url(endpointId: string): string {
    return `${this.env.BASE_URL.replace(/\/+$/, "")}/e/${endpointId}`;
  }

  #toSummary(record: EndpointRecord): EndpointSummary {
    const summary: EndpointSummary = {
      endpointId: record.endpointId,
      title: record.title,
      description: record.description,
      url: this.#url(record.endpointId),
      hasToken: record.tokenHash !== undefined,
      methods: record.methods,
      status: statusOf(record),
      createdAt: record.createdAt,
      deliveryCount: record.deliveryCount,
      failedCount: record.failedCount,
    };
    if (record.lastDeliveryAt !== undefined) summary.lastDeliveryAt = record.lastDeliveryAt;
    return summary;
  }

  #listEndpoints(prefix = ENDPOINT_PREFIX): EndpointRecord[] {
    return [...this.ctx.storage.kv.list<EndpointRecord>({ prefix })].map(([, record]) => record);
  }

  /** Endpoint IDs are globally unique, so a workspace-scoped lookup is a scan plus a filter. */
  #findEndpoint(
    endpointId: string,
    workspaceId?: string,
  ): { key: string; record: EndpointRecord } | undefined {
    if (workspaceId !== undefined) {
      const key = endpointKey(workspaceId, endpointId);
      const record = this.ctx.storage.kv.get<EndpointRecord>(key);
      return record ? { key, record } : undefined;
    }
    for (const [key, record] of this.ctx.storage.kv.list<EndpointRecord>({
      prefix: ENDPOINT_PREFIX,
    })) {
      if (record.endpointId === endpointId) return { key, record };
    }
    return undefined;
  }

  #updateEndpoint(
    delivery: QueuedDelivery,
    update: (record: EndpointRecord) => EndpointRecord,
  ): void {
    const key = endpointKey(delivery.workspaceId, delivery.endpointId);
    const record = this.ctx.storage.kv.get<EndpointRecord>(key);
    if (record) this.ctx.storage.kv.put<EndpointRecord>(key, update(record));
  }

  #assertEndpointQuota(workspaceId: string): void {
    const all = this.#listEndpoints();
    if (all.length >= MAX_ENDPOINTS_PER_ACCOUNT) {
      throw new Error(`This account already has ${MAX_ENDPOINTS_PER_ACCOUNT} webhook endpoints.`);
    }
    const mine = all.filter((record) => record.workspaceId === workspaceId);
    if (mine.length >= MAX_ENDPOINTS_PER_WORKSPACE) {
      throw new Error(
        `This workspace already has ${MAX_ENDPOINTS_PER_WORKSPACE} webhook endpoints.`,
      );
    }
  }

  /** Fixed-window rate limiting per endpoint. Cheap, and a coarse window is enough to shed floods. */
  #admitRate(endpointId: string, now: number): boolean {
    const key = rateKey(endpointId);
    const window = Math.floor(now / 60_000);
    const stored = this.ctx.storage.kv.get<{ window: number; count: number }>(key);
    if (!stored || stored.window !== window) {
      this.ctx.storage.kv.put(key, { window, count: 1 });
      return true;
    }
    if (stored.count >= MAX_DELIVERIES_PER_MINUTE) return false;
    this.ctx.storage.kv.put(key, { window, count: stored.count + 1 });
    return true;
  }

  #writeLog(summary: DeliverySummary): void {
    this.ctx.storage.kv.put<DeliverySummary>(
      logKey(summary.endpointId, summary.receivedAt, summary.deliveryId),
      summary,
    );
    const prefix = `${LOG_PREFIX}${summary.endpointId}:`;
    const keys = [...this.ctx.storage.kv.list<DeliverySummary>({ prefix })].map(([key]) => key);
    for (const key of keys.slice(MAX_RETAINED_DELIVERIES)) this.ctx.storage.kv.delete(key);
  }

  // Both helpers materialize before deleting, for the same reason as #claimDue.
  #dropQueued(endpointId: string): void {
    const queued = [...this.ctx.storage.kv.list<QueuedDelivery>({ prefix: QUEUE_PREFIX })];
    for (const [key, delivery] of queued) {
      if (delivery.endpointId === endpointId) this.ctx.storage.kv.delete(key);
    }
  }

  #deleteByPrefix(prefix: string): void {
    const keys = [...this.ctx.storage.kv.list({ prefix })].map(([key]) => key);
    for (const key of keys) this.ctx.storage.kv.delete(key);
  }

  #queuedCount(): number {
    return [...this.ctx.storage.kv.list({ prefix: QUEUE_PREFIX })].length;
  }

  /** Arms the alarm for the earliest queued delivery, or clears it when the queue drains. */
  async #planAlarm(): Promise<void> {
    let earliest: number | undefined;
    for (const [, delivery] of this.ctx.storage.kv.list<QueuedDelivery>({ prefix: QUEUE_PREFIX })) {
      earliest = earliest === undefined ? delivery.dueAt : Math.min(earliest, delivery.dueAt);
    }
    if (earliest === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > earliest) await this.ctx.storage.setAlarm(earliest);
  }
}

function statusOf(record: EndpointRecord): EndpointStatus {
  if (!record.enabled) return "disabled";
  return record.consecutiveFailures >= FAILING_THRESHOLD ? "failing" : "active";
}

function endpointKey(workspaceId: string, endpointId: string): string {
  return `${ENDPOINT_PREFIX}${workspaceId}:${endpointId}`;
}

function capabilitiesKey(endpointId: string): string {
  return `${CAPABILITIES_PREFIX}${endpointId}`;
}

function rateKey(endpointId: string): string {
  return `${RATE_PREFIX}${endpointId}`;
}

/** Queue keys sort oldest-first so the alarm can stop scanning at the first not-yet-due delivery. */
function queueKey(receivedAt: number, deliveryId: string): string {
  return `${QUEUE_PREFIX}${String(receivedAt).padStart(15, "0")}:${deliveryId}`;
}

/** Log keys sort newest-first within an endpoint, so trimming is a tail slice. */
function logKey(endpointId: string, receivedAt: number, deliveryId: string): string {
  const inverted = String(9_999_999_999_999 - receivedAt).padStart(15, "0");
  return `${LOG_PREFIX}${endpointId}:${inverted}:${deliveryId}`;
}

function disposeCapabilities(capabilities: StoredCapabilities | undefined): void {
  if (capabilities) disposeStub(capabilities.initiator);
}

function disposeStub(stub: unknown): void {
  (stub as { [Symbol.dispose]?: () => void })?.[Symbol.dispose]?.();
}
