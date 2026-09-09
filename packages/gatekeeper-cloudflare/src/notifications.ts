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
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { privateObservers } from "@gadgets/gatekeeper-kit/observers";
import { obsContext } from "./observability.js";
import {
  provisionNotificationInstallation,
  removeNotificationConnection,
  type NotificationInstallation,
} from "./notifications-api.js";
import {
  generateWebhookApiKey,
  hashWebhookApiKey,
  matchesWebhookApiKey,
  MAX_NOTIFICATION_BODY_BYTES,
  notificationReceiverName,
  parseNotificationWebhook,
  isWebhookTest,
} from "./notifications-webhook.js";
import { accountNotificationsUrl, NOTIFICATIONS_SCOPE } from "./resources.js";
import type {
  CloudflareNotification,
  CloudflareNotificationHook,
  CloudflareNotificationsSession,
  CloudflareNotificationFilter,
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
type HookProps = NotificationsProps & { hookId: string; filter: CloudflareNotificationFilter };
type StoredHook = { props: HookProps; initiator: Fetcher<HookInitiator<HookTarget>> };
type Installation = NotificationInstallation & NotificationsProps & { authHash: string };

function receiver(ctx: DurableObjectState<NotificationsProps>, props: NotificationsProps) {
  return ctx.exports.CloudflareNotificationReceiver.getByName(
    notificationReceiverName(props.userObjectId, props.accountId),
  );
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
    filter: CloudflareNotificationFilter = {},
  ): Promise<void> {
    if (
      [filter.alertTypes, filter.policyIds].some(
        (values) =>
          values && (values.length > 100 || values.some((value) => !value || value.length > 200)),
      )
    ) {
      throw new Error("Use at most 100 non-empty values of at most 200 characters per filter.");
    }
    const props: HookProps = { ...this.#ctx.props, hookId: crypto.randomUUID(), filter };
    const controller = this.#ctx.exports.CloudflareNotificationHookController({ props });
    // @ts-expect-error Cap'n Web loses the callback intersection while mapping generic bindHook.
    await this.#queue.bindHook(controller, callback, {
      title: "Subscribe to Cloudflare notifications",
      description:
        "Receive notifications from the selected account" +
        (filter.alertTypes
          ? ` for ${filter.alertTypes.length} selected alert types`
          : " for all alert types") +
        ".",
    });
  }
  async getStatus(): Promise<CloudflareNotificationStatus> {
    const status = await receiver(this.#ctx, this.#ctx.props).getStatus();
    await this.#queue.authorizeObservation({
      title: "Cloudflare notification delivery status",
      description: "Read setup and delivery health for the bound account.",
      prohibitAllSharing: true,
    });
    return status;
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
    await this.#receiver().disable(this.ctx.props.hookId);
  }
}

/** Webhook handoff per connection/account. ANS owns retries; only successful receipts are stored. */
export class CloudflareNotificationReceiver extends DurableObject<NotificationEnv> {
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

  async #provision(props: NotificationsProps): Promise<void> {
    const account = this.#account(props.userObjectId);
    if (!(await account.getGrantedScopes()).includes(NOTIFICATIONS_SCOPE)) {
      throw new Error("Reconnect Cloudflare with Notifications access first.");
    }
    const token = await account.getAccessToken();
    if (!token) throw new Error("Reconnect Cloudflare before enabling notifications.");
    // Record ownership before external side effects, so disconnect can stop even incomplete setup.
    await account.registerNotificationAccount(props.accountId);
    const base = stripTrailingSlashes(
      this.env.NOTIFICATIONS_WEBHOOK_BASE_URL ??
        this.env.BASE_URL ??
        "http://localhost:8787/gatekeeper/cloudflare",
    );
    if (new URL(base).protocol !== "https:") {
      throw new Error(
        "Cloudflare needs a public HTTPS webhook URL. Use a deployed test instance with a public HTTPS webhook address, then enable the connection again.",
      );
    }
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

  async enable(props: HookProps, initiator: Fetcher<HookInitiator<HookTarget>>): Promise<void> {
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    if (
      owner &&
      (owner.accountId !== props.accountId || owner.userObjectId !== props.userObjectId)
    ) {
      throw new Error("Notification receiver belongs to another account.");
    }
    if (this.ctx.storage.kv.get("suspended"))
      throw new Error("This notification connection has been disconnected.");
    if (!this.ctx.storage.kv.get(`hook:${props.hookId}`) && this.#hooks().length >= MAX_HOOKS) {
      throw new Error("This notification connection has reached its subscriber limit.");
    }
    if (!this.ctx.storage.kv.get("setupComplete")) {
      this.#provisioning ??= this.#provision(props).finally(() => {
        this.#provisioning = undefined;
      });
      await this.#provisioning;
    }
    if (this.ctx.storage.kv.get("suspended"))
      throw new Error("This notification connection has been disconnected.");
    if (!this.ctx.storage.kv.get(`hook:${props.hookId}`) && this.#hooks().length >= MAX_HOOKS) {
      throw new Error("This notification connection has reached its subscriber limit.");
    }
    this.ctx.storage.kv.put<StoredHook>(`hook:${props.hookId}`, { props, initiator });
  }

  async disable(hookId: string): Promise<void> {
    this.ctx.storage.kv.delete(`hook:${hookId}`);
    this.ctx.storage.sql.exec("DELETE FROM notification_receipts WHERE hook_id = ?", hookId);
  }
  async suspend(): Promise<void> {
    this.ctx.storage.kv.put("suspended", true);
    // Let an already-started callback finish before returning; no subsequent callback may start.
    await Promise.all(this.#inFlight.values());
    await this.#provisioning?.catch(() => undefined);
  }
  async revokeWithToken(token: string): Promise<void> {
    await this.suspend();
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    const webhookUrl = this.ctx.storage.kv.get<string>("webhookUrl");
    if (owner && webhookUrl)
      await removeNotificationConnection(token, owner.accountId, webhookUrl, installation);
    // Keep a tombstone so outstanding controller capabilities cannot resurrect this receiver.
    for (const [key] of this.ctx.storage.kv.list())
      if (key !== "suspended") this.ctx.storage.kv.delete(key);
    this.ctx.storage.sql.exec("DELETE FROM notification_receipts");
  }

  async getStatus(): Promise<CloudflareNotificationStatus> {
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    return {
      installed: !!this.ctx.storage.kv.get("setupComplete"),
      suspended: !!this.ctx.storage.kv.get("suspended"),
      webhookId: installation?.webhookId,
      subscribers: this.#hooks().length,
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
    const hooks = this.#hooks().filter(
      ({ props: { filter } }) =>
        (!filter.alertTypes || filter.alertTypes.includes(notification.alertType)) &&
        (!filter.policyIds ||
          (notification.policyId !== undefined &&
            filter.policyIds.includes(notification.policyId))),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM notification_receipts WHERE delivered_at < ?",
      Date.now() - RETENTION_MS,
    );
    const results = await Promise.all(hooks.map((hook) => this.#handoff(hook, notification)));
    if (results.some((delivered) => !delivered)) return 500;
    if (this.ctx.storage.kv.get("suspended")) return 410;
    this.ctx.storage.kv.put("lastReceivedAt", new Date().toISOString());
    return 204;
  }

  #handoff(stored: StoredHook, notification: CloudflareNotification): Promise<boolean> {
    const key = `${notification.id}:${stored.props.hookId}`;
    const running = this.#inFlight.get(key);
    if (running) return running;
    const delivery = this.#deliver(stored, notification).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, delivery);
    return delivery;
  }

  async #deliver(stored: StoredHook, notification: CloudflareNotification): Promise<boolean> {
    const hookId = stored.props.hookId;
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
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The persistent initiator checks current workspace authority on every handoff.
      // @ts-expect-error Worker RPC maps the disposable hook result through an RpcPromise.
      using hook = stored.initiator.startHook();
      const delivered = await Promise.race([
        (async () => {
          await hook.approvalQueue.authorizeObservation({
            title: "Cloudflare notification",
            description: "Received an alert from the bound Cloudflare account.",
            prohibitAllSharing: true,
          });
          if (
            !active ||
            this.ctx.storage.kv.get("suspended") ||
            !this.ctx.storage.kv.get(`hook:${hookId}`)
          )
            return false;
          await hook.callback.onNotification(notification);
          return true;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Notification handoff timed out.")), 10_000);
        }),
      ]);
      if (!delivered) return false;
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
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
