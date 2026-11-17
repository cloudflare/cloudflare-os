import { notificationPolicyKey, validateNotificationSubscription } from "./notification-policy.js";
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
  getNotificationDestinationUrl,
  updateNotificationDestination,
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
  CloudflareNotificationPolicySettings,
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
const MAX_HOOKS = 1000;
const POLICY_CLEANUP_RETRY_MS = 60_000;
const MAX_POLICY_CLEANUP_RETRY_MS = 60 * 60_000;
const DELIVERY_RETRY_MS = 60_000;
const HANDOFF_TIMEOUT_MS = 10_000;
const MAX_PENDING_DELIVERIES = 1000;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

type NotificationEnv = Cloudflare.Env & {
  BASE_URL?: string;
  NOTIFICATIONS_WEBHOOK_BASE_URL?: string;
};
type HookTarget = RpcTarget & CloudflareNotificationHook;
type NotificationsProps = { userObjectId: string; accountId: string };
type HookProps = NotificationsProps & {
  hookId: string;
  alertType: string;
  createPolicy?: boolean;
  policy?: CloudflareNotificationPolicySettings;
  policyKey?: string;
};
type StoredHook = { props: HookProps; initiator: Fetcher<HookInitiator<HookTarget>> };
type Installation = NotificationInstallation & NotificationsProps & { authHash: string };
type AddressMigration = { apiKey: string; authHash: string; webhookUrl: string };
type PolicyIntent = Partial<NotificationPolicy> & {
  alertType: string;
  policy?: CloudflareNotificationPolicySettings;
  needsReconcile?: boolean;
};

function disposeHook(hook: StoredHook | undefined): void {
  (hook?.initiator as (Fetcher<HookInitiator<HookTarget>> & Partial<Disposable>) | undefined)?.[
    Symbol.dispose
  ]?.();
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
    description:
      `Receive an authenticated Cloudflare notification for account ${notification.accountId}. ` +
      `Alert type: ${alertType}; policy ID: ${auditIdentifier(notification.policyId)}; ` +
      `event state: ${auditIdentifier(notification.event)}. The body includes free-form text and ` +
      "product-specific evidence.",
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
    const policy = validateNotificationSubscription(subscription);
    const props: HookProps = {
      ...this.#ctx.props,
      hookId: crypto.randomUUID(),
      alertType: subscription.alertType,
      createPolicy: subscription.createPolicy ?? true,
      ...(Object.keys(policy).length ? { policy } : {}),
    };
    const controller = this.#ctx.exports.CloudflareNotificationHookController({ props });
    await this.#queue.bindHook(
      // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
      controller,
      callback,
      {
        title: `Cloudflare ${props.alertType} alerts for ${props.accountId}`,
        description:
          `Receive ${props.alertType} alerts in account ${props.accountId}. ` +
          (props.createPolicy
            ? `Create or share an enabled managed policy using this connection's webhook. Receive only that policy's alerts; remove it when its last subscriber is disabled.\n\nExact policy settings (JSON):\n\n${JSON.stringify(
                policy,
                null,
                2,
              )
                .split("\n")
                .map((line) => `    ${line}`)
                .join("\n")}`
            : "Receive every alert of this type from existing policies or Cloudflare Send to destination; do not create a managed policy."),
      },
    );
  }
  async getStatus(): Promise<CloudflareNotificationStatus> {
    await this.#queue.authorizeObservation({
      title: `Cloudflare notification status for ${this.#ctx.props.accountId}`,
      description: `Read destination and managed policy IDs, subscriber count, and recent delivery times for Cloudflare account ${this.#ctx.props.accountId}.`,
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

/** Bounded durable handoffs per subscriber; HTTP acceptance does not wait on workspace callbacks. */
export class CloudflareNotificationReceiver extends DurableObject<NotificationEnv> {
  #mutations = new SerialTaskQueue();
  #alarms = new SerialTaskQueue();
  #provisioning?: Promise<void>;
  #inFlight = new Map<string, Promise<boolean>>();
  #ensureReceipts(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_receipts (
      notification_id TEXT NOT NULL, hook_id TEXT NOT NULL, delivered_at INTEGER NOT NULL,
      PRIMARY KEY(notification_id, hook_id))`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_deliveries (
      notification_id TEXT NOT NULL, hook_id TEXT NOT NULL, notification TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
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
  #hasHook(hookId: string): boolean {
    const hook = this.ctx.storage.kv.get<StoredHook>(`hook:${hookId}`);
    disposeHook(hook);
    return hook !== undefined;
  }
  #policies(): [string, PolicyIntent][] {
    return [...this.ctx.storage.kv.list<PolicyIntent>({ prefix: "policy:" })];
  }
  #unusedPolicies(): [string, PolicyIntent][] {
    const hooks = this.#hooks();
    const used = new Set(
      hooks
        .filter(({ props }) => props.createPolicy !== false)
        .map(({ props }) => props.policyKey ?? `policy:${props.alertType}`),
    );
    for (const hook of hooks) disposeHook(hook);
    return this.#policies().filter(([key]) => !used.has(key));
  }
  async #schedulePolicyCleanup(): Promise<void> {
    const at =
      this.ctx.storage.kv.get<number>("policyCleanupAt") ??
      Date.now() +
        (this.ctx.storage.kv.get<number>("policyCleanupRetryDelay") ?? POLICY_CLEANUP_RETRY_MS);
    this.ctx.storage.kv.put("policyCleanupAt", at);
    await this.#scheduleAlarm(at);
  }
  async #scheduleAlarm(at: number): Promise<void> {
    await this.#alarms.run(() => this.#scheduleAlarmUnlocked(at));
  }
  async #scheduleAlarmUnlocked(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
  async #clearIdleCleanupAlarm(): Promise<void> {
    await this.#alarms.run(async () => {
      const cleanupPending = this.#unusedPolicies().length > 0;
      this.#ensureReceipts();
      const pending = this.ctx.storage.sql
        .exec<{ at: number | null }>("SELECT MIN(next_attempt) AS at FROM notification_deliveries")
        .one().at;
      const cleanupAt = cleanupPending
        ? (this.ctx.storage.kv.get<number>("policyCleanupAt") ?? Date.now())
        : Infinity;
      const at = Math.min(pending ?? Infinity, cleanupAt);
      if (at === Infinity) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
      if (!cleanupPending) {
        this.ctx.storage.kv.delete("policyCleanupRetryDelay");
        this.ctx.storage.kv.delete("policyCleanupAt");
      }
    });
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
    try {
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
    } finally {
      this.ctx.storage.kv.delete("pendingAuthHash");
    }
  }

  /** Move the existing destination in place, retaining its ID and policies across retries. */
  async #reconcileAddress(props: NotificationsProps, installation: Installation): Promise<void> {
    const webhookUrl = `${notificationWebhookBaseUrl(configuredNotificationBaseUrl(this.env))}/webhooks/${props.userObjectId}/${props.accountId}`;
    const providerUrl = await getNotificationDestinationUrl(
      await this.#token(props),
      props.accountId,
      installation.webhookId,
    );
    if (providerUrl === null) {
      // Provider deletion invalidates the persisted setup marker. Reuse provisioning's exact-URL
      // recovery so a lost creation response cannot create duplicate destinations on retry.
      this.ctx.storage.kv.delete("setupComplete");
      this.ctx.storage.kv.delete("addressMigration");
      for (const [key, policy] of this.#policies())
        this.ctx.storage.kv.put<PolicyIntent>(key, { ...policy, needsReconcile: true });
      await this.#provision(props);
      Object.assign(installation, this.ctx.storage.kv.get<Installation>("installation")!);
      return;
    }
    // Older installations may not have recorded their URL. Their known destination ID is authoritative.
    if (
      providerUrl === webhookUrl &&
      this.ctx.storage.kv.get("webhookUrl") === webhookUrl &&
      !this.ctx.storage.kv.get("addressMigration")
    )
      return;
    let migration = this.ctx.storage.kv.get<AddressMigration>("addressMigration");
    if (!migration) {
      const apiKey = generateWebhookApiKey();
      migration = { apiKey, authHash: await hashWebhookApiKey(apiKey), webhookUrl };
      // Retain the pending secret only until success so a lost PUT response can be retried exactly.
      this.ctx.storage.kv.put("addressMigration", migration);
    }
    await updateNotificationDestination(
      await this.#token(props),
      props.accountId,
      installation.webhookId,
      migration.webhookUrl,
      migration.apiKey,
    );
    installation.authHash = migration.authHash;
    this.ctx.storage.kv.put("installation", installation);
    this.ctx.storage.kv.put("webhookUrl", migration.webhookUrl);
    this.ctx.storage.kv.delete("addressMigration");
    if (migration.webhookUrl !== webhookUrl) await this.#reconcileAddress(props, installation);
  }

  async enable(props: HookProps, initiator: Fetcher<HookInitiator<HookTarget>>): Promise<void> {
    await this.#mutations.run(async () => {
      validateNotificationSubscription({
        alertType: props.alertType,
        createPolicy: props.createPolicy,
        policy: props.policy,
      });
      const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
      if (
        owner &&
        (owner.accountId !== props.accountId || owner.userObjectId !== props.userObjectId)
      )
        throw new Error("Notification receiver belongs to another account.");
      if (this.ctx.storage.kv.get("suspended"))
        throw new Error("This notification connection has been disconnected.");
      const key = `hook:${props.hookId}`;
      const existing = this.ctx.storage.kv.get<StoredHook>(key);
      const alreadyEnabled = existing !== undefined;
      disposeHook(existing);
      if (!alreadyEnabled && this.#hookCount() >= MAX_HOOKS)
        throw new Error("This notification connection has reached its subscriber limit.");
      const needsProvisioning = !this.ctx.storage.kv.get("setupComplete");
      if (needsProvisioning) {
        this.#provisioning = this.#provision(props).finally(() => {
          this.#provisioning = undefined;
        });
        await this.#provisioning;
      }
      if (this.ctx.storage.kv.get("suspended"))
        throw new Error("This notification connection has been disconnected.");
      const installation = this.ctx.storage.kv.get<Installation>("installation");
      if (!installation) throw new Error("Notification destination setup is incomplete.");
      if (!needsProvisioning) await this.#reconcileAddress(props, installation);
      this.#ensureReceipts();
      const policyKey = await notificationPolicyKey(props.alertType, props.policy);
      props = { ...props, policyKey };
      const priorPolicy = this.ctx.storage.kv.get<PolicyIntent>(policyKey);
      if (props.createPolicy !== false && !priorPolicy)
        this.ctx.storage.kv.put<PolicyIntent>(policyKey, {
          alertType: props.alertType,
          policy: props.policy,
        });
      if (props.createPolicy !== false && (!priorPolicy?.policyId || priorPolicy.needsReconcile)) {
        // An interrupted POST may have created a policy without installing its hook.
        await this.#schedulePolicyCleanup();
        const policy = await provisionNotificationPolicy(
          await this.#token(props),
          props.accountId,
          installation.webhookId,
          props.alertType,
          props.userObjectId,
          props.policy,
        );
        this.ctx.storage.kv.put<PolicyIntent>(policyKey, {
          alertType: props.alertType,
          policy: props.policy,
          ...policy,
        });
      }
      const replaced = this.ctx.storage.kv.get<StoredHook>(key);
      try {
        this.ctx.storage.kv.put<StoredHook>(key, { props, initiator });
      } finally {
        disposeHook(replaced);
      }
      // A connection-removal disable is best-effort and never retried by the Workshop, and an
      // interrupted enable leaves an intent with no hook; retry either here rather than leak it.
      for (const [policyKey] of this.#policies()) {
        await this.#removeUnusedPolicy(policyKey).catch((error: unknown) =>
          logger.warn("orphaned notification policy cleanup failed", {
            event: "notification.policy.cleanup.failed",
            accountId: props.accountId,
            error,
          }),
        );
      }
      await this.#clearIdleCleanupAlarm();
    });
  }

  async disable(hookId: string, alertType: string): Promise<void> {
    await this.#mutations.run(async () => {
      const key = `hook:${hookId}`;
      const existing = this.ctx.storage.kv.get<StoredHook>(key);
      if (existing && existing.props.alertType !== alertType) {
        disposeHook(existing);
        throw new Error("Notification hook alert type mismatch.");
      }
      // Arm recovery before removing the hook: the Workshop need not call disable again.
      if (this.#policies().length) await this.#schedulePolicyCleanup();
      this.ctx.storage.kv.delete(key);
      disposeHook(existing);
      this.#ensureReceipts();
      this.ctx.storage.sql.exec("DELETE FROM notification_receipts WHERE hook_id = ?", hookId);
      this.ctx.storage.sql.exec("DELETE FROM notification_deliveries WHERE hook_id = ?", hookId);
      for (const [policyKey, policy] of this.#policies()) {
        if (policy.alertType === alertType) await this.#removeUnusedPolicy(policyKey);
      }
      await this.#clearIdleCleanupAlarm();
    });
  }

  /** Delete a managed configuration once no hook uses it. Callers hold #mutations. */
  async #removeUnusedPolicy(policyKey: string): Promise<void> {
    const policy = this.ctx.storage.kv.get<PolicyIntent>(policyKey);
    if (!policy) return;
    if (!this.#unusedPolicies().some(([key]) => key === policyKey)) return;
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    if (!owner) throw new Error("Notification policy owner is missing.");
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    if (!installation) throw new Error("Notification destination is missing.");
    this.ctx.storage.kv.put<PolicyIntent>(policyKey, { ...policy, needsReconcile: true });
    await this.#schedulePolicyCleanup();
    await removeNotificationPolicy(
      await this.#token(owner),
      owner.accountId,
      owner.userObjectId,
      policy.alertType,
      installation.webhookId,
      policy.policyId ? { policyId: policy.policyId } : undefined,
      policy.policy,
    );
    this.ctx.storage.kv.delete(policyKey);
  }

  /** Retry unused managed-policy cleanup independently of subscribers, under the mutation lock. */
  async alarm(): Promise<void> {
    if (this.ctx.storage.kv.get("suspended")) return;
    await this.deliverPending();
    await this.#mutations.run(async () => {
      if (this.ctx.storage.kv.get("suspended")) return;
      if (
        !this.#unusedPolicies().length ||
        (this.ctx.storage.kv.get<number>("policyCleanupAt") ?? 0) > Date.now()
      ) {
        await this.#clearIdleCleanupAlarm();
        return;
      }
      const delay = Math.min(
        (this.ctx.storage.kv.get<number>("policyCleanupRetryDelay") ?? POLICY_CLEANUP_RETRY_MS) * 2,
        MAX_POLICY_CLEANUP_RETRY_MS,
      );
      this.ctx.storage.kv.put("policyCleanupRetryDelay", delay);
      this.ctx.storage.kv.put("policyCleanupAt", Date.now() + delay);
      // Schedule before contacting ANS, so interruption does not exhaust the runtime's retries.
      await this.#scheduleAlarm(Date.now() + delay);
      for (const [key] of this.#unusedPolicies()) {
        await this.#removeUnusedPolicy(key).catch((error: unknown) =>
          logger.warn("notification policy cleanup retry failed", {
            event: "notification.policy.cleanup.failed",
            error,
          }),
        );
      }
      await this.#clearIdleCleanupAlarm();
    });
  }
  async suspend(): Promise<void> {
    this.ctx.storage.kv.put("suspended", true);
    // Fence late callback completions without waiting on an unresponsive subscriber.
    await this.#mutations.run(async () => {
      await this.#provisioning?.catch(() => undefined);
      await this.ctx.storage.deleteAlarm();
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
      const skip = (reason: unknown) =>
        logger.warn("notification provider cleanup skipped", {
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
    }
    // Keep a tombstone so outstanding controller capabilities cannot resurrect this receiver.
    for (const [key, value] of this.ctx.storage.kv.list()) {
      if (key !== "suspended") this.ctx.storage.kv.delete(key);
      if (key.startsWith("hook:")) disposeHook(value as StoredHook);
    }
    this.#ensureReceipts();
    this.ctx.storage.sql.exec("DELETE FROM notification_receipts");
    this.ctx.storage.sql.exec("DELETE FROM notification_deliveries");
  }

  async #removeProviderResources(token: string, owner: NotificationsProps): Promise<void> {
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const webhookUrl = this.ctx.storage.kv.get<string>("webhookUrl");
    for (const [key, policy] of this.#policies()) {
      if (!installation) throw new Error("Notification destination is missing.");
      await removeNotificationPolicy(
        token,
        owner.accountId,
        owner.userObjectId,
        policy.alertType,
        installation.webhookId,
        policy.policyId ? { policyId: policy.policyId } : undefined,
        policy.policy,
      );
      this.ctx.storage.kv.delete(key);
    }
    if (webhookUrl)
      await removeNotificationConnection(token, owner.accountId, webhookUrl, installation);
  }

  async getStatus(): Promise<CloudflareNotificationStatus> {
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    this.#ensureReceipts();
    const pending = this.ctx.storage.sql
      .exec<{ pending: number; retrying: number }>(
        "SELECT COUNT(*) AS pending, COALESCE(SUM(attempts > 0), 0) AS retrying FROM notification_deliveries",
      )
      .one();
    const credentials = installation
      ? await this.#hasCredentials(installation).then(
          (ready) => (ready ? ("ready" as const) : ("reconnect_required" as const)),
          () => "unavailable" as const,
        )
      : ("reconnect_required" as const);
    return {
      installed: !!this.ctx.storage.kv.get("setupComplete"),
      suspended: !!this.ctx.storage.kv.get("suspended"),
      webhookId: installation?.webhookId,
      policies: this.#policies()
        .filter(([, policy]) => policy.policyId)
        .map(([, policy]) => ({
          alertType: policy.alertType,
          policyId: policy.policyId!,
          ...(policy.policy && Object.keys(policy.policy).length ? { policy: policy.policy } : {}),
        })),
      subscribers: this.#hookCount(),
      lastTestAt: this.ctx.storage.kv.get<string>("lastTestAt"),
      lastReceivedAt: this.ctx.storage.kv.get<string>("lastReceivedAt"),
      credentials,
      pendingDeliveries: pending.pending,
      retryingDeliveries: pending.retrying,
      subscriberLimit: MAX_HOOKS,
    };
  }

  /** Authenticate headers and the installed path before the HTTP entrypoint reads a request body. */
  async authenticateWebhook(apiKey: string, requestPath?: string): Promise<number> {
    if (this.ctx.storage.kv.get("suspended")) return 410;
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const migration = this.ctx.storage.kv.get<AddressMigration>("addressMigration");
    const hashes = [
      this.ctx.storage.kv.get<string>("pendingAuthHash"),
      installation?.authHash,
      migration?.authHash,
    ];
    if (
      !(
        await Promise.all(hashes.map((hash) => (hash ? matchesWebhookApiKey(apiKey, hash) : false)))
      ).some(Boolean)
    )
      return 401;
    if (requestPath) {
      const urls = [this.ctx.storage.kv.get<string>("webhookUrl"), migration?.webhookUrl];
      if (!urls.some((url) => url && new URL(url).pathname === requestPath)) return 404;
    }
    return 204;
  }

  async receiveWebhook(
    apiKey: string,
    contentType: string,
    body: string,
    requestPath?: string,
  ): Promise<number> {
    const authenticated = await this.authenticateWebhook(apiKey, requestPath);
    if (authenticated !== 204) return authenticated;
    if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") return 415;
    if (new TextEncoder().encode(body).byteLength > MAX_NOTIFICATION_BODY_BYTES) return 413;
    const installation = this.ctx.storage.kv.get<Installation>("installation");
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
    if (!(await this.#account(installation!.userObjectId).hasNotificationGrant())) return 503;
    // Recheck after hashing yielded: a concurrent disconnect must win over new delivery.
    if (this.ctx.storage.kv.get("suspended")) return 410;
    this.#ensureReceipts();
    this.ctx.storage.sql.exec(
      "DELETE FROM notification_receipts WHERE delivered_at < ?",
      Date.now() - RETENTION_MS,
    );
    const available = this.#hooks();
    const normalizedId = (id: string | undefined) => id?.replaceAll("-", "").toLowerCase();
    // Historical hooks have no settings: resolve their existing alert-type-only policy in place.
    // Never fall back to type routing for a managed hook, even during incomplete provisioning.
    let missingRouting = false;
    const hooks = available.filter(({ props }) => {
      if (notification.alertType !== undefined && notification.alertType !== props.alertType)
        return false;
      if (
        (props.createPolicy === false && !notification.alertType) ||
        (props.createPolicy !== false && !notification.policyId)
      ) {
        missingRouting = true;
        return false;
      }
      if (props.createPolicy === false) return notification.alertType === props.alertType;
      const policy = this.ctx.storage.kv.get<PolicyIntent>(
        props.policyKey ?? `policy:${props.alertType}`,
      );
      return (
        policy?.policyId !== undefined &&
        normalizedId(notification.policyId) === normalizedId(policy.policyId) &&
        (notification.alertType === undefined || notification.alertType === props.alertType)
      );
    });
    for (const hook of available) if (!hooks.includes(hook)) disposeHook(hook);
    if (!hooks.length) {
      logger.info("notification matched no enabled hook", {
        event: "notification.unmatched",
        alertType: auditIdentifier(notification.alertType),
        policyId: auditIdentifier(notification.policyId),
      });
    }
    if (missingRouting)
      logger.warn("notification missing subscriber routing information", {
        event: "notification.routing.incomplete",
      });
    if (missingRouting && !hooks.length) return 500;
    if (this.ctx.storage.kv.get("suspended")) return 410;
    const serialized = JSON.stringify(notification);
    try {
      return await this.#alarms.run(async () => {
        // Serialize scheduling with enqueue/idle cleanup, so a cleared alarm cannot strand an INSERT.
        if (hooks.length) await this.#scheduleAlarmUnlocked(Date.now() + 1000);
        if (this.ctx.storage.kv.get("suspended")) return 410;
        const newHooks = hooks.filter(({ props }) => {
          const current = this.ctx.storage.kv.get<StoredHook>(`hook:${props.hookId}`);
          disposeHook(current);
          return (
            !!current &&
            !this.ctx.storage.sql
              .exec(
                `SELECT 1 FROM notification_receipts WHERE notification_id = ? AND hook_id = ?
       UNION ALL SELECT 1 FROM notification_deliveries WHERE notification_id = ? AND hook_id = ?`,
                notification.id,
                props.hookId,
                notification.id,
                props.hookId,
              )
              .toArray().length
          );
        });
        const queued = this.ctx.storage.sql
          .exec<{ count: number; bytes: number }>(
            "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(notification AS BLOB))), 0) AS bytes FROM notification_deliveries",
          )
          .one();
        if (
          queued.count + newHooks.length > MAX_PENDING_DELIVERIES ||
          queued.bytes + new TextEncoder().encode(serialized).byteLength * newHooks.length >
            MAX_PENDING_BYTES
        )
          return 503;
        for (const { props } of newHooks) {
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO notification_deliveries VALUES (?, ?, ?, 0, ?)",
            notification.id,
            props.hookId,
            serialized,
            Date.now(),
          );
        }
        this.ctx.storage.kv.put("lastReceivedAt", new Date().toISOString());
        return 204;
      });
    } finally {
      for (const hook of hooks) disposeHook(hook);
    }
  }

  /** Attempt each due subscriber independently; failures stay queued across restarts. */
  async deliverPending(): Promise<void> {
    if (this.ctx.storage.kv.get("suspended")) return;
    this.#ensureReceipts();
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    if (owner && !(await this.#account(owner.userObjectId).hasNotificationGrant())) {
      const nextAttempt = Date.now() + DELIVERY_RETRY_MS;
      this.ctx.storage.sql.exec(
        "UPDATE notification_deliveries SET next_attempt = ? WHERE next_attempt < ?",
        nextAttempt,
        nextAttempt,
      );
      await this.#scheduleAlarm(nextAttempt);
      return;
    }
    if (this.ctx.storage.kv.get("suspended")) return;
    const pending = this.ctx.storage.sql
      .exec<{
        notification_id: string;
        hook_id: string;
        notification: string;
        attempts: number;
      }>("SELECT * FROM notification_deliveries WHERE next_attempt <= ? LIMIT 100", Date.now())
      .toArray();
    if (pending.length) await this.#scheduleAlarm(Date.now() + DELIVERY_RETRY_MS);
    await Promise.all(
      pending.map(async (entry) => {
        const hook = this.ctx.storage.kv.get<StoredHook>(`hook:${entry.hook_id}`);
        if (!hook) {
          this.ctx.storage.sql.exec(
            "DELETE FROM notification_deliveries WHERE notification_id = ? AND hook_id = ?",
            entry.notification_id,
            entry.hook_id,
          );
          return;
        }
        this.ctx.storage.sql.exec(
          "UPDATE notification_deliveries SET attempts = attempts + 1, next_attempt = ? WHERE notification_id = ? AND hook_id = ?",
          Date.now() +
            Math.min(
              DELIVERY_RETRY_MS * 2 ** Math.min(entry.attempts, 6),
              MAX_POLICY_CLEANUP_RETRY_MS,
            ),
          entry.notification_id,
          entry.hook_id,
        );
        // Keep the real in-flight promise fenced even after timeout. A hung subscriber must not
        // prevent future alarm batches or policy cleanup from running.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let delivered: boolean;
        try {
          delivered = await Promise.race([
            this.#handoff(hook, JSON.parse(entry.notification)),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), HANDOFF_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        if (delivered) {
          this.ctx.storage.sql.exec(
            "DELETE FROM notification_deliveries WHERE notification_id = ? AND hook_id = ?",
            entry.notification_id,
            entry.hook_id,
          );
        }
      }),
    );
    await this.#clearIdleCleanupAlarm();
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
      if (
        this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM notification_receipts WHERE notification_id = ? AND hook_id = ?",
            notification.id,
            hookId,
          )
          .toArray().length
      )
        return true;
      // The persistent initiator checks current workspace authority on every handoff.
      using hook = await stored.initiator.startHook();
      await hook.approvalQueue.authorizeObservation(notificationObservation(notification));
      if (this.ctx.storage.kv.get("suspended") || !this.#hasHook(hookId)) return false;
      await hook.callback.onNotification(notification);
      if (this.ctx.storage.kv.get("suspended") || !this.#hasHook(hookId)) return true;
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
