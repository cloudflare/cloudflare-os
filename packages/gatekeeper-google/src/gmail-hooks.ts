// Gmail new-message hooks: one Gmail push watch (`users.watch`) per mailbox, delivered through
// Pub/Sub push to `POST {BASE_URL}/pubsub`.
//
// A Gmail push names only the mailbox and a history ID. The mailbox's `GmailHookDriver` therefore
// reads what was added since its cursor with `history.list`, and delivers each new message to
// every hook that watches for it through the facet's self-stub, which decides whether the binding
// admits the message and builds the capability the hook receives. As for Chat (see chat-hooks.ts),
// `GmailHookController` is a loopback entrypoint so that removing a connection, which deletes the
// facet, still reaches it. Pushes can be delayed or dropped, so the driver also reads the history
// hourly.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SingleFlight } from "@gadgets/gatekeeper-kit/single-flight";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { GmailApi, GmailApiError } from "./google-api";
import { HOUR_MS, HookDeliveryQueue, MINUTE_MS, disposeStubs } from "./hook-delivery-queue";
import { obsContext } from "./observability";
import type { PushHooksEnv } from "./pubsub-push";
import type { GmailMessageHook } from "./types";

const logger = obsContext.createLogger({ component: "gatekeeper.google.gmail-hooks", vendorId: "google" });

type Env = Cloudflare.Env & PushHooksEnv;

export type GmailMessageHookTarget = RpcTarget & GmailMessageHook;

/**
 * Where a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`: one thread,
 * or (`{}`) what the binding lists.
 */
export type GmailHookParams = { threadId?: string };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface GmailHookDelivery extends RpcTarget {
  /**
   * Deliver message `messageId` to one firing of the hook if it is new mail the hook watches for;
   * otherwise return without calling it.
   */
  deliver(callback: RpcStub<GmailMessageHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          messageId: string): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type GmailHookProps = GmailHookParams & {
  key: string;
  /** The mailbox address Gmail reports (users.getProfile), lowercased: the driver's name, and what its pushes carry. */
  mailbox: string;
  userObjectId: string;
  /** A label new mail must arrive with for this hook to be tried: grants nothing, only spares deliveries the facet would refuse. */
  labelId?: string;
  delivery: RpcStub<GmailHookDelivery>;
};

@validateRpc()
export class GmailHookController extends WorkerEntrypoint<Env, GmailHookProps>
    implements HookController<GmailMessageHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<GmailMessageHookTarget>>,
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
    return this.ctx.exports.GmailHookDriver.getByName(this.ctx.props.mailbox);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** Gmail stops a watch after 7 days and asks for a daily renewal. */
const WATCH_RENEW_INTERVAL_MS = 24 * HOUR_MS;
const WATCH_RENEW_RETRY_MS = HOUR_MS;
/** Pushes can be delayed or dropped, so the history is read at least this often. */
const SAFETY_SYNC_INTERVAL_MS = HOUR_MS;
const SYNC_RETRY_MS = 5 * MINUTE_MS;
/** Bounds one alarm's history read; the next alarm, set for at once, continues it. */
const MAX_HISTORY_PAGES_PER_SYNC = 10;
/**
 * Labels whose mail no hook is delivered: the account's own mail, spam and trash, even on a label
 * binding to SPAM or TRASH, which lists them.
 */
export const UNDELIVERED_GMAIL_LABELS: readonly string[] = ["SENT", "DRAFT", "SPAM", "TRASH"];

type Registration = Omit<GmailHookProps, "key" | "delivery"> & {
  /** The mailbox's history ID when the hook was enabled: only later records reach it. */
  since: string;
};
type Capabilities = {
  delivery: RpcStub<GmailHookDelivery>;
  initiator: Fetcher<HookInitiator<GmailMessageHookTarget>>;
};
type Watch = { expiration: number; renewAt: number };
type Profile = { emailAddress: string; historyId: string };
type AddedMessage = { id: string; threadId: string; labelIds?: string[] };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;

/** The connection now reads another mailbox, so pushes for its new address never reach this driver. */
class MailboxChangedError extends Error {
  constructor() {
    super("This Gmail connection now reads a different address. Subscribe its hooks again.");
  }
}

/**
 * One per mailbox, named by its lowercased address. Storage: `reg:`/`caps:` per hook, `watch`,
 * `cursor` (the history ID read through), `syncAt` (when to read next), and the delivery queue's
 * `msg:` rows, whose message is a Gmail message ID. History IDs are compared only as `BigInt`s.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class GmailHookDriver extends DurableObject<Env> {
  #watching = new SingleFlight();
  #queue = new HookDeliveryQueue<string>(this.ctx.storage, () => {
    logger.warn("dropped a Gmail message after repeated delivery failures", { event: "gmail.hooks.delivery.dropped" });
  });

  async register(key: string, registration: Omit<Registration, "since">, capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    const api = this.#api(registration);
    const profile = await this.#profile(api, registration.mailbox);
    const watch = kv.get<Watch>("watch");
    if (!watch || watch.renewAt <= Date.now() || watch.expiration <= Date.now()) await this.#watch(api);

    const cursor = kv.get<string>("cursor");
    if (cursor === undefined || BigInt(cursor) > BigInt(profile.historyId)) {
      // A sync that finished during this enable's awaits read past `since` without this hook; the
      // range read again is deduplicated by the queue.
      kv.put("cursor", profile.historyId);
      kv.put("syncAt", Date.now());
    } else if (kv.get("syncAt") === undefined) {
      kv.put("syncAt", Date.now() + SAFETY_SYNC_INTERVAL_MS);
    }
    const replaced = kv.get<Capabilities>(capabilitiesKey(key));
    kv.put<Registration>(registrationKey(key), { ...registration, since: profile.historyId });
    kv.put(capabilitiesKey(key), capabilities);
    disposeStubs(replaced);
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
    // The watch is left to lapse rather than stopped: stopping would race a concurrent enable's
    // fresh watch, and needs credentials a removed connection may no longer have.
    if (this.#registrations().length === 0) {
      kv.delete("cursor");
      kv.delete("syncAt");
    }
  }

  /** Read the history now, if a push reports history this driver hasn't read. */
  async notify(historyId: string): Promise<void> {
    if (this.#registrations().length === 0) return;
    const cursor = this.ctx.storage.kv.get<string>("cursor");
    if (cursor !== undefined && BigInt(historyId) <= BigInt(cursor)) return;
    const now = Date.now();
    this.ctx.storage.kv.put("syncAt", now);
    await this.#wakeBy(now);
  }

  /**
   * The driver's one alarm, which #wakeBy() and #reschedule() set for the earliest time any of
   * these is due:
   * - reading new history, when a push reported some or hourly, and queueing what it added;
   * - renewing the mailbox's watch while any hook uses it, retrying hourly if renewal fails;
   * - forgetting an expired watch no hook uses any more;
   * - delivering each queued message whose (re)try time has come, and forgetting finished ones.
   */
  async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (this.#registrations().length > 0 && (kv.get<number>("syncAt") ?? 0) <= Date.now()) await this.#sync();

    const watch = kv.get<Watch>("watch");
    if (this.#registrations().length > 0) {
      if (!watch || watch.renewAt <= Date.now()) {
        try {
          await this.#watch((await this.#mailboxApi()).api);
        } catch (error) {
          logger.warn("failed to renew a Gmail watch", { event: "gmail.hooks.watch.failed", error });
          // An enable may have stored a fresh watch meanwhile, which this must not overwrite.
          const current = kv.get<Watch>("watch");
          if (current?.expiration === watch?.expiration && current?.renewAt === watch?.renewAt) {
            kv.put<Watch>("watch", { expiration: watch?.expiration ?? 0, renewAt: Date.now() + WATCH_RENEW_RETRY_MS });
          }
        }
      }
    } else if (watch && watch.expiration <= Date.now()) {
      kv.delete("watch");
    }

    // After the sync, so the rows it just queued are due in this same run.
    await this.#queue.run(Date.now(), (hookKey, messageId) => this.#deliver(hookKey, messageId));
    await this.#reschedule();
  }

  /**
   * Queue what the history added since the cursor, then advance it. Invariant: every registration
   * has been offered every record in `(since, cursor]`.
   */
  async #sync(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const startedSyncAt = kv.get<number>("syncAt");
    const startedSince = new Map(this.#registrations().map(([key, registration]) => [key, registration.since]));
    const startedCursor = kv.get<string>("cursor");
    try {
      const { api, profile } = await this.#mailboxApi();
      let next = profile.historyId;
      let nextSyncAt = now + SAFETY_SYNC_INTERVAL_MS;
      if (startedCursor !== undefined) {
        try {
          let highest: string | undefined;
          let pageToken: string | undefined;
          for (let pages = 0; ; pages++) {
            if (pages === MAX_HISTORY_PAGES_PER_SYNC) {
              // The highest record read rather than the last page's last, so an empty final page
              // can't stall progress.
              next = highest ?? startedCursor;
              nextSyncAt = Date.now();
              break;
            }
            const page = await api.listMessagesAdded(startedCursor, pageToken);
            const registrations = this.#registrations();
            for (const record of page.records) {
              for (const message of record.messages) this.#enqueue(registrations, record.id, message);
              if (highest === undefined || BigInt(record.id) > BigInt(highest)) highest = record.id;
            }
            if (!page.nextPageToken) {
              next = page.historyId;
              break;
            }
            pageToken = page.nextPageToken;
          }
        } catch (error) {
          if (!(error instanceof GmailApiError && error.status === 404)) throw error;
          // Mail that arrived in the gap is not delivered.
          logger.warn("Gmail history expired; watching from now", { event: "gmail.hooks.history.expired" });
          next = profile.historyId;
          nextSyncAt = now + SAFETY_SYNC_INTERVAL_MS;
        }
        // Every request takes the connection's current token, so a reconnect to another Google
        // account during the read would have read that account's history instead.
        if ((await api.getProfile()).emailAddress !== profile.emailAddress) {
          throw new Error("The connection changed Google accounts while reading Gmail history.");
        }
      }

      const registrations = this.#registrations();
      if (registrations.length === 0) return;
      for (const [key, registration] of registrations) {
        // Enabled during this sync, so not offered the pages read before it existed.
        if (startedSince.get(key) === registration.since) continue;
        if (BigInt(registration.since) < BigInt(next)) {
          next = registration.since;
          nextSyncAt = Date.now();
        }
      }
      kv.put("cursor", next);
      // A push or an enable during the sync set its own time, which must stand.
      if (kv.get("syncAt") === startedSyncAt) kv.put("syncAt", nextSyncAt);
    } catch (error) {
      const changed = error instanceof MailboxChangedError;
      if (changed) {
        logger.error("Gmail hooks' mailbox changed address", { event: "gmail.hooks.mailbox.changed" });
      } else {
        logger.warn("failed to read new Gmail history", { event: "gmail.hooks.sync.failed", error });
      }
      if (kv.get("syncAt") === startedSyncAt) {
        kv.put("syncAt", Date.now() + (changed ? SAFETY_SYNC_INTERVAL_MS : SYNC_RETRY_MS));
      }
    }
  }

  /** Queue one added message for each hook that watches for it. */
  #enqueue(registrations: [string, Registration][], recordId: string, { id, threadId, labelIds }: AddedMessage): void {
    // The facet re-checks authoritatively. This prefilter exists because every delivery attempt
    // starts a hook firing in its workspace, so unfiltered spam would wake every subscriber.
    if (labelIds?.some(label => UNDELIVERED_GMAIL_LABELS.includes(label))) return;
    for (const [regKey, registration] of registrations) {
      if (labelIds && registration.labelId !== undefined && !labelIds.includes(registration.labelId)) continue;
      if (BigInt(recordId) <= BigInt(registration.since)) continue;
      if (registration.threadId !== undefined && registration.threadId !== threadId) continue;
      this.#queue.enqueue(regKey.slice("reg:".length), id, id, Date.now());
    }
  }

  async #deliver(hookKey: string, messageId: string): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling or deleting the hook unregisters it, which ends the retries.
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, messageId);
    } finally {
      disposeStubs(capabilities);
    }
  }

  /** An API client for the mailbox, from the first connection still reading it. */
  async #mailboxApi(): Promise<{ api: GmailApi; profile: Profile }> {
    const tried = new Set<string>();
    let lastError: unknown;
    let otherError: unknown;
    for (const [, registration] of this.#registrations()) {
      if (tried.has(registration.userObjectId)) continue;
      tried.add(registration.userObjectId);
      const api = this.#api(registration);
      try {
        return { api, profile: await this.#profile(api, registration.mailbox) };
      } catch (error) {
        lastError = error;
        if (!(error instanceof MailboxChangedError)) otherError = error;
      }
    }
    if (tried.size === 0) throw new Error("No Gmail hook watches this mailbox.");
    // A changed address only if every connection reports one.
    throw otherError ?? lastError;
  }

  /**
   * The mailbox's profile, refusing one with another address: a reconnect to another Google
   * account, or a Workspace primary-address rename, after which pushes name the new address.
   */
  async #profile(api: GmailApi, mailbox: string): Promise<Profile> {
    const profile = await api.getProfile();
    if (profile.emailAddress.toLowerCase() !== mailbox) throw new MailboxChangedError();
    return profile;
  }

  #api({ mailbox, userObjectId }: Pick<Registration, "mailbox" | "userObjectId">): GmailApi {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return new GmailApi(mailbox, async opts => (await account.getAccessToken(opts)).token);
  }

  /** Watch the mailbox, joining any watch already in flight. */
  #watch(api: GmailApi): Promise<void> {
    return this.#watching.run("watch", async () => {
      let watch: { expiration: number };
      try {
        watch = await api.watch(this.env.PUBSUB_TOPIC!);
      } catch (cause) {
        if (!(cause instanceof GmailApiError && (cause.status === 400 || cause.status === 403))) throw cause;
        throw new Error(`Gmail refused to watch this mailbox [http=${cause.status}]. Check that PUBSUB_TOPIC is in the OAuth client's Cloud project and grants gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role; a 403 can also mean Gmail is rate-limiting this account.`, { cause });
      }
      this.ctx.storage.kv.put<Watch>("watch", {
        expiration: watch.expiration, renewAt: Date.now() + WATCH_RENEW_INTERVAL_MS,
      });
    });
  }

  #registrations(): [string, Registration][] {
    return [...this.ctx.storage.kv.list<Registration>({ prefix: "reg:" })];
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }

  async #reschedule(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const times: number[] = [];
    const queueDue = this.#queue.nextDue();
    if (queueDue !== undefined) times.push(queueDue);
    const watch = kv.get<Watch>("watch");
    if (this.#registrations().length > 0) {
      times.push(kv.get<number>("syncAt") ?? Date.now(), watch?.renewAt ?? Date.now());
    } else if (watch) {
      times.push(watch.expiration);
    }
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
  }
}

// ── Push ingest ─────────────────────────────────────────────────────

/**
 * Tell a mailbox's driver about one Gmail push; ignore a malformed one. A forged push can only
 * make the driver read the mailbox with its own credentials: it carries no content.
 */
export async function ingestGmailPush(data: string, exports: Cloudflare.Exports): Promise<void> {
  let push: unknown;
  try {
    push = JSON.parse(data);
  } catch {
    return;
  }
  if (typeof push !== "object" || push === null) return;
  const { emailAddress, historyId } = push as { emailAddress?: unknown; historyId?: unknown };
  if (typeof emailAddress !== "string" || emailAddress.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(emailAddress)) return;
  if (typeof historyId !== "string" && typeof historyId !== "number") return;
  if (!/^\d{1,20}$/.test(String(historyId))) return;
  await exports.GmailHookDriver.getByName(emailAddress.toLowerCase()).notify(String(historyId));
}
