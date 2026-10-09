// Google Chat new-message hooks: a Workspace Events subscription per (Google account, space),
// delivered through Pub/Sub push to `POST {BASE_URL}/pubsub`.
//
// `ChatSpace.subscribeNewMessages()` runs in the connection's facet, which mints a persistent stub
// to itself for delivery (an entry's `reply()` queues an action in the facet's storage, so the
// facet must build it) and binds a `ChatHookController` carrying that stub in its props. The
// controller is a loopback entrypoint rather than the facet because removing a connection deletes
// the facet in the same turn as it fires the unawaited `disable()`, which therefore only reaches a
// controller living outside the facet.
//
// One `ChatHookDriver` per space holds its enabled hooks and subscriptions, collapses duplicate
// pushes, and retries failed deliveries from its alarm.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SingleFlight } from "@gadgets/gatekeeper-kit/single-flight";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { fetchWithAuthRetry, type AccessTokenProvider } from "./auth-retry";
import { ChatApiError, chatApiFailure, type ChatMessageRaw } from "./chat-api";
import type { ChatMessageHook } from "./chat-types";
import { HOUR_MS, HookDeliveryQueue, MINUTE_MS, disposeStubs } from "./hook-delivery-queue";
import { obsContext } from "./observability";
import type { PushHooksEnv } from "./pubsub-push";

const logger = obsContext.createLogger({ component: "gatekeeper.google.chat-hooks", vendorId: "google" });

type Env = Cloudflare.Env & PushHooksEnv;

export type ChatMessageHookTarget = RpcTarget & ChatMessageHook;

/** Where a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`. */
export type ChatHookParams = { spaceName: string; threadName?: string };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface ChatHookDelivery extends RpcTarget {
  /** Deliver `message` to one firing of the hook, as `HookInitiator.startHook()` returned it. */
  deliver(callback: RpcStub<ChatMessageHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          message: ChatMessageRaw): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type ChatHookProps = ChatHookParams & {
  key: string;
  /** `users/{id}`: the Google account the facet has pinned. */
  authority: string;
  userObjectId: string;
  delivery: RpcStub<ChatHookDelivery>;
};

@validateRpc()
export class ChatHookController extends WorkerEntrypoint<Env, ChatHookProps>
    implements HookController<ChatMessageHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<ChatMessageHookTarget>>,
               _target: HookTargetMetadata): Promise<void> {
    const { key, delivery, ...registration } = this.ctx.props;
    await this.#driver().register(key, registration, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await this.#driver().unregister(this.ctx.props.key);
  }

  #driver() {
    return this.ctx.exports.ChatHookDriver.getByName(this.ctx.props.spaceName);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** A subscription that includes resource data lives at most 4 hours. */
const RENEW_INTERVAL_MS = 3 * HOUR_MS;
/** Leaves several retries of a failed renewal within the hour before the subscription lapses. */
const RENEW_RETRY_MS = 15 * MINUTE_MS;

type Registration = Omit<ChatHookProps, "key" | "delivery">;
type Capabilities = {
  delivery: RpcStub<ChatHookDelivery>;
  initiator: Fetcher<HookInitiator<ChatMessageHookTarget>>;
};
type Subscription = { name: string; expireTime: number; renewAt: number };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;
const subscriptionKey = (authority: string) => `sub:${authority}`;

export class ChatHookDriver extends DurableObject<Env> {
  /** Subscription creations in flight, by account, which concurrent enables and renewals join. */
  #subscribing = new SingleFlight();
  #queue = new HookDeliveryQueue<ChatMessageRaw>(this.ctx.storage, () => {
    logger.warn("dropped a Chat message after repeated delivery failures", { event: "chat.hooks.delivery.dropped" });
  });

  async register(key: string, registration: Registration, capabilities: Capabilities): Promise<void> {
    const subscription = this.ctx.storage.kv.get<Subscription>(subscriptionKey(registration.authority));
    if (!subscription || subscription.expireTime <= Date.now()) await this.#subscribe(registration);
    const replaced = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(key));
    this.ctx.storage.kv.put(registrationKey(key), registration);
    this.ctx.storage.kv.put(capabilitiesKey(key), capabilities);
    disposeStubs(replaced);
    // A reused subscription's renewal may have come due while no hook used it.
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    disposeStubs(this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(key)));
    this.ctx.storage.kv.delete(registrationKey(key));
    this.ctx.storage.kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
  }

  /** Queue the new messages a subscription reported for each hook of its account they match. */
  async ingest(subscriptionName: string, messages: ChatMessageRaw[]): Promise<void> {
    const authority = [...this.ctx.storage.kv.list<Subscription>({ prefix: "sub:" })]
      .find(([, subscription]) => subscription.name === subscriptionName)?.[0].slice("sub:".length);
    if (authority === undefined) return;
    const now = Date.now();
    for (const [regKey, registration] of this.#registrations()) {
      if (registration.authority !== authority) continue;
      for (const message of messages) {
        // Never echo the account's own posts back to it, and omit app-private messages as every
        // other Chat read does.
        if (!message.name || message.sender?.name === authority || message.privateMessageViewer) continue;
        if (registration.threadName !== undefined && message.thread?.name !== registration.threadName) continue;
        this.#queue.enqueue(regKey.slice("reg:".length), message.name, message, now);
      }
    }
    await this.#wakeBy(now);
  }

  /**
   * The driver's one alarm, which #wakeBy() and #reschedule() set for the earliest time any of
   * these is due:
   * - delivering each queued message whose (re)try time has come, with backoff on failure;
   * - forgetting finished messages once the 24-hour dedupe window has passed;
   * - renewing each subscription some hook still uses, retrying soon if renewal fails;
   * - dropping expired subscriptions no hook uses any more.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    await this.#queue.run(now, (hookKey, message) => this.#deliver(hookKey, message));
    const registrations = [...this.#registrations()].map(([, registration]) => registration);
    // Listed up front: a request handled while a renewal awaits may list too, which would
    // invalidate a live iterator.
    const subscriptions = [...this.ctx.storage.kv.list<Subscription>({ prefix: "sub:" })];
    for (const [key, subscription] of subscriptions) {
      const authority = key.slice("sub:".length);
      const registration = registrations.find(candidate => candidate.authority === authority);
      if (!registration) {
        // Unused subscriptions simply lapse.
        if (subscription.expireTime <= now) this.ctx.storage.kv.delete(key);
      } else if (subscription.renewAt <= now) {
        await this.#renew(registration, subscription).catch(error => {
          logger.warn("failed to renew a Chat subscription", { event: "chat.hooks.renew.failed", error });
          // An enable may have replaced the subscription meanwhile, which this must not overwrite.
          if (this.ctx.storage.kv.get<Subscription>(key)?.name !== subscription.name) return;
          this.ctx.storage.kv.put(key, { ...subscription, renewAt: now + RENEW_RETRY_MS });
        });
      }
    }
    await this.#reschedule();
  }

  async #deliver(hookKey: string, message: ChatMessageRaw): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling or deleting the hook unregisters it, which ends the retries.
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, message);
    } finally {
      disposeStubs(capabilities);
    }
  }

  /**
   * Create the account's subscription to this space, joining any creation already in flight.
   * Refuses, and deletes, a subscription Google attributes to anyone else.
   */
  #subscribe({ spaceName, authority, userObjectId }: Registration): Promise<void> {
    return this.#subscribing.run(authority, async () => {
      const api = new WorkspaceEventsApi(this.#tokens(userObjectId));
      const created = await api.create(spaceName, this.env.PUBSUB_TOPIC!);
      if (created.authority !== authority) {
        await api.delete(created.name);
        throw new Error("This Google Chat connection now belongs to a different Google account. Reconnect the original account.");
      }
      this.#putSubscription(authority, created);
    });
  }

  async #renew(registration: Registration, subscription: Subscription): Promise<void> {
    const api = new WorkspaceEventsApi(this.#tokens(registration.userObjectId));
    const current = await api.get(subscription.name);
    if (!current || current.state === "DELETED" || Date.parse(current.expireTime) <= Date.now()) {
      return this.#subscribe(registration);
    }
    this.#putSubscription(registration.authority, await api.renew(current));
  }

  #putSubscription(authority: string, subscription: SubscriptionRaw): void {
    this.ctx.storage.kv.put<Subscription>(subscriptionKey(authority), {
      name: subscription.name,
      expireTime: Date.parse(subscription.expireTime),
      renewAt: Date.now() + RENEW_INTERVAL_MS,
    });
  }

  #registrations() {
    return this.ctx.storage.kv.list<Registration>({ prefix: "reg:" });
  }

  #tokens(userObjectId: string): AccessTokenProvider {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return async opts => (await account.getAccessToken(opts)).token;
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }

  async #reschedule(): Promise<void> {
    const times: number[] = [];
    const queueDue = this.#queue.nextDue();
    if (queueDue !== undefined) times.push(queueDue);
    const authorities = new Set([...this.#registrations()].map(([, registration]) => registration.authority));
    for (const [key, subscription] of this.ctx.storage.kv.list<Subscription>({ prefix: "sub:" })) {
      times.push(authorities.has(key.slice("sub:".length)) ? subscription.renewAt : subscription.expireTime);
    }
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
  }
}

// ── Workspace Events API ────────────────────────────────────────────

const EVENTS_API_BASE = "https://workspaceevents.googleapis.com/v1";
const MESSAGE_CREATED = "google.workspace.chat.message.v1.created";
const MESSAGES_CREATED = "google.workspace.chat.message.v1.batchCreated";

type SubscriptionRaw = {
  name: string; authority: string; state: string; expireTime: string;
  notificationEndpoint?: { pubsubTopic?: string };
};
type OperationRaw = { name: string; done?: boolean; response?: SubscriptionRaw; error?: { code?: number } };

class WorkspaceEventsApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  /** Create the account's subscription, or adopt the one an unanswered earlier create left. */
  async create(spaceName: string, topic: string): Promise<SubscriptionRaw> {
    const targetResource = `//chat.googleapis.com/${spaceName}`;
    try {
      return await this.#operation("subscriptions.create", "/subscriptions", "POST", {
        targetResource,
        eventTypes: [MESSAGE_CREATED],
        notificationEndpoint: { pubsubTopic: topic },
        payloadOptions: { includeResource: true },
      });
    } catch (error) {
      // Google holds one subscription per app, account and space, so a create that outlived our
      // wait, or whose response was lost, refuses the next. It is ours if it publishes to our
      // topic, and is renewed, since it may be in its last minutes.
      if (!(error instanceof ChatApiError && error.rpcCode === "ALREADY_EXISTS")) throw error;
      const filter = `event_types:"${MESSAGE_CREATED}" AND target_resource="${targetResource}"`;
      const { subscriptions = [] } = await this.#request<{ subscriptions?: SubscriptionRaw[] }>(
        "subscriptions.list", `/subscriptions?filter=${encodeURIComponent(filter)}`);
      const existing = subscriptions.find(candidate => candidate.notificationEndpoint?.pubsubTopic === topic);
      if (!existing) throw error;
      return this.renew(existing);
    }
  }

  /** The subscription, or null once Google no longer has it. */
  async get(name: string): Promise<SubscriptionRaw | null> {
    try {
      return await this.#request<SubscriptionRaw>("subscriptions.get", `/${name}`);
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Extend the subscription to its maximum lifetime, reactivating it first if Google suspended it. */
  async renew({ name, state }: SubscriptionRaw): Promise<SubscriptionRaw> {
    if (state === "SUSPENDED") await this.#operation("subscriptions.reactivate", `/${name}:reactivate`, "POST", {});
    return this.#operation("subscriptions.patch", `/${name}?updateMask=ttl`, "PATCH", { ttl: "0s" });
  }

  /** Delete the subscription; Google finishes the operation without us. */
  async delete(name: string): Promise<void> {
    await this.#request("subscriptions.delete", `/${name}`, { method: "DELETE" });
  }

  /** Subscription writes are long-running operations; wait briefly for one to finish. */
  async #operation(operation: string, path: string, method: string, body: object): Promise<SubscriptionRaw> {
    let result = await this.#request<OperationRaw>(operation, path, { method, body: JSON.stringify(body) });
    for (let attempt = 0; !result.done; attempt++) {
      if (attempt === 5) throw new Error(`Google Workspace Events ${operation} did not finish in time.`);
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      result = await this.#request<OperationRaw>(operation, `/${result.name}`);
    }
    if (!result.response) {
      throw new Error(`Google Workspace Events ${operation} failed [code=${result.error?.code ?? "unknown"}]`);
    }
    return result.response;
  }

  async #request<T>(operation: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithAuthRetry(`${EVENTS_API_BASE}${path}`, {
      ...init, headers: { "Content-Type": "application/json" },
    }, this.getAccessToken);
    if (!response.ok) await chatApiFailure(operation, response);
    return response.json<T>();
  }
}

// ── Push ingest ─────────────────────────────────────────────────────

/** Queue the new messages one Workspace Events push reports with their space's driver; ignore anything else. */
export async function ingestChatPush(attributes: Record<string, string>, data: string,
                                     exports: Cloudflare.Exports): Promise<void> {
  const type = attributes["ce-type"];
  const spaceName = attributes["ce-subject"]?.match(/^\/\/chat\.googleapis\.com\/(spaces\/[^/]+)$/)?.[1];
  const subscription = attributes["ce-source"]?.match(/^\/\/workspaceevents\.googleapis\.com\/(subscriptions\/[^/]+)$/)?.[1];
  if ((type !== MESSAGE_CREATED && type !== MESSAGES_CREATED) || !spaceName || !subscription) return;
  const event = JSON.parse(data) as {
    message?: ChatMessageRaw;
    messages?: { message?: ChatMessageRaw }[];
  };
  const messages = type === MESSAGE_CREATED ? [event.message] : (event.messages ?? []).map(entry => entry.message);
  await exports.ChatHookDriver.getByName(spaceName)
    .ingest(subscription, messages.filter(message => message !== undefined));
}
