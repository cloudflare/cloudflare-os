// Push notifications: hooks that hear of posts as X publishes them, through the X Activity API.
//
// X delivers every event for this deployment to one webhook, `{WEBHOOK_ORIGIN}{BASE_URL's
// path}/webhook`, which `XWebhookRegistry` keeps registered with the app-only bearer token X's
// webhook endpoints take. Events are subscribed to per X user and event type -- the connected
// account's mentions and replies with its own token, since those are private, and a watched user's
// posts with the app token -- never with a `post_id` qualifier: X refuses a qualified subscription
// overlapping an unqualified one, and the self-serve tier's 1,500 subscriptions must cover the whole
// deployment, so filtering to one post happens here. `XActivityRouter`, one per X user, holds those
// subscriptions and which accounts watch each.
//
// The rest is the GitHub gatekeeper's design. `subscribe*()` runs in the connection's facet, which
// mints a persistent stub to itself for delivery and binds an `XHookController` carrying it; the
// controller is a loopback entrypoint, since removing a connection deletes the facet in the same
// turn as it fires the unawaited `disable()`. One `XHookDriver` per connected account holds its
// enabled hooks, queues each event once for every hook that watches for it, and retries failed
// deliveries from its alarm. The facet re-checks each event against the binding before delivering.
// Disconnecting the account cancels its hooks, and the subscriptions nothing else watches.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  DELIVERED_RETENTION_MS, HookDeliveryQueue, disposeStubs,
} from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { obsContext } from "./observability";
import type { XPostHook } from "./types";
import { XApi, XApiError, requireData } from "./x-api";
import { accountSource } from "./x-credentials";
import { SIGNATURE_HEADER, VENDOR_ID, webhookUrl, type Env } from "./x-env";

const logger = obsContext.createLogger({ component: "gatekeeper.x.hooks", vendorId: VENDOR_ID });

export const HOOKS_NOT_CONFIGURED = "Push notifications aren't set up on this deployment.";

const DISCONNECTED = "This X account has been disconnected.";

export type XPostHookTarget = RpcTarget & XPostHook;

/**
 * What a hook watches for, sealed into its delivery stub by the facet's `ctx.restore()`: posts
 * mentioning the connected account; replies to its posts, or to one of them; or one user's posts.
 */
export type XHookParams =
  | { kind: "mention" }
  /** With `postId`, replies to that one post, which belongs to `conversationId`. */
  | { kind: "reply"; postId?: string; conversationId?: string }
  | { kind: "post"; userId: string };

export type XHookKind = XHookParams["kind"];

/** The X Activity API event each kind of hook is delivered from. */
export const EVENT_TYPES: Record<XHookKind, string> = {
  mention: "post.mention.create",
  reply: "post.reply.create",
  post: "post.create",
};

/** The event types only the filtered user's own token may subscribe to. */
const PRIVATE_EVENT_TYPES: ReadonlySet<string> = new Set([EVENT_TYPES.mention, EVENT_TYPES.reply]);

/**
 * X's JSON for a delivered object, authenticated by the delivery's signature. It crosses RPC
 * unvalidated, and the facet reads it as the REST type it matches, as it reads REST responses.
 */
export type ActivityJson = Record<string, unknown>;

/** One post X delivered, as a driver queues it for each hook and the facet delivers it. */
export type XActivityEvent = {
  /** X's `event_uuid`, the same for every delivery of one event. */
  id: string;
  kind: XHookKind;
  /** The user the subscription filters on: the one mentioned, replied to, or posting. */
  userId: string;
  /** The post. */
  post: ActivityJson;
  /** Objects X expanded alongside it, such as its author. */
  includes?: ActivityJson;
};

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface XHookDelivery extends RpcTarget {
  /**
   * Deliver `event` to one firing of the hook, as `HookInitiator.startHook()` returned it, if the
   * binding admits it; otherwise return without calling it.
   */
  deliver(callback: RpcStub<XPostHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          event: XActivityEvent): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type XHookProps = XHookParams & {
  key: string;
  userObjectId: string;
  /** The connected X user: their own posts are never handed back to them. */
  viewerId: string;
  delivery: RpcStub<XHookDelivery>;
};

@validateRpc()
export class XHookController extends WorkerEntrypoint<Env, XHookProps>
    implements HookController<XPostHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<XPostHookTarget>>, _target: HookTargetMetadata): Promise<void> {
    const { key, userObjectId, delivery, ...registration } = this.ctx.props;
    await this.#driver().register(key, userObjectId, registration, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await this.#driver().unregister(this.ctx.props.key);
  }

  #driver() {
    return this.ctx.exports.XHookDriver.getByName(this.ctx.props.userObjectId);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** What a driver keeps of an enabled hook to decide which events it watches for. */
type Registration = XHookParams & { viewerId: string };
type Capabilities = {
  delivery: RpcStub<XHookDelivery>;
  initiator: Fetcher<HookInitiator<XPostHookTarget>>;
};

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;

/** The X user whose events a registration needs. */
function subjectOf(registration: Registration): string {
  return registration.kind === "post" ? registration.userId : registration.viewerId;
}

/** The post a delivered post replies to, if it is a reply. */
export function repliedTo(post: ActivityJson): string | undefined {
  if (typeof post.in_reply_to_tweet_id === "string") return post.in_reply_to_tweet_id;
  const references = (post.referenced_tweets ?? post.referenced_posts) as { type?: string; id?: string }[] | undefined;
  return Array.isArray(references) ? references.find(ref => ref?.type === "replied_to")?.id : undefined;
}

/**
 * Whether a hook watches for `event`. Only spares firings: the facet re-checks the binding's scope
 * at delivery.
 */
export function watches(registration: Registration, event: XActivityEvent): boolean {
  if (registration.kind !== event.kind || event.userId !== subjectOf(registration)) return false;
  const author = event.post.author_id;
  switch (registration.kind) {
    case "mention":
    case "reply":
      // Never hand the account's own posts back to it, or a hook could answer itself.
      if (author === registration.viewerId) return false;
      return registration.kind === "mention" || registration.postId === undefined
        || repliedTo(event.post) === registration.postId;
    case "post":
      return author === registration.userId;
  }
}

/**
 * One per connected account, named by its `UserAccount` id. Storage: `account` (that id),
 * `reg:`/`caps:` per hook, the delivery queue's `msg:` rows, and `revoked` once the account is
 * disconnected, which refuses everything for good.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class XHookDriver extends DurableObject<Env> {
  /** Registrations and removals, one at a time, so a removal never undoes a later registration. */
  #changes = new SerialTaskQueue();
  #queue = new HookDeliveryQueue<XActivityEvent>(this.ctx.storage.kv, () => {
    logger.warn("dropped an X event after repeated delivery failures", { event: "hooks.delivery.dropped" });
  });

  async register(key: string, userObjectId: string, registration: Registration,
                 capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
    kv.put("account", userObjectId);
    await this.#changes.run(async () => {
      // Disconnected while an earlier change ran.
      if (kv.get("revoked")) throw new Error(DISCONNECTED);
      // Subscribed first: a hook recorded before X delivers its events would never fire.
      await this.#router(subjectOf(registration)).watch(subjectOf(registration),
        EVENT_TYPES[registration.kind], userObjectId);
      if (kv.get("revoked")) throw new Error(DISCONNECTED);
      const replaced = kv.get<Capabilities>(capabilitiesKey(key));
      kv.put(registrationKey(key), registration);
      kv.put(capabilitiesKey(key), capabilities);
      disposeStubs(replaced);
    });
  }

  async unregister(key: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const registration = kv.get<Registration>(registrationKey(key));
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
    await this.#reschedule();
    if (!registration) return;
    await this.#changes.run(async () => {
      // Another of this account's hooks still needs the subscription.
      if (this.#registrations().some(other => subjectOf(other) === subjectOf(registration)
          && other.kind === registration.kind)) return;
      // Best effort, since disabling must not fail: until X stops delivering, nothing here queues
      // what no hook watches for.
      await this.#router(subjectOf(registration))
        .unwatch(subjectOf(registration), EVENT_TYPES[registration.kind], kv.get<string>("account")!)
        .catch((error: unknown) => {
          logger.warn("failed to unsubscribe from X events", { event: "hooks.subscription.unwatch.failed", error });
        });
    });
  }

  /**
   * The account is being disconnected: stop delivering for good, and give up the subscriptions
   * nothing else watches, which X would otherwise keep delivering and billing.
   */
  async revoke(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const account = kv.get<string>("account");
    // Never used: a hook enabled from now on fails for want of the account.
    if (account === undefined) return;
    const watched = new Map<string, Registration>();
    for (const [key, value] of Array.from(kv.list())) {
      if (key.startsWith("reg:")) {
        const registration = value as Registration;
        watched.set(`${subjectOf(registration)} ${registration.kind}`, registration);
      }
      if (key.startsWith("caps:")) disposeStubs(value as Capabilities);
      kv.delete(key);
    }
    kv.put("revoked", true);
    await this.ctx.storage.deleteAlarm();
    await this.#changes.run(() => Promise.all([...watched.values()].map(registration =>
      this.#router(subjectOf(registration)).unwatch(subjectOf(registration), EVENT_TYPES[registration.kind], account)
        .catch((error: unknown) => {
          logger.warn("failed to unsubscribe from X events", { event: "hooks.subscription.unwatch.failed", error });
        }))));
  }

  /** Queue an event X delivered for each of this account's hooks that watches for it. */
  async ingest(event: XActivityEvent): Promise<void> {
    if (this.ctx.storage.kv.get("revoked")) return;
    const now = Date.now();
    let queued = false;
    for (const [regKey, registration] of this.ctx.storage.kv.list<Registration>({ prefix: "reg:" })) {
      if (!watches(registration, event)) continue;
      this.#queue.enqueue(regKey.slice("reg:".length), event.id, event, now);
      queued = true;
    }
    if (queued) await this.#wakeBy(now);
  }

  /** Delivers each queued event whose (re)try time has come, and forgets finished ones. */
  async alarm(): Promise<void> {
    await this.#queue.run(Date.now(), (hookKey, event) => this.#deliver(hookKey, event));
    await this.#reschedule();
  }

  async #deliver(hookKey: string, event: XActivityEvent): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one; disabling the hook ends the retries.
      // Awaited, not pipelined: workerd can't pass a property of a pending result into another call.
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, event);
    } finally {
      disposeStubs(capabilities);
    }
  }

  #registrations(): Registration[] {
    return [...this.ctx.storage.kv.list<Registration>({ prefix: "reg:" })].map(([, registration]) => registration);
  }

  #router(userId: string) {
    return this.ctx.exports.XActivityRouter.getByName(userId);
  }

  /** Moves the alarm earlier, never later. */
  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > time) await this.ctx.storage.setAlarm(time);
  }

  async #reschedule(): Promise<void> {
    const next = this.#queue.nextDue();
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}

// ── Router ──────────────────────────────────────────────────────────

/** A subscription this deployment holds at X; `deleting` once X failed to confirm deleting it. */
type Subscription = { id: string; deleting?: true };

const subscriptionKey = (eventType: string) => `sub:${eventType}`;
const watcherPrefix = (eventType: string) => `watch:${eventType}:`;

/** How long until a subscription X failed to delete is deleted again. */
const DELETE_RETRY_MS = 15 * 60 * 1000;

/**
 * One per X user, named by their ID: X's subscriptions to that user's events, one per event type
 * however many hooks need it, and which accounts' drivers watch each. Storage: `sub:<event type>`
 * and `watch:<event type>:<account id>`. A subscription nothing watches is kept until X confirms
 * deleting it, retried from the alarm, since X would otherwise go on delivering and billing it.
 */
export class XActivityRouter extends DurableObject<Env> {
  /** Subscription changes, one at a time, so two first watchers don't both subscribe. */
  #changes = new SerialTaskQueue();

  /** Has X deliver `eventType` for `userId`, and the driver of `account` hear of it. */
  async watch(userId: string, eventType: string, account: string): Promise<void> {
    await this.#changes.run(async () => {
      const kv = this.ctx.storage.kv;
      const stored = kv.get<Subscription>(subscriptionKey(eventType));
      // X may have deleted it and lost only the answer, so it is deleted for certain and made again.
      if (stored?.deleting) await this.#delete(eventType, stored);
      if (kv.get<Subscription>(subscriptionKey(eventType)) === undefined) {
        kv.put(subscriptionKey(eventType), await this.#subscribe(userId, eventType, account));
      }
      kv.put(`${watcherPrefix(eventType)}${account}`, true);
    });
  }

  /** The driver of `account` no longer watches `eventType`; the last to go ends the subscription. */
  async unwatch(_userId: string, eventType: string, account: string): Promise<void> {
    await this.#changes.run(async () => {
      this.ctx.storage.kv.delete(`${watcherPrefix(eventType)}${account}`);
      if (this.#watchers(eventType).length === 0) await this.#retire(eventType);
    });
  }

  /** Deletes again each subscription nothing watches that X failed to delete. */
  async alarm(): Promise<void> {
    await this.#changes.run(async () => {
      // Listed up front: retiring one changes storage, and awaits X.
      const eventTypes = Array.from(this.ctx.storage.kv.list({ prefix: "sub:" }), ([key]) => key.slice("sub:".length));
      for (const eventType of eventTypes) {
        if (this.#watchers(eventType).length === 0) await this.#retire(eventType);
      }
    });
  }

  /** Hands an event X delivered to every driver watching for it. */
  async ingest(eventType: string, event: XActivityEvent): Promise<void> {
    await Promise.all(this.#watchers(eventType).map(account =>
      this.ctx.exports.XHookDriver.getByName(account).ingest(event)));
  }

  /**
   * The user revoked this app: X deleted the subscriptions their token made, so the next watch of
   * a private event subscribes afresh.
   */
  async revoked(): Promise<void> {
    for (const eventType of PRIVATE_EVENT_TYPES) this.ctx.storage.kv.delete(subscriptionKey(eventType));
  }

  #watchers(eventType: string): string[] {
    const prefix = watcherPrefix(eventType);
    return [...this.ctx.storage.kv.list({ prefix })].map(([key]) => key.slice(prefix.length));
  }

  /**
   * Subscribes to `eventType` for `userId`: a private event with the token of `account`, which is
   * connected as that user, and a public one with the app's token. One X already has is adopted.
   */
  async #subscribe(userId: string, eventType: string, account: string): Promise<Subscription> {
    const webhookId = await this.ctx.exports.XWebhookRegistry.getByName(REGISTRY).webhookId();
    const body = { event_type: eventType, filter: { user_id: userId }, webhook_id: webhookId, tag: TAG };
    try {
      const created = PRIVATE_EVENT_TYPES.has(eventType)
        ? await accountSource(this.ctx.exports, account).run(creds =>
          new XApi(creds.accessToken).post<SubscriptionResponse>("/2/activity/subscriptions", body))
        : await appApi(this.env).post<SubscriptionResponse>("/2/activity/subscriptions", body);
      return { id: subscriptionIdOf(requireData(created, "subscription")) };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const existing = await findSubscription(this.env, eventType, userId);
      if (!existing) throw error;
      return { id: existing };
    }
  }

  /** Ends the subscription to `eventType`, nothing watching it; one X fails to delete is retried. */
  async #retire(eventType: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const subscription = kv.get<Subscription>(subscriptionKey(eventType));
    if (subscription === undefined) return;
    try {
      await this.#delete(eventType, subscription);
    } catch (error) {
      logger.warn("failed to delete an X subscription; retrying later", { event: "hooks.subscription.delete.failed", error });
      kv.put(subscriptionKey(eventType), { id: subscription.id, deleting: true });
      const retryAt = Date.now() + DELETE_RETRY_MS;
      const scheduled = await this.ctx.storage.getAlarm();
      if (scheduled === null || scheduled > retryAt) await this.ctx.storage.setAlarm(retryAt);
    }
  }

  /** Deletes a subscription at X, then forgets it; one X no longer has counts as deleted. */
  async #delete(eventType: string, subscription: Subscription): Promise<void> {
    try {
      await appApi(this.env).delete(`/2/activity/subscriptions/${subscription.id}`);
    } catch (error) {
      if (!(error instanceof XApiError && error.status === 404)) throw error;
    }
    this.ctx.storage.kv.delete(subscriptionKey(eventType));
  }
}

/** The tag on every subscription this gatekeeper makes, to tell them apart in X's console. */
const TAG = "gadgets";

/**
 * Whether X refused a subscription as one it already has. X documents the refusal only as
 * "DuplicateSubscription", not its status or shape, so any of them counts.
 */
export function isDuplicate(error: unknown): boolean {
  return error instanceof XApiError && (error.status === 409
    || /duplicate/i.test(`${error.problemType ?? ""} ${error.problemTitle ?? ""} ${error.message}`));
}

type SubscriptionResponse = { subscription?: { subscription_id?: string } };

function subscriptionIdOf(data: SubscriptionResponse): string {
  const id = data.subscription?.subscription_id;
  if (!id) throw new XApiError(502, "X created the subscription without returning its ID.");
  return id;
}

/** The ID of this app's subscription to `eventType` for `userId`, if X has one. */
async function findSubscription(env: Env, eventType: string, userId: string): Promise<string | undefined> {
  const listed = await appApi(env).get<{ subscription_id?: string; event_type?: string; filter?: { user_id?: string } }[]>(
    "/2/activity/subscriptions");
  return (listed.data ?? []).find(subscription =>
    subscription.event_type === eventType && subscription.filter?.user_id === userId)?.subscription_id;
}

/** A client for X's app-level endpoints, as the app rather than any user. */
function appApi(env: Env): XApi {
  if (!env.X_APP_BEARER_TOKEN) throw new Error(HOOKS_NOT_CONFIGURED);
  return new XApi(env.X_APP_BEARER_TOKEN);
}

// ── Webhook registry ────────────────────────────────────────────────

/** The registry's name: there is one per deployment. */
const REGISTRY = "deployment";
/** How often the registry checks the webhook at X. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

type Webhook = { id: string; url: string; valid?: boolean };

/**
 * One per deployment: the webhook X delivers every event to. It registers the webhook when the
 * first hook is enabled, and hourly confirms X still has it and considers it valid, revalidating
 * or registering it again as needed, since X stops delivering to a webhook that failed its checks
 * for a day. Storage: `webhook` (`{ id, url }`) and `revokeSubscribed` (the app-wide `oauth.revoke`
 * subscription's ID).
 */
export class XWebhookRegistry extends DurableObject<Env> {
  #changes = new SerialTaskQueue();

  /** The webhook's ID, registering it first if this deployment has none at its current URL. */
  async webhookId(): Promise<string> {
    return await this.#changes.run(async () => {
      const url = webhookUrl(this.env);
      if (url === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
      const kv = this.ctx.storage.kv;
      const stored = kv.get<Webhook>("webhook");
      if (stored?.url === url) return stored.id;
      const webhook = await this.#register(url);
      kv.put("webhook", { id: webhook.id, url });
      kv.delete("revokeSubscribed");
      await this.#subscribeToRevocations(webhook.id);
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
      return webhook.id;
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + CHECK_INTERVAL_MS);
    await this.#changes.run(async () => {
      const url = webhookUrl(this.env);
      const stored = this.ctx.storage.kv.get<Webhook>("webhook");
      if (url === undefined || stored === undefined) return;
      try {
        const webhook = await this.#register(url);
        if (webhook.id !== stored.id) {
          logger.warn("registered the X webhook again", { event: "hooks.webhook.reregistered" });
          this.ctx.storage.kv.put("webhook", { id: webhook.id, url });
          this.ctx.storage.kv.delete("revokeSubscribed");
        }
        await this.#subscribeToRevocations(webhook.id);
      } catch (error) {
        logger.warn("failed to check the X webhook", { event: "hooks.webhook.check.failed", error });
      }
    });
  }

  /** The webhook X has at `url`, revalidated if X marked it invalid, or one registered there now. */
  async #register(url: string): Promise<Webhook> {
    const api = appApi(this.env);
    const listed = await api.get<Webhook[]>("/2/webhooks");
    const existing = (listed.data ?? []).find(webhook => webhook.url === url);
    if (existing) {
      // Revalidating has X run its challenge again, which re-enables a webhook it gave up on.
      if (existing.valid === false) await api.put(`/2/webhooks/${existing.id}`, {});
      return existing;
    }
    return requireData(await api.post<Webhook>("/2/webhooks", { url }), "webhook");
  }

  /** The app-wide `oauth.revoke` subscription, which tells a user's router their token is gone. */
  async #subscribeToRevocations(webhookId: string): Promise<void> {
    if (this.ctx.storage.kv.get("revokeSubscribed")) return;
    try {
      await appApi(this.env).post("/2/activity/subscriptions", {
        event_type: "oauth.revoke", filter: {}, webhook_id: webhookId, tag: TAG,
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
    this.ctx.storage.kv.put("revokeSubscribed", true);
  }
}

// ── Webhook deliveries ──────────────────────────────────────────────

/**
 * Far above any delivery of one post with its expansions, and refused rather than held in memory:
 * anyone who can see the webhook's URL can send a body this large.
 */
const MAX_DELIVERY_BYTES = 5 * 1024 * 1024;

/**
 * Handles a request to `{BASE_URL}/webhook`: X's challenge (`GET`), proving this deployment holds
 * the app's client secret, or a signed delivery of events (`POST`), routed to the routers of the
 * users they concern. Inert, answering 404, unless push notifications are configured.
 */
export async function handleWebhookRequest(request: Request, env: Env, exports: Cloudflare.Exports): Promise<Response> {
  let configured: boolean;
  try {
    configured = webhookUrl(env) !== undefined && Boolean(env.CLIENT_SECRET);
  } catch {
    configured = false;
  }
  if (!configured) return new Response("Not Found", { status: 404 });
  const secret = env.CLIENT_SECRET!;

  if (request.method === "GET") {
    const challenge = new URL(request.url).searchParams.get("crc_token");
    if (!challenge) return new Response("Bad Request", { status: 400 });
    return Response.json({ response_token: `sha256=${await sign(secret, new TextEncoder().encode(challenge))}` });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature || !request.body) return new Response("Bad Request", { status: 400 });
  if (Number(request.headers.get("Content-Length")) > MAX_DELIVERY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  let body: Uint8Array;
  try {
    body = await readBytesCapped(new Response(request.body), MAX_DELIVERY_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return new Response("Payload Too Large", { status: 413 });
    throw error;
  }
  if (!await verifySignature(secret, signature, body)) return new Response("Unauthorized", { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const now = Date.now();
  const data = (parsed as { data?: unknown } | null)?.data;
  for (const item of Array.isArray(data) ? data : [data]) {
    const delivered = parseDelivery(item);
    if (delivered === undefined) continue;
    if (delivered.type === "revoke") {
      await exports.XActivityRouter.getByName(delivered.userId).revoked();
      continue;
    }
    // Older than the delivery queue remembers: nothing would stop its replay.
    if (!(delivered.at >= now - DELIVERED_RETENTION_MS)) continue;
    await exports.XActivityRouter.getByName(delivered.event.userId).ingest(delivered.eventType, delivered.event);
  }
  return new Response(null, { status: 200 });
}

/** One event of a delivery, as routing needs it. */
type Delivery =
  | { type: "post"; eventType: string; event: XActivityEvent; at: number }
  | { type: "revoke"; userId: string };

const KINDS_BY_EVENT_TYPE = new Map(Object.entries(EVENT_TYPES).map(([kind, type]) => [type, kind as XHookKind]));

/** Reads one event of X's envelope, or undefined for one this gatekeeper doesn't handle. */
export function parseDelivery(item: unknown): Delivery | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { event_uuid: id, event_type: eventType, filter, payload, includes, created_at: createdAt } =
    item as Record<string, unknown>;
  if (typeof eventType !== "string" || typeof payload !== "object" || payload === null) return undefined;
  if (eventType === "oauth.revoke") {
    const userId = (payload as ActivityJson).user_id;
    return typeof userId === "string" ? { type: "revoke", userId } : undefined;
  }
  const kind = KINDS_BY_EVENT_TYPE.get(eventType);
  const userId = (filter as ActivityJson | undefined)?.user_id;
  if (kind === undefined || typeof id !== "string" || typeof userId !== "string"
      || typeof (payload as ActivityJson).id !== "string") return undefined;
  return {
    type: "post",
    eventType,
    event: {
      id, kind, userId, post: payload as ActivityJson,
      ...(typeof includes === "object" && includes !== null ? { includes: includes as ActivityJson } : {}),
    },
    at: typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN,
  };
}

/** `base64(HMAC-SHA256(secret, data))`: X's challenge answer and delivery signature. */
export async function sign(secret: string, data: Uint8Array): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return btoa(String.fromCharCode(...mac));
}

/** Whether `header` is X's signature of `body`, compared in constant time. */
export async function verifySignature(secret: string, header: string, body: Uint8Array): Promise<boolean> {
  const encoded = /^sha256=([A-Za-z0-9+/]{43}=)$/.exec(header.trim())?.[1];
  if (!encoded) return false;
  const signature = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  return await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, body);
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
