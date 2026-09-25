import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  GitCache,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ObservationDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { privateObservers } from "@gadgets/gatekeeper-kit/observers";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { obsContext } from "./observability.js";
import {
  provisionNotificationInstallation,
  provisionNotificationPolicy,
  removeNotificationConnection,
  removeNotificationPolicy,
  isNotificationAccessDenied,
  type NotificationInstallation,
  type NotificationPolicy,
} from "./notifications-api.js";
import {
  generateWebhookApiKey,
  hashWebhookApiKey,
  matchesWebhookApiKey,
  MAX_NOTIFICATION_BODY_BYTES,
  notificationReceiverName,
  configuredNotificationBaseUrl,
  notificationWebhookBaseUrl,
  parseNotificationWebhook,
  isWebhookTest,
} from "./notifications-webhook.js";
import { accountNotificationsUrl, NOTIFICATIONS_SCOPE } from "./resources.js";
import type {
  CloudflareNotification,
  CloudflareNotificationHook,
  CloudflareNotificationsSession,
  CloudflareNotificationSubscription,
  CloudflareNotificationStatus,
} from "./types.js";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.notifications",
  vendorId: VENDOR_ID,
});
const observers = privateObservers(
  "Cloudflare notification bindings are private to their connected owner.",
);
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_DELIVERIES = 10_000;
const MAX_HOOKS = 100;

type NotificationEnv = Cloudflare.Env & {
  BASE_URL?: string;
  NOTIFICATIONS_WEBHOOK_BASE_URL?: string;
};
type HookTarget = RpcTarget & CloudflareNotificationHook;
type NotificationsProps = { userObjectId: string; accountId: string };
type HookProps = NotificationsProps & { hookId: string; alertType: string };
type StoredHook = { props: HookProps; initiator: Fetcher<HookInitiator<HookTarget>> };
type Installation = NotificationInstallation & NotificationsProps & { authHash: string };
type PolicyIntent = Partial<NotificationPolicy> & { alertType: string; needsReconcile?: boolean };

function disposeHook(hook: StoredHook | undefined): void {
  (hook?.initiator as (Fetcher<HookInitiator<HookTarget>> & Partial<Disposable>) | undefined)
    ?.[Symbol.dispose]?.();
}

/** A fixed set of credential shards keeps unknown URLs from creating receiver objects. */
export class CloudflareNotificationRegistry extends DurableObject<NotificationEnv> {
  async authorize(name: string, apiKey: string): Promise<boolean> {
    const hash = this.ctx.storage.kv.get<string>(name);
    return hash !== undefined && matchesWebhookApiKey(apiKey, hash);
  }
  register(name: string, hash: string): void {
    this.ctx.storage.kv.put(name, hash);
  }
  remove(name: string): void {
    this.ctx.storage.kv.delete(name);
  }
}

/** The credential shard holding a receiver's webhook verifier. */
export function notificationRegistry(exports: Cloudflare.Exports, receiverName: string) {
  return exports.CloudflareNotificationRegistry.getByName(receiverName.slice(0, 2));
}

function registry(ctx: DurableObjectState, props: NotificationsProps) {
  return notificationRegistry(ctx.exports,
    notificationReceiverName(props.userObjectId, props.accountId));
}

function receiver(ctx: DurableObjectState<NotificationsProps>, props: NotificationsProps) {
  return ctx.exports.CloudflareNotificationReceiver.getByName(
    notificationReceiverName(props.userObjectId, props.accountId),
  );
}

function auditIdentifier(value: string | undefined): string {
  if (value === undefined) return "not provided";
  return /^[A-Za-z0-9_./:-]{1,120}$/.test(value) ? value : "value omitted";
}

function notificationObservation(notification: CloudflareNotification): ObservationDescription {
  const alertType = auditIdentifier(notification.alertType);
  return {
    title: `Cloudflare notification: ${alertType}`,
    description: `Receive an authenticated Cloudflare notification for account ${notification.accountId}. ` +
      `Alert type: ${alertType}; policy ID: ${auditIdentifier(notification.policyId)}; ` +
      `event state: ${auditIdentifier(notification.event)}. The body includes free-form text and ` +
      "product-specific evidence.",
    containsRestrictedData: true,
  };
}

@validateRpc()
class CloudflareNotificationsSessionImpl
  extends RpcTarget
  implements CloudflareNotificationsSession
{
  #ctx: DurableObjectState<NotificationsProps>;
  #queue: RpcStub<ApprovalQueue>;
  constructor(ctx: DurableObjectState<NotificationsProps>, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#ctx = ctx;
    this.#queue = queue;
  }
  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
  async subscribe(
    callback: RpcStub<HookTarget>,
    subscription: CloudflareNotificationSubscription,
  ): Promise<void> {
    if (!subscription || typeof subscription.alertType !== "string" ||
      !/^[a-z][a-z0-9_]{0,99}$/.test(subscription.alertType))
      throw new Error("Choose one valid Cloudflare alert type for this hook.");
    const props: HookProps = {
      ...this.#ctx.props,
      hookId: crypto.randomUUID(),
      alertType: subscription.alertType,
    };
    const controller = this.#ctx.exports.CloudflareNotificationHookController({ props });
    await this.#queue.bindHook(controller, callback, {
      title: `Cloudflare ${props.alertType} alerts for ${props.accountId}`,
      description: `When enabled, create or share a Cloudflare notification policy for ${props.alertType} ` +
        `in account ${props.accountId}, deliver its alerts to this workspace, and remove the policy ` +
        "when the last hook for this alert type is disabled.",
    });
  }
  async getStatus(): Promise<CloudflareNotificationStatus> {
    await this.#queue.authorizeObservation({
      title: `Cloudflare notification status for ${this.#ctx.props.accountId}`,
      description: `Read destination and managed policy IDs, subscriber count, and recent delivery times for Cloudflare account ${this.#ctx.props.accountId}.`,
      containsRestrictedData: true,
    });
    return receiver(this.#ctx, this.#ctx.props).getStatus();
  }
}

@validateRpc()
export class CloudflareNotificationsGatekeeper
  extends DurableObject<NotificationEnv, NotificationsProps>
  implements Gatekeeper<CloudflareNotificationsSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: accountNotificationsUrl(this.ctx.props.accountId),
      title: "Cloudflare Notifications",
      snippet: "Receive Cloudflare alerts in this workspace through a managed webhook.",
      suggestedBindingName: "CLOUDFLARE_NOTIFICATIONS",
      tsType: "CloudflareNotificationsSession",
      hookTsType: "CloudflareNotificationHook",
    };
  }
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<CloudflareNotificationsSession> {
    return new CloudflareNotificationsSessionImpl(this.ctx, queue.dup());
  }
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await observers.addObserver(id, user);
  }
  async removeObserver(id: string): Promise<void> {
    await observers.removeObserver(id);
  }
  async applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("This resource exposes hooks, not actions.");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("This resource exposes hooks, not actions.");
  }
  async revertAction(_action: number): Promise<void> {
    throw new Error("This resource exposes hooks, not actions.");
  }
}

@validateRpc()
export class CloudflareNotificationHookController
  extends WorkerEntrypoint<NotificationEnv, HookProps>
  implements HookController<HookTarget>
{
  #receiver() {
    return this.ctx.exports.CloudflareNotificationReceiver.getByName(
      notificationReceiverName(this.ctx.props.userObjectId, this.ctx.props.accountId),
    );
  }
  async enable(
    initiator: Fetcher<HookInitiator<HookTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await this.#receiver().enable(this.ctx.props, initiator);
  }
  async disable(): Promise<void> {
    await this.#receiver().disable(this.ctx.props.hookId, this.ctx.props.alertType);
  }
}

/** Webhook handoff per connection/account. ANS owns retries; only successful receipts are stored. */
export class CloudflareNotificationReceiver extends DurableObject<NotificationEnv> {
  #mutations = new SerialTaskQueue();
  #provisioning?: Promise<void>;
  #inFlight = new Map<string, Promise<boolean>>();
  constructor(ctx: DurableObjectState, env: NotificationEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_receipts (
      notification_id TEXT NOT NULL, hook_id TEXT NOT NULL, delivered_at INTEGER NOT NULL,
      PRIMARY KEY(notification_id, hook_id))`);
  }

  #account(userObjectId: string) {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(userObjectId),
    );
  }
  async #hasCredentials(owner: NotificationsProps): Promise<boolean> {
    const account = this.#account(owner.userObjectId);
    const [scopes, token] = await Promise.all([
      account.getGrantedScopes(),
      account.getAccessToken(),
    ]);
    return scopes.includes(NOTIFICATIONS_SCOPE) && token !== null;
  }
  #hooks() {
    return [...this.ctx.storage.kv.list<StoredHook>({ prefix: "hook:" })].map(([, hook]) => hook);
  }
  #hookCount(): number {
    const hooks = this.#hooks();
    for (const hook of hooks) disposeHook(hook);
    return hooks.length;
  }
  #policies(): [string, PolicyIntent][] {
    return [...this.ctx.storage.kv.list<PolicyIntent>({ prefix: "policy:" })];
  }
  async #token(owner: NotificationsProps): Promise<string> {
    const account = this.#account(owner.userObjectId);
    if (!(await account.getGrantedScopes()).includes(NOTIFICATIONS_SCOPE))
      throw new Error("Reconnect Cloudflare with Notifications access first.");
    const token = await account.getAccessToken();
    if (!token) throw new Error("Reconnect Cloudflare before managing notifications.");
    return token;
  }

  async #provision(props: NotificationsProps): Promise<void> {
    const token = await this.#token(props);
    const base = notificationWebhookBaseUrl(configuredNotificationBaseUrl(this.env));
    // Record ownership before external side effects, so disconnect can stop incomplete setup.
    await this.#account(props.userObjectId).registerNotificationAccount(props.accountId);
    const webhookUrl = `${base}/webhooks/${props.userObjectId}/${props.accountId}`;
    this.ctx.storage.kv.put("webhookUrl", webhookUrl);
    const apiKey = generateWebhookApiKey();
    const authHash = await hashWebhookApiKey(apiKey);
    this.ctx.storage.kv.put("pendingAuthHash", authHash);
    this.ctx.storage.kv.put("owner", props);
    const credentialRegistry = registry(this.ctx, props);
    try {
      await credentialRegistry.register(notificationReceiverName(props.userObjectId, props.accountId), authHash);
      const installation = await provisionNotificationInstallation(
        token,
        props.accountId,
        webhookUrl,
        apiKey,
      );
      this.ctx.storage.kv.put<Installation>("installation", {
        ...installation,
        ...props,
        authHash,
      });
      this.ctx.storage.kv.put("setupComplete", true);
    } catch (error) {
      await credentialRegistry.remove(notificationReceiverName(props.userObjectId, props.accountId));
      throw error;
    } finally {
      this.ctx.storage.kv.delete("pendingAuthHash");
    }
  }

  async enable(props: HookProps, initiator: Fetcher<HookInitiator<HookTarget>>): Promise<void> {
    await this.#mutations.run(async () => {
      const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
      if (owner && (owner.accountId !== props.accountId || owner.userObjectId !== props.userObjectId))
        throw new Error("Notification receiver belongs to another account.");
      if (this.ctx.storage.kv.get("suspended"))
        throw new Error("This notification connection has been disconnected.");
      const key = `hook:${props.hookId}`;
      const existing = this.ctx.storage.kv.get<StoredHook>(key);
      const alreadyEnabled = existing !== undefined;
      disposeHook(existing);
      if (!alreadyEnabled && this.#hookCount() >= MAX_HOOKS)
        throw new Error("This notification connection has reached its subscriber limit.");
      if (!this.ctx.storage.kv.get("setupComplete")) {
        this.#provisioning = this.#provision(props).finally(() => {
          this.#provisioning = undefined;
        });
        await this.#provisioning;
      }
      if (this.ctx.storage.kv.get("suspended"))
        throw new Error("This notification connection has been disconnected.");
      const installation = this.ctx.storage.kv.get<Installation>("installation");
      if (!installation) throw new Error("Notification destination setup is incomplete.");
      const policyKey = `policy:${props.alertType}`;
      const priorPolicy = this.ctx.storage.kv.get<PolicyIntent>(policyKey);
      if (!priorPolicy) this.ctx.storage.kv.put<PolicyIntent>(policyKey, { alertType: props.alertType });
      if (!priorPolicy?.policyId || priorPolicy.needsReconcile) {
        const policy = await provisionNotificationPolicy(
          await this.#token(props), props.accountId, installation.webhookId,
          props.alertType, props.userObjectId,
        );
        this.ctx.storage.kv.put<PolicyIntent>(policyKey, { alertType: props.alertType, ...policy });
      }
      const replaced = this.ctx.storage.kv.get<StoredHook>(key);
      try {
        this.ctx.storage.kv.put<StoredHook>(key, { props, initiator });
      } finally {
        disposeHook(replaced);
      }
      // A connection-removal disable is best-effort and never retried by the Workshop, and an
      // interrupted enable leaves an intent with no hook; retry either here rather than leak it.
      for (const [, policy] of this.#policies()) {
        if (policy.alertType === props.alertType) continue;
        await this.#removeUnusedPolicy(policy.alertType).catch((error: unknown) =>
          logger.warn("orphaned notification policy cleanup failed", {
            event: "notification.policy.cleanup.failed",
            accountId: props.accountId,
            error,
          }));
      }
    });
  }

  async disable(hookId: string, alertType: string): Promise<void> {
    await this.#mutations.run(async () => {
      const key = `hook:${hookId}`;
      const existing = this.ctx.storage.kv.get<StoredHook>(key);
      if (existing && existing.props.alertType !== alertType)
        throw new Error("Notification hook alert type mismatch.");
      this.ctx.storage.kv.delete(key);
      disposeHook(existing);
      await Promise.allSettled([...this.#inFlight]
        .filter(([deliveryKey]) => deliveryKey.endsWith(`:${hookId}`))
        .map(([, delivery]) => delivery));
      this.ctx.storage.sql.exec("DELETE FROM notification_receipts WHERE hook_id = ?", hookId);
      await this.#removeUnusedPolicy(alertType);
    });
  }

  /** Delete the managed policy for an alert type once no hook uses it. Callers hold #mutations. */
  async #removeUnusedPolicy(alertType: string): Promise<void> {
    const policyKey = `policy:${alertType}`;
    const policy = this.ctx.storage.kv.get<PolicyIntent>(policyKey);
    if (!policy) return;
    const hooks = this.#hooks();
    const stillUsed = hooks.some((hook) => hook.props.alertType === alertType);
    for (const hook of hooks) disposeHook(hook);
    if (stillUsed) return;
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    if (!owner) throw new Error("Notification policy owner is missing.");
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    if (!installation) throw new Error("Notification destination is missing.");
    this.ctx.storage.kv.put<PolicyIntent>(policyKey, { ...policy, needsReconcile: true });
    await removeNotificationPolicy(await this.#token(owner), owner.accountId,
      owner.userObjectId, alertType, installation.webhookId,
      policy.policyId ? { policyId: policy.policyId } : undefined);
    this.ctx.storage.kv.delete(policyKey);
  }
  async suspend(): Promise<void> {
    this.ctx.storage.kv.put("suspended", true);
    // Wait for provider setup and already-started callbacks before deleting their resources.
    await this.#mutations.run(async () => {
      await Promise.all(this.#inFlight.values());
      await this.#provisioning?.catch(() => undefined);
    });
  }
  /**
   * Stop delivery, then delete this connection's provider resources. A null token (the grant is
   * gone) or an access-denied response can never succeed on retry, so those skip provider cleanup
   * rather than wedge disconnect; any other failure propagates so the caller can retry.
   */
  async revokeWithToken(token: string | null): Promise<void> {
    await this.suspend();
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    if (owner) {
      const skip = (reason: unknown) => logger.warn("notification provider cleanup skipped", {
        event: "notification.revoke.cleanup.skipped",
        accountId: owner.accountId,
        error: reason,
      });
      if (!token) skip("Cloudflare credentials are no longer available.");
      else {
        try {
          await this.#removeProviderResources(token, owner);
        } catch (error) {
          if (!isNotificationAccessDenied(error)) throw error;
          skip(error);
        }
      }
      await registry(this.ctx, owner).remove(notificationReceiverName(owner.userObjectId, owner.accountId));
    }
    // Keep a tombstone so outstanding controller capabilities cannot resurrect this receiver.
    for (const [key, value] of this.ctx.storage.kv.list()) {
      if (key !== "suspended") this.ctx.storage.kv.delete(key);
      if (key.startsWith("hook:")) disposeHook(value as StoredHook);
    }
    this.ctx.storage.sql.exec("DELETE FROM notification_receipts");
  }

  async #removeProviderResources(token: string, owner: NotificationsProps): Promise<void> {
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const webhookUrl = this.ctx.storage.kv.get<string>("webhookUrl");
    for (const [key, policy] of this.#policies()) {
      if (!installation) throw new Error("Notification destination is missing.");
      await removeNotificationPolicy(token, owner.accountId, owner.userObjectId,
        key.slice("policy:".length), installation.webhookId,
        policy.policyId ? { policyId: policy.policyId } : undefined);
      this.ctx.storage.kv.delete(key);
    }
    if (webhookUrl)
      await removeNotificationConnection(token, owner.accountId, webhookUrl, installation);
  }

  async getStatus(): Promise<CloudflareNotificationStatus> {
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    return {
      installed: !!this.ctx.storage.kv.get("setupComplete"),
      suspended: !!this.ctx.storage.kv.get("suspended"),
      webhookId: installation?.webhookId,
      policies: this.#policies().filter(([, policy]) => policy.policyId)
        .map(([, policy]) => ({ alertType: policy.alertType, policyId: policy.policyId! })),
      subscribers: this.#hookCount(),
      lastTestAt: this.ctx.storage.kv.get<string>("lastTestAt"),
      lastReceivedAt: this.ctx.storage.kv.get<string>("lastReceivedAt"),
    };
  }

  async receiveWebhook(apiKey: string, contentType: string, body: string): Promise<number> {
    if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") return 415;
    if (new TextEncoder().encode(body).byteLength > MAX_NOTIFICATION_BODY_BYTES) return 413;
    if (this.ctx.storage.kv.get("suspended")) return 410;
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const expectedHash =
      this.ctx.storage.kv.get<string>("pendingAuthHash") ?? installation?.authHash;
    if (!expectedHash || !(await matchesWebhookApiKey(apiKey, expectedHash))) return 401;
    let notification: CloudflareNotification;
    try {
      if (isWebhookTest(JSON.parse(body))) {
        this.ctx.storage.kv.put("lastTestAt", new Date().toISOString());
        return 204;
      }
      if (!installation) return 500;
      notification = await parseNotificationWebhook(body, installation.accountId);
    } catch {
      return 400;
    }
    if (!(await this.#hasCredentials(installation!))) return 500;
    // Recheck after hashing yielded: a concurrent disconnect must win over new delivery.
    if (this.ctx.storage.kv.get("suspended")) return 410;
    this.ctx.storage.sql.exec(
      "DELETE FROM notification_receipts WHERE delivered_at < ?",
      Date.now() - RETENTION_MS,
    );
    const available = this.#hooks();
    if (!notification.alertType && !notification.policyId && available.length) {
      for (const hook of available) disposeHook(hook);
      // The policy cannot be identified, so acknowledging would permanently lose the alert.
      return 500;
    }
    const hooks = available.filter(({ props }) => {
      const policy = this.ctx.storage.kv.get<PolicyIntent>(`policy:${props.alertType}`);
      if (notification.alertType && notification.alertType !== props.alertType) return false;
      if (notification.policyId && policy?.policyId)
        return notification.policyId === policy.policyId;
      return notification.alertType === props.alertType;
    });
    for (const hook of available) if (!hooks.includes(hook)) disposeHook(hook);
    const results = await Promise.all(hooks.map((hook) => this.#handoff(hook, notification)));
    if (results.some((delivered) => !delivered)) return 500;
    if (this.ctx.storage.kv.get("suspended")) return 410;
    this.ctx.storage.kv.put("lastReceivedAt", new Date().toISOString());
    return 204;
  }

  #handoff(stored: StoredHook, notification: CloudflareNotification): Promise<boolean> {
    const key = `${notification.id}:${stored.props.hookId}`;
    const running = this.#inFlight.get(key);
    if (running) {
      disposeHook(stored);
      return running;
    }
    const delivery = this.#deliver(stored, notification).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, delivery);
    return delivery;
  }

  async #deliver(stored: StoredHook, notification: CloudflareNotification): Promise<boolean> {
    const hookId = stored.props.hookId;
    try {
      if (this.ctx.storage.sql.exec(
        "SELECT 1 FROM notification_receipts WHERE notification_id = ? AND hook_id = ?",
        notification.id, hookId,
      ).toArray().length) return true;
      // The persistent initiator checks current workspace authority on every handoff.
      using hook = await stored.initiator.startHook();
      await hook.approvalQueue.authorizeObservation(notificationObservation(notification));
      if (this.ctx.storage.kv.get("suspended") || !this.ctx.storage.kv.get(`hook:${hookId}`))
        return false;
      await hook.callback.onNotification(notification);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO notification_receipts VALUES (?, ?, ?)",
        notification.id,
        hookId,
        Date.now(),
      );
      // Bound deduplication storage without retaining event payloads or pending work.
      this.ctx.storage.sql.exec(
        `DELETE FROM notification_receipts WHERE rowid IN (
        SELECT rowid FROM notification_receipts ORDER BY delivered_at DESC LIMIT -1 OFFSET ?
      )`,
        MAX_RETAINED_DELIVERIES,
      );
      return true;
    } catch {
      logger.warn("notification handoff failed", {
        event: "notification.delivery.failed",
        accountId: stored.props.accountId,
      });
      return false;
    } finally {
      disposeHook(stored);
    }
  }
}
