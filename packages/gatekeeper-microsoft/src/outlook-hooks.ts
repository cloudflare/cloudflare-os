// Outlook new-message hooks. One `OutlookHookDriver` per connection and mailbox watches each folder
// its hooks deliver from (Inbox, or a binding's own folder), with one Graph change-notification
// subscription per folder. It reads what arrived since its cursor whenever a notification comes and
// on a timer, since notifications can be late, dropped, or impossible (a deployment Graph can't
// reach). A notification carries no content and only prompts a read with the driver's own
// credentials, so a forged one can at most cause a read; it must also carry the driver's
// `clientState` secret, so forged ones are usually dropped before that.
//
// The driver delivers each new message to every hook watching its folder through the binding's
// delivery stub (`[restore]` in outlook-gatekeeper.ts), which re-reads the message and decides with
// the binding's own guard whether it is covered.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { HookDeliveryQueue, disposeStubs } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { escapeObservationValue } from "@gadgets/gatekeeper-kit/observers";
import { ResponseTooLargeError, readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { ApprovalQueue, HookController, HookInitiator, HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import { GraphApi, GraphApiError } from "./graph-api";
import { accountSource } from "./microsoft-credentials";
import { VENDOR_ID, getBaseUrl, type Env } from "./microsoft-env";
import { obsContext } from "./observability";
import { idPath, isMailId } from "./outlook-graph";
import { OutlookContext, OutlookReaderImpl, OutlookSessionImpl } from "./outlook-session";
import type { NewMessageHook } from "./outlook-types";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.outlook.hooks", vendorId: VENDOR_ID });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A subscription lives this long (Graph allows a little under 7 days for mail) and is renewed halfway. */
const SUBSCRIPTION_LIFETIME_MS = 3 * 24 * HOUR_MS;
const SUBSCRIPTION_RETRY_MS = HOUR_MS;
/** How often the folders are read anyway: hourly with notifications, every two minutes without. */
const SAFETY_SYNC_MS = HOUR_MS;
const POLL_SYNC_MS = 2 * MINUTE_MS;
const SYNC_RETRY_MS = 5 * MINUTE_MS;
/** Bounds one read; the next alarm, set for at once, continues it. */
const MAX_PAGES_PER_SYNC = 5;
const PAGE_SIZE = 50;
/** Read back this far before the cursor, for mail Exchange stamped with an earlier time than it indexed. */
const CURSOR_OVERLAP_MS = 2 * MINUTE_MS;

/** The gadget's hook, as the gatekeeper calls it. */
export type OutlookHookTarget = RpcTarget & NewMessageHook;

/** Sealed into a hook's delivery stub by `ctx.restore()`. Empty: the binding's own props decide what is delivered. */
export type OutlookHookParams = Record<string, never>;

/** What a hook's delivery stub reaches: the binding, narrowed to delivering. */
export interface OutlookHookDelivery extends RpcTarget {
  deliver(callback: RpcStub<OutlookHookTarget>, approvalQueue: RpcStub<ApprovalQueue>, messageId: string): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the binding subscribes it. */
export type OutlookHookProps = {
  key: string;
  /** The connection's `UserAccount` and the mailbox owner's object ID: together, the driver's name. */
  userObjectId: string;
  mailboxUser: string;
  /** Where its mail arrives. */
  folderId: string;
  delivery: RpcStub<OutlookHookDelivery>;
};

/** The `OutlookHookDriver` name for a connection and mailbox. */
function driverName(userObjectId: string, mailboxUser: string): string {
  return `${userObjectId}.${mailboxUser.toLowerCase()}`;
}

/** Binds a hook for new mail the binding covers. It stays disabled until the user enables it. */
export async function subscribeNewMessages(options: {
  ctx: OutlookContext;
  userObjectId: string;
  mailboxUser: string;
  restore(params: OutlookHookParams): Promise<RpcStub<OutlookHookDelivery>>;
  controller(props: OutlookHookProps): Fetcher<HookController<OutlookHookTarget>>;
  hook: RpcStub<OutlookHookTarget>;
}): Promise<void> {
  const { ctx } = options;
  const known = await ctx.wellKnown();
  const scope = ctx.scope;
  const folderId = scope.folder?.id ?? known.inbox;
  if (folderId === undefined) throw new Error("This mailbox has no Inbox to watch.");
  using delivery = await options.restore({});
  const controller = options.controller({
    key: crypto.randomUUID(), userObjectId: options.userObjectId, mailboxUser: options.mailboxUser, folderId, delivery,
  });
  const where = scope.folder ? `in ${escapeObservationValue(scope.folder.name)}` : "in Inbox";
  const mailbox = await ctx.mailbox();
  // @ts-expect-error An RPC stub's generic method loses its type parameter, so Hook is taken as RpcTarget.
  await ctx.queue.bindHook(controller, options.hook, {
    title: "Watch for new Outlook mail",
    description: `Call this hook with each new message ${where} of ${escapeObservationValue(mailbox.address)} that this connection covers, ` +
      "letting it read that message and propose replies and changes for approval.",
  });
}

/** What a hook's delivery stub restores to: one firing, of a message only if the binding covers it. */
@validateRpc()
export class OutlookHookDeliveryImpl extends RpcTarget implements OutlookHookDelivery {
  constructor(private readonly context: (approvalQueue: RpcStub<ApprovalQueue>) => Promise<OutlookContext>) {
    super();
  }

  async deliver(callback: RpcStub<OutlookHookTarget>, approvalQueue: RpcStub<ApprovalQueue>, messageId: string): Promise<void> {
    if (!isMailId(messageId)) throw new TypeError("Invalid Outlook message ID.");
    const ctx = await this.context(approvalQueue.dup());
    let handedOff = false;
    try {
      const message = await ctx.mail(mail => mail.message(messageId));
      // Deleted since it arrived, a draft, or not something this binding covers.
      if (message === null || message.isDraft || !(await ctx.covers(message))) return;
      const mailbox = await ctx.mailbox();
      // The mailbox's own mail, including sent copies whose `from` is a legacy X.500 address.
      if (ctx.own(message, mailbox).from === mailbox.address) return;
      const [info] = await ctx.infos([message]);
      await ctx.observe(sanitizeTitle(`New Outlook message: ${info!.subject || "(no subject)"}`),
        `Read the sender, recipients, time and subject of a new message from ${escapeObservationValue(info!.from?.address ?? "an unknown sender")}.`,
        [(await ctx.units()).message(message.id)]);
      const session = ctx.host.access === "read" ? new OutlookReaderImpl(ctx) : new OutlookSessionImpl(ctx);
      handedOff = true;
      await callback.receiveMessage({ message: info!, mail: session });
    } finally {
      if (!handedOff) ctx[Symbol.dispose]();
    }
  }
}

/** Enables and disables one hook by registering it with its driver. */
@validateRpc()
export class OutlookHookController extends WorkerEntrypoint<Env, OutlookHookProps> implements HookController<OutlookHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<OutlookHookTarget>>, _target: HookTargetMetadata): Promise<void> {
    const { key, delivery, userObjectId, mailboxUser, folderId } = this.ctx.props;
    // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
    await this.#driver().register(key, { userObjectId, mailboxUser, folderId }, { delivery, initiator });
  }

  async disable(): Promise<void> {
    await this.#driver().unregister(this.ctx.props.key);
  }

  #driver() {
    return this.ctx.exports.OutlookHookDriver.getByName(driverName(this.ctx.props.userObjectId, this.ctx.props.mailboxUser));
  }
}

// -- driver ------------------------------------------------------------------------------------

type Registration = { userObjectId: string; mailboxUser: string; folderId: string; /** Only mail received from here on. */ since: string };
type Capabilities = { delivery: RpcStub<OutlookHookDelivery>; initiator: Fetcher<HookInitiator<OutlookHookTarget>> };
/**
 * A folder being watched: its subscription, if Graph would take one, and how far it has been read.
 * `continueAt` is when the newest message a scan cut short by `MAX_PAGES_PER_SYNC` had read was
 * received, which the next sync resumes from instead of starting over at the cursor.
 */
type Watch = { subscriptionId?: string; expiresAt?: number; renewAt: number; cursor: string; continueAt?: string };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;
const watchKey = (folderId: string) => `watch:${folderId}`;
/** The watched folders, read up front: the loops over them write and await as they go. */
const watches = (kv: SyncKvStorage) => Array.from(kv.list<Watch>({ prefix: "watch:" }));
const CLIENT_STATE_KEY = "clientState";
const SYNC_AT_KEY = "syncAt";

/**
 * One per connection and mailbox (`driverName`). Storage: `reg:`/`caps:` per hook, `watch:` per
 * folder, `clientState` (the secret notifications must carry), `syncAt`, and the delivery queue's
 * rows, keyed by message ID. Every `await` opens the input gate, so writes after one re-read what
 * they depend on.
 */
export class OutlookHookDriver extends DurableObject<Env> {
  #queue = new HookDeliveryQueue<string>(this.ctx.storage.kv, () => {
    logger.warn("dropped an Outlook message after repeated delivery failures", { event: "outlook.hooks.delivery.dropped" });
  });

  async register(key: string, registration: Omit<Registration, "since">, capabilities: Capabilities): Promise<void> {
    if (!isMailId(registration.folderId)) throw new TypeError("Invalid Outlook folder ID.");
    const tracked = await this.#account(registration.userObjectId).trackHookDriver(driverName(registration.userObjectId, registration.mailboxUser));
    if (!tracked) throw new Error("This Microsoft 365 account has been disconnected.");
    const kv = this.ctx.storage.kv;
    const now = new Date().toISOString();
    if (kv.get<Watch>(watchKey(registration.folderId)) === undefined) {
      kv.put<Watch>(watchKey(registration.folderId), { renewAt: Date.now(), cursor: now });
    }
    const replaced = kv.get<Capabilities>(capabilitiesKey(key));
    kv.put<Registration>(registrationKey(key), { ...registration, since: now });
    kv.put(capabilitiesKey(key), capabilities);
    disposeStubs(replaced);
    // Subscribe now, so the approval that enabled the hook learns if Graph can't be reached.
    await this.#ensureSubscriptions();
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
    await this.#dropUnwatched();
  }

  /** Drops every hook here: the account is being disconnected. */
  async forgetAccount(): Promise<void> {
    for (const [regKey] of this.#registrations()) await this.unregister(regKey.slice("reg:".length));
  }

  /** A change notification arrived. Only a read follows, and only for the right secret. */
  async notify(clientState: string, lifecycleEvent?: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const expected = kv.get<string>(CLIENT_STATE_KEY);
    if (expected === undefined || !timingSafeEqual(clientState, expected)) return;
    if (this.#registrations().length === 0) return;
    if (lifecycleEvent === "reauthorizationRequired" || lifecycleEvent === "subscriptionRemoved") {
      for (const [watchKeyName, watch] of kv.list<Watch>({ prefix: "watch:" })) kv.put(watchKeyName, { ...watch, renewAt: Date.now() });
    }
    kv.put(SYNC_AT_KEY, Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (this.#registrations().length > 0) {
      await this.#ensureSubscriptions();
      if ((kv.get<number>(SYNC_AT_KEY) ?? 0) <= Date.now()) await this.#sync();
    }
    await this.#queue.run(Date.now(), (hookKey, messageId) => this.#deliver(hookKey, messageId));
    await this.#reschedule();
  }

  /** Reads what each watched folder received since its cursor, queues it, and advances the cursor. */
  async #sync(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const startedSyncAt = kv.get<number>(SYNC_AT_KEY);
    let nextSyncAt = Date.now() + (this.#pushing() ? SAFETY_SYNC_MS : POLL_SYNC_MS);
    try {
      for (const [key, watch] of watches(kv)) {
        const folderId = key.slice("watch:".length);
        // A scan cut short last time goes on from the newest message it read: starting over at the
        // cursor would re-read the same pages whenever more mail than one sync reads shares the
        // overlap window, and never reach what came after. It goes on by time, not from the Graph
        // page it stopped before: Graph pages mail by offset, which the gadgets filing mail out of
        // the folder between syncs would shift, skipping as many messages. A message received at
        // that very moment is read again, which the delivery queue drops as already queued.
        const from = watch.continueAt ?? new Date(Date.parse(watch.cursor) - CURSOR_OVERLAP_MS).toISOString();
        const scanStartedAt = Date.now();
        let completed = true;
        let newest = watch.cursor;
        let next: string | undefined = `${this.#mailboxPath()}/mailFolders/${idPath(folderId)}/messages`;
        let query: Record<string, string | number> | undefined = {
          $filter: `receivedDateTime ge ${from}`, $orderby: "receivedDateTime asc", $select: "id,receivedDateTime,isDraft", $top: PAGE_SIZE,
        };
        for (let pages = 0; next !== undefined; pages++) {
          if (pages === MAX_PAGES_PER_SYNC) {
            nextSyncAt = Date.now();
            completed = false;
            break;
          }
          const page: { value?: { id?: unknown; receivedDateTime?: unknown; isDraft?: unknown }[]; "@odata.nextLink"?: unknown } =
            await this.#graph(api => api.get(next!, { ...(query ? { query } : {}), prefer: ['IdType="ImmutableId"'] }));
          const registrations = this.#registrations().filter(([, registration]) => registration.folderId === folderId);
          for (const row of page.value ?? []) {
            if (typeof row.id !== "string" || typeof row.receivedDateTime !== "string" || row.isDraft === true) continue;
            for (const [regKey, registration] of registrations) {
              if (Date.parse(row.receivedDateTime) < Date.parse(registration.since)) continue;
              this.#queue.enqueue(regKey.slice("reg:".length), row.id, row.id, Date.now());
            }
            if (Date.parse(row.receivedDateTime) > Date.parse(newest)) newest = row.receivedDateTime;
          }
          next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
          query = undefined;
        }
        // A finished scan moves the cursor up to when it started (less the overlap), so an idle
        // folder doesn't keep re-reading its last message: the delivery queue forgets what it
        // delivered after a day, and would hand the message to the gadget again as new. A scan cut
        // short keeps the cursor on the newest message it reached, and continues from there.
        const settled = new Date(scanStartedAt - CURSOR_OVERLAP_MS).toISOString();
        const cursor = completed && Date.parse(settled) > Date.parse(newest) ? settled : newest;
        const current = kv.get<Watch>(key);
        if (current) kv.put<Watch>(key, { ...current, cursor, continueAt: completed ? undefined : newest });
      }
    } catch (error) {
      logger.warn("failed to read new Outlook mail", { event: "outlook.hooks.sync.failed", error });
      nextSyncAt = Date.now() + SYNC_RETRY_MS;
    }
    if (kv.get(SYNC_AT_KEY) === startedSyncAt) kv.put(SYNC_AT_KEY, nextSyncAt);
  }

  /** Creates or renews each watched folder's subscription when due. Without a public URL, polls instead. */
  async #ensureSubscriptions(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const notificationUrl = this.#notificationUrl();
    if (notificationUrl === null) return;
    let clientState = kv.get<string>(CLIENT_STATE_KEY);
    if (clientState === undefined) {
      clientState = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      kv.put(CLIENT_STATE_KEY, clientState);
    }
    for (const [key, watch] of watches(kv)) {
      if (watch.renewAt > Date.now()) continue;
      const folderId = key.slice("watch:".length);
      const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();
      try {
        let subscriptionId = watch.subscriptionId;
        if (subscriptionId !== undefined) {
          const renewed = await this.#graph(api => api.request("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId!)}`, { body: { expirationDateTime }, allow: [404] }));
          if (renewed === null) subscriptionId = undefined;
        }
        if (subscriptionId === undefined) {
          const created = await this.#graph(api => api.request<{ id?: unknown }>("POST", "/subscriptions", {
            body: {
              changeType: "created", notificationUrl, lifecycleNotificationUrl: notificationUrl,
              resource: `${this.#mailboxPath().slice(1)}/mailFolders('${folderId}')/messages`, expirationDateTime, clientState,
            },
          }));
          if (typeof created?.id !== "string") throw new GraphApiError(502, "Graph didn't say which subscription it created.");
          subscriptionId = created.id;
        }
        const current = kv.get<Watch>(key);
        if (current) kv.put<Watch>(key, { ...current, subscriptionId, expiresAt: Date.parse(expirationDateTime), renewAt: Date.now() + SUBSCRIPTION_LIFETIME_MS / 2 });
      } catch (error) {
        logger.warn("failed to subscribe to Outlook notifications; polling instead", { event: "outlook.hooks.subscribe.failed", error });
        const current = kv.get<Watch>(key);
        if (current) kv.put<Watch>(key, { ...current, renewAt: Date.now() + SUBSCRIPTION_RETRY_MS });
      }
    }
  }

  /** Stops watching folders no hook delivers from, deleting their subscriptions best effort. */
  async #dropUnwatched(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const folders = new Set(this.#registrations().map(([, registration]) => registration.folderId));
    for (const [key, watch] of watches(kv)) {
      if (folders.has(key.slice("watch:".length))) continue;
      kv.delete(key);
      if (watch.subscriptionId !== undefined) {
        await this.#graph(api => api.request("DELETE", `/subscriptions/${encodeURIComponent(watch.subscriptionId!)}`, { allow: [404] }))
          .catch(error => logger.info("couldn't delete an Outlook subscription; it will lapse", { event: "outlook.hooks.unsubscribe.failed", error }));
      }
    }
    if (folders.size === 0) {
      kv.delete(SYNC_AT_KEY);
      kv.delete(CLIENT_STATE_KEY);
    }
  }

  async #deliver(hookKey: string, messageId: string): Promise<void> {
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, messageId);
    } finally {
      disposeStubs(capabilities);
    }
  }

  #pushing(): boolean {
    return [...this.ctx.storage.kv.list<Watch>({ prefix: "watch:" })].every(([, watch]) => watch.subscriptionId !== undefined);
  }

  /** Where Graph posts notifications, or null when this deployment isn't reachable over HTTPS. */
  #notificationUrl(): string | null {
    const base = getBaseUrl(this.env);
    const url = new URL(base);
    if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) return null;
    return `${base}/outlook/notifications/${encodeURIComponent(this.ctx.id.name ?? "")}`;
  }

  #mailboxPath(): string {
    const [, mailboxUser] = (this.ctx.id.name ?? "").split(".");
    return `/users/${encodeURIComponent(mailboxUser ?? "")}`;
  }

  #graph<T>(op: (api: GraphApi) => Promise<T>): Promise<T> {
    const [userObjectId] = (this.ctx.id.name ?? "").split(".");
    return accountSource(this.ctx.exports, userObjectId!).run(creds => op(new GraphApi(creds.accessToken)), { replayable: true });
  }

  #registrations(): [string, Registration][] {
    return [...this.ctx.storage.kv.list<Registration>({ prefix: "reg:" })];
  }

  #account(userObjectId: string) {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
  }

  async #reschedule(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const times: number[] = [];
    const queueDue = this.#queue.nextDue();
    if (queueDue !== undefined) times.push(queueDue);
    if (this.#registrations().length > 0) {
      times.push(kv.get<number>(SYNC_AT_KEY) ?? Date.now());
      if (this.#notificationUrl() !== null) {
        for (const [, watch] of kv.list<Watch>({ prefix: "watch:" })) times.push(watch.renewAt);
      }
    }
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  return bytesA.byteLength === bytesB.byteLength && crypto.subtle.timingSafeEqual(bytesA, bytesB);
}

/** A name `driverName` makes: the `UserAccount` Durable Object ID (64 hex digits), then the mailbox user's object ID. */
const DRIVER_NAME = /^[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_STATES_PER_POST = 2;
const MAX_NOTIFICATION_BYTES = 1024 * 1024;

/**
 * Handles `POST {BASE_URL}/outlook/notifications/{driver}`: Graph's validation handshake, then
 * change and lifecycle notifications, each passed to its driver to check and act on. Answers 202
 * at once for anything well-formed, as Graph asks, whether or not it was genuine.
 */
export async function handleOutlookNotification(request: Request, driver: string, exports: Cloudflare.Exports, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST" || !DRIVER_NAME.test(driver)) return new Response("Not Found", { status: 404 });
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token !== null) {
    // Before creating a subscription, Graph checks the URL by asking for this token back.
    return new Response(token.slice(0, 1024), { status: 200, headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" } });
  }
  let text: string;
  try {
    text = await readTextCapped(request, MAX_NOTIFICATION_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return new Response("Too large", { status: 413 });
    throw error;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const notifications = Array.isArray((body as { value?: unknown })?.value) ? (body as { value: unknown[] }).value : [];
  const stub = exports.OutlookHookDriver.getByName(driver);
  const states = new Map<string, string | undefined>();
  for (const notification of notifications.slice(0, 100)) {
    if (notification === null || typeof notification !== "object") continue;
    const { clientState, lifecycleEvent } = notification as { clientState?: unknown; lifecycleEvent?: unknown };
    if (typeof clientState !== "string" || clientState.length > 128) continue;
    // A driver has one client state, so a real post carries one; more than a couple is someone
    // guessing, and each guess would cost a call to the driver.
    if (!states.has(clientState) && states.size >= MAX_STATES_PER_POST) continue;
    states.set(clientState, typeof lifecycleEvent === "string" ? lifecycleEvent : states.get(clientState));
  }
  ctx.waitUntil(Promise.all([...states].map(([clientState, lifecycleEvent]) => stub.notify(clientState, lifecycleEvent).catch(error => {
    logger.warn("failed to pass an Outlook notification on", { event: "outlook.hooks.notify.failed", error });
  }))));
  return new Response(null, { status: 202 });
}
