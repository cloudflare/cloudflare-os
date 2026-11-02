// Google Calendar event hooks: one push channel (`events.watch`) per connected account and
// calendar, posting to `POST {BASE_URL}/calendar/notifications/{driver}`.
//
// A Calendar notification carries no event, only that the calendar changed. The calendar's
// `CalendarHookDriver` therefore reads what changed since its sync token with `events.list`, tells
// a new event from an updated one by the events it has seen, picks the hooks that watch for each
// change, and delivers it to them through the facet's self-stub, which reads the event and builds
// the calendar capability the hook receives. As for Gmail (see gmail-hooks.ts),
// `CalendarHookController` is a loopback entrypoint so that removing a connection, which deletes the
// facet, still reaches it.
//
// Notifications can be late or dropped, and can't reach a deployment without a public https URL at
// all, so the driver also reads the calendar hourly, or every two minutes until a notification on
// its channel shows that they arrive.
//
// Every write the gatekeeper applies sets a fresh `CALENDAR_WRITE_MARK` on the event, so a change
// whose mark differs from the one the driver last saw for that event is the gatekeeper's own. Such a
// change is never delivered, which keeps hooks from answering themselves or one another, as Chat's
// hooks drop what the account posts through the gatekeeper.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { codeSpan, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { constantTimeEqual, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { HookDeliveryQueue, disposeStubs } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { SingleFlight } from "@gadgets/gatekeeper-kit/single-flight";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GoogleCalendarApi, GoogleCalendarApiError, type CalendarChangeRecord, type CalendarChangesPage,
} from "./calendar-api";
import type {
  CalendarEvent, CalendarEventChangeKind, CalendarEventHook, CalendarSubscribeOptions,
  GoogleCalendarSession,
} from "./calendar-types";
import { HookDriverAccounts } from "./hook-accounts";
import { getBaseUrl, type GoogleOAuthEnv } from "./oauth";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.calendar-hooks", vendorId: "google" });

type Env = Cloudflare.Env & GoogleOAuthEnv;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type CalendarEventHookTarget = RpcTarget & CalendarEventHook;

/** Sealed into a hook's delivery stub by the facet's `ctx.restore()`: whether it is given descriptions. */
export type CalendarHookParams = { includeDescriptions?: boolean };

/** One change to deliver: the event, and what kind of change the driver read. */
export type CalendarHookChange = { eventId: string; change: CalendarEventChangeKind };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface CalendarHookDelivery extends RpcTarget {
  /**
   * Deliver `change` to one firing of the hook, as `HookInitiator.startHook()` returned it, unless
   * the event is gone.
   */
  deliver(callback: RpcStub<CalendarEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          change: CalendarHookChange): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type CalendarHookProps = {
  key: string;
  userObjectId: string;
  calendarId: string;
  /** The kinds of change delivered; every kind when absent. */
  changes?: CalendarEventChangeKind[];
  /** Only changes to this event, or to an occurrence of this series, are delivered. */
  eventId?: string;
  delivery: RpcStub<CalendarHookDelivery>;
};

/** The `CalendarHookDriver` name for a connection's calendar: the account's ID has a fixed length. */
function calendarHookDriverName(userObjectId: string, calendarId: string): string {
  return `${userObjectId}:${calendarId}`;
}

/**
 * Where Google posts a driver's notifications, or null when this deployment isn't reachable over
 * https, which Google requires.
 */
function calendarNotificationUrl(baseUrl: string, driverId: string): string | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) return null;
  return `${baseUrl}/calendar/notifications/${driverId}`;
}

const CHANGE_KINDS: readonly CalendarEventChangeKind[] = ["created", "updated", "cancelled"];

/** Bind a hook on changes to the calendar's events. It stays disabled until the user enables it. */
export async function subscribeCalendarEventChanges({
  approvalQueue, userObjectId, calendarId, hook, options = {}, restore, controller,
}: {
  approvalQueue: RpcStub<ApprovalQueue>;
  userObjectId: string;
  calendarId: string;
  hook: RpcStub<CalendarEventHookTarget>;
  options: CalendarSubscribeOptions | undefined;
  restore(params: CalendarHookParams): Promise<RpcStub<CalendarHookDelivery>>;
  controller(props: CalendarHookProps): Fetcher<HookController<CalendarEventHookTarget>>;
}): Promise<void> {
  const { changes, eventId, includeDescriptions } = options;
  if (changes?.length === 0) throw new TypeError("options.changes must name at least one kind of change.");
  // Every kind is the same as none named, and stored as none.
  const kinds = changes === undefined || CHANGE_KINDS.every(kind => changes.includes(kind))
    ? undefined
    : CHANGE_KINDS.filter(kind => changes.includes(kind));

  using delivery = await restore(includeDescriptions ? { includeDescriptions: true } : {});
  const bound = controller({
    key: crypto.randomUUID(), userObjectId, calendarId,
    ...(kinds !== undefined ? { changes: kinds } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    delivery,
  });
  const calendar = codeSpan(calendarId);
  const when = eventId === undefined
    ? `with each ${listOf((kinds ?? CHANGE_KINDS).map(kind => NEW_EVENT_WORDS[kind]))} event on calendar ${calendar}`
    : `each time event ${codeSpan(eventId)} on calendar ${calendar}, or one of its occurrences, is ` +
      listOf(kinds ?? CHANGE_KINDS);
  // @ts-expect-error An RPC stub's generic method loses its type parameter, so Hook is taken as RpcTarget.
  await approvalQueue.bindHook(bound, hook, {
    title: "Watch for Google Calendar changes",
    description: `Call this hook ${when}, letting it read that event` +
      `${includeDescriptions ? " with its description" : ""} and the calendar, and queue changes to the ` +
      "calendar for approval.",
  });
}

/** How the approver reads each kind of change, said of an event. */
const NEW_EVENT_WORDS: Record<CalendarEventChangeKind, string> = {
  created: "new", updated: "updated", cancelled: "cancelled",
};

/** `a`, `a or b`, `a, b or c`. */
function listOf(words: readonly string[]): string {
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/** What a hook's delivery stub restores to: one firing, of a change to an event on the calendar. */
@validateRpc()
export class CalendarHookDeliveryImpl extends RpcTarget implements CalendarHookDelivery {
  constructor(
    private readonly calendarId: string,
    private readonly params: CalendarHookParams,
    private readonly api: GoogleCalendarApi,
    /** The calendar session a firing hands the hook, over that firing's approval queue. */
    private readonly session: (approvalQueue: RpcStub<ApprovalQueue>) => GoogleCalendarSession,
  ) {
    super();
  }

  async deliver(callback: RpcStub<CalendarEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                { eventId, change }: CalendarHookChange): Promise<void> {
    const includeDescriptions = this.params.includeDescriptions ?? false;
    let event: CalendarEvent;
    try {
      event = await this.api.getEvent(this.calendarId, eventId, { includeDescriptions });
    } catch (error) {
      // Purged since, leaving nothing to deliver; a deleted event still reads as cancelled.
      if (error instanceof GoogleCalendarApiError && (error.status === 404 || error.status === 410)) return;
      throw error;
    }
    if (event.id !== eventId) throw new Error("Google Calendar event identity changed unexpectedly.");
    await approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Google Calendar event ${change}: ${event.title}`),
      description: `Read the title, time, location, attendees and status${includeDescriptions ? ", and the description," : ""} ` +
        `of an event this hook watches on calendar ${codeSpan(this.calendarId)}.`,
    });
    // Only now, so a skipped change takes no reference to the approval queue.
    await callback.receiveEventChange({ change, event, calendar: this.session(approvalQueue) });
  }
}

@validateRpc()
export class CalendarHookController extends WorkerEntrypoint<Env, CalendarHookProps>
    implements HookController<CalendarEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<CalendarEventHookTarget>>,
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
    const { userObjectId, calendarId } = this.ctx.props;
    return this.ctx.exports.CalendarHookDriver.getByName(calendarHookDriverName(userObjectId, calendarId));
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** What a channel is asked to live for: Google's default, and its limit for events. */
const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A channel is replaced this long before it expires, or halfway through a shorter life. */
const CHANNEL_RENEW_LEAD_MS = DAY_MS;
/** A channel Google refused is asked for again after this, doubling with each refusal in a row. */
const CHANNEL_RETRY_MS = HOUR_MS;
const CHANNEL_RETRY_MAX_MS = DAY_MS;
/** While notifications arrive, the calendar is still read this often, for any that were dropped. */
const SAFETY_SYNC_INTERVAL_MS = HOUR_MS;
/** Until one has arrived on the current channel, it is read this often instead. */
const POLL_SYNC_INTERVAL_MS = 2 * MINUTE_MS;
/**
 * A failed read is retried after this, doubling with each failure in a row, so a calendar the
 * account can no longer read is tried hourly rather than every few minutes.
 */
const SYNC_RETRY_MS = 5 * MINUTE_MS;
const SYNC_RETRY_MAX_MS = HOUR_MS;
/** Bounds one alarm's read; the next alarm, set for at once, continues it. */
const MAX_PAGES_PER_READ = 10;
/** Reads an enable makes to catch up with the calendar before giving up. */
const MAX_ENABLE_READS = 5;
/**
 * How far back the first listing goes, so that an edit to an event that had just ended when hooks
 * started watching reads as an update.
 */
const FIRST_LISTING_LOOKBACK_MS = 7 * DAY_MS;

/** How long to wait after `failures` failures in a row: `first`, doubling with each, up to `max`. */
function backoff(failures: number, first: number, max: number): number {
  return Math.min(first * 2 ** (failures - 1), max);
}

type Registration = Omit<CalendarHookProps, "key" | "delivery">;
type Capabilities = {
  delivery: RpcStub<CalendarHookDelivery>;
  initiator: Fetcher<HookInitiator<CalendarEventHookTarget>>;
};
/** Whose calendar the driver reads, and with which account: the same for every registration. */
type Source = Pick<Registration, "userObjectId" | "calendarId">;

/**
 * How far the calendar has been read. `epoch` names this state's lifetime: forgetting the calendar
 * (its last hook disabled, or Google expiring the token) starts a new one, and a read that began in
 * another is discarded. Until the first listing completes there is no `token`, only the `timeMin`
 * it lists from; `pageToken` is set while a listing or a read of changes is part way through, and
 * its later pages must repeat the query it began with.
 */
type SyncState = { epoch: string; token?: string; timeMin?: string; pageToken?: string };

/** A push channel being opened, whose notifications are accepted before Google has answered. */
type PendingChannel = { id: string; token: string; confirmed?: boolean };
/** The open push channel. `confirmed` once a notification on it has arrived. */
type Channel = PendingChannel & { resourceId: string; expiration: number };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;
/**
 * An event on the calendar, as the driver last read it: the write mark it carried, or "" for none.
 * An event absent here is new to the calendar, unless it is an occurrence of a series present.
 */
const knownKey = (eventId: string) => `known:${eventId}`;

/**
 * One per connection and calendar (`calendarHookDriverName`). Storage: `reg:`/`caps:` per hook, the
 * HookDriverAccounts keys, `sync` (how far the calendar has been read), `known:` per event, `syncAt`
 * (when to read next) and `syncFailures` (failed reads in a row), `channel`, `nextChannel`,
 * `channelAt` (when to open or replace the channel) and `channelFailures` (refusals in a row), and
 * the delivery queue's rows, keyed by event ID and etag.
 *
 * `known:` keeps every event the driver has seen and that hasn't been deleted, a hundred bytes or so
 * each, rather than forget events once they end: an edit to a forgotten one would read as new.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class CalendarHookDriver extends DurableObject<Env> {
  #reading = new SingleFlight();
  #opening = new SingleFlight();
  #queue = new HookDeliveryQueue<CalendarHookChange>(this.ctx.storage.kv, () => {
    logger.warn("dropped a Google Calendar change after repeated delivery failures", {
      event: "calendar.hooks.delivery.dropped",
    });
  });
  #accounts = new HookDriverAccounts(this.ctx, "calendar", error => {
    logger.warn("failed to note a Google Calendar hook driver with its account", { event: "calendar.hooks.track.failed", error });
  });

  async register(key: string, registration: Registration, capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    const { userObjectId, calendarId } = registration;
    await this.#accounts.track(userObjectId, calendarHookDriverName(userObjectId, calendarId));
    // Catch up first, so that the hook is offered only what later reads find.
    for (let reads = 0; ; reads++) {
      if (reads === MAX_ENABLE_READS) {
        throw new Error("Google Calendar has more changes to read than enabling a hook can wait for. Try again in a few minutes.");
      }
      await this.#read(registration);
      const state = kv.get<SyncState>("sync");
      if (state?.token !== undefined && state.pageToken === undefined) break;
    }
    // Disconnected meanwhile, when its hooks were dropped.
    this.#accounts.assertConnected(userObjectId);

    // Nothing from here to the registration awaits, so no read can begin between the one that just
    // finished and it.
    const replaced = kv.get<Capabilities>(capabilitiesKey(key));
    kv.put<Registration>(registrationKey(key), registration);
    kv.put(capabilitiesKey(key), capabilities);
    disposeStubs(replaced);
    if (kv.get("syncAt") === undefined) kv.put("syncAt", Date.now() + POLL_SYNC_INTERVAL_MS);
    // Open the channel now, so that Google's first notification on it soon shows that they arrive.
    await this.#ensureChannel(registration);
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    const registration = this.ctx.storage.kv.get<Registration>(registrationKey(key));
    this.#drop(key);
    if (registration === undefined || this.#registrations().length > 0) return;
    // The last hook. Its channel is stopped rather than left posting for days, but only after its
    // record is gone, so that an enable meanwhile opens one of its own.
    const channel = this.#forgetCalendar();
    if (channel !== undefined) {
      await this.#api(registration.userObjectId).stopChannel(channel.id, channel.resourceId).catch((error: unknown) => {
        logger.info("couldn't stop a Google Calendar channel; it will lapse", { event: "calendar.hooks.channel.stop.failed", error });
      });
    }
  }

  /**
   * Drop the hooks of an account being disconnected (see UserAccount.revoke()). Its channel lapses:
   * stopping it would need the credentials being deleted.
   */
  async forgetAccount(userObjectId: string): Promise<void> {
    this.#accounts.forget(userObjectId);
    for (const [regKey, registration] of this.#registrations()) {
      if (registration.userObjectId === userObjectId) this.#drop(regKey.slice("reg:".length));
    }
    if (this.#registrations().length === 0) this.#forgetCalendar();
  }

  /**
   * A notification arrived for `channelId`. It counts only with that channel's token, and then
   * only prompts a read: Google's first one on a channel (state `sync`) just shows that they arrive.
   */
  async notify(channelId: string, token: string, state: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    for (const key of ["channel", "nextChannel"]) {
      const channel = kv.get<PendingChannel>(key);
      if (channel?.id !== channelId || !constantTimeEqual(token, channel.token)) continue;
      if (!channel.confirmed) kv.put(key, { ...channel, confirmed: true });
      if (state === "sync" || this.#registrations().length === 0) return;
      const now = Date.now();
      kv.put("syncAt", now);
      await this.#wakeBy(now);
      return;
    }
  }

  /**
   * The driver's one alarm, which #wakeBy() and #reschedule() set for the earliest time any of
   * these is due:
   * - reading the calendar's changes, when a notification reported some or on a timer, and
   *   queueing them;
   * - opening the calendar's channel, or replacing it before it expires;
   * - delivering each queued change whose (re)try time has come, and forgetting finished ones.
   */
  async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    await this.#accounts.recheck(
      this.#registrations().map(([, { userObjectId, calendarId }]) =>
        ({ userObjectId, name: calendarHookDriverName(userObjectId, calendarId) })),
      userObjectId => this.forgetAccount(userObjectId));
    const source = this.#registrations()[0]?.[1];
    if (source !== undefined) {
      if ((kv.get<number>("channelAt") ?? 0) <= Date.now()) await this.#ensureChannel(source);
      if ((kv.get<number>("syncAt") ?? 0) <= Date.now()) await this.#sync(source);
    }
    // After the read, so the rows it just queued are due in this same run.
    await this.#queue.run(Date.now(), (hookKey, change) => this.#deliver(hookKey, change));
    await this.#reschedule();
  }

  /** Read and queue the calendar's changes, then decide when to read next. */
  async #sync(source: Source): Promise<void> {
    const kv = this.ctx.storage.kv;
    const startedSyncAt = kv.get<number>("syncAt");
    let next: number;
    try {
      await this.#read(source);
      kv.delete("syncFailures");
      next = kv.get<SyncState>("sync")?.pageToken !== undefined
        ? Date.now()
        : Date.now() + (this.#pushing() ? SAFETY_SYNC_INTERVAL_MS : POLL_SYNC_INTERVAL_MS);
    } catch (error) {
      logger.warn("failed to read Google Calendar changes", { event: "calendar.hooks.sync.failed", error });
      const failures = (kv.get<number>("syncFailures") ?? 0) + 1;
      kv.put("syncFailures", failures);
      next = Date.now() + backoff(failures, SYNC_RETRY_MS, SYNC_RETRY_MAX_MS);
    }
    // A notification or an enable during the read set its own time, which must stand.
    if (kv.get("syncAt") === startedSyncAt) kv.put("syncAt", next);
  }

  /** Read up to MAX_PAGES_PER_READ pages of the calendar, joining a read already in flight. */
  #read(source: Source): Promise<void> {
    return this.#reading.run("read", () => this.#readPages(source));
  }

  /**
   * Read where the sync state says, queueing each change for the hooks registered when its page
   * arrives. A first listing only learns which events exist. Invariant: every registration has been
   * offered every change read since it was registered.
   */
  async #readPages({ userObjectId, calendarId }: Source): Promise<void> {
    const kv = this.ctx.storage.kv;
    const api = this.#api(userObjectId);
    let state = kv.get<SyncState>("sync") ?? this.#startListing();
    for (let pages = 0; pages < MAX_PAGES_PER_READ; pages++) {
      let page: CalendarChangesPage;
      try {
        page = await api.listEventChanges(calendarId,
          state.token !== undefined ? { syncToken: state.token } : { timeMin: state.timeMin! }, state.pageToken);
      } catch (error) {
        if (!(error instanceof GoogleCalendarApiError && error.status === 410)) throw error;
        // Forgotten meanwhile, by someone else.
        if (kv.get<SyncState>("sync")?.epoch !== state.epoch) return;
        // Changes since the token are not delivered.
        logger.warn("Google Calendar expired its sync token; listing from now", { event: "calendar.hooks.sync.expired" });
        this.#forgetEvents();
        state = this.#startListing();
        continue;
      }
      // Forgotten meanwhile, as when the last hook was disabled: what this read found is no one's.
      if (kv.get<SyncState>("sync")?.epoch !== state.epoch) return;
      const listing = state.token === undefined;
      const registrations = listing ? [] : this.#registrations();
      for (const record of page.records) this.#take(record, registrations, listing);
      if (page.nextPageToken !== undefined) {
        state = { ...state, pageToken: page.nextPageToken };
      } else if (page.nextSyncToken !== undefined) {
        state = { epoch: state.epoch, token: page.nextSyncToken };
      } else {
        throw new Error("Google Calendar ended a listing without a sync token.");
      }
      kv.put<SyncState>("sync", state);
      if (state.pageToken === undefined) return;
    }
  }

  /**
   * Note one event as read, and queue it for each hook that watches its kind of change. A change
   * carrying a write mark the event didn't carry before is one this gatekeeper applied, and is
   * delivered to no one.
   */
  #take(record: CalendarChangeRecord, registrations: [string, Registration][], listing: boolean): void {
    const kv = this.ctx.storage.kv;
    const known = kv.get<string>(knownKey(record.id));
    const ofKnownSeries = record.recurringEventId !== undefined &&
      kv.get(knownKey(record.recurringEventId)) !== undefined;
    if (record.status === "cancelled") {
      if (listing) return;
      kv.delete(knownKey(record.id));
      // One never seen was created and deleted between reads, or before hooks started watching.
      if (known !== undefined || ofKnownSeries) this.#enqueue(registrations, record, "cancelled");
      return;
    }
    const mark = record.writeMark ?? "";
    kv.put(knownKey(record.id), mark);
    if (listing || (mark !== "" && mark !== known)) return;
    // An occurrence that first differs from its series is still an event the calendar had.
    this.#enqueue(registrations, record, known !== undefined || ofKnownSeries ? "updated" : "created");
  }

  /** Queue one change for each hook that watches for it. */
  #enqueue(registrations: [string, Registration][], record: CalendarChangeRecord,
           change: CalendarEventChangeKind): void {
    // The hooks' own filters are applied here alone: the facet delivers whatever it is given.
    for (const [regKey, registration] of registrations) {
      if (registration.changes !== undefined && !registration.changes.includes(change)) continue;
      if (registration.eventId !== undefined && registration.eventId !== record.id &&
          registration.eventId !== record.recurringEventId) continue;
      // Keyed by version, so that every change to an event is delivered and a repeated read of one
      // is not; without an etag, every read of it is.
      const version = record.etag ?? crypto.randomUUID();
      this.#queue.enqueue(regKey.slice("reg:".length), `${record.id}:${version}`,
        { eventId: record.id, change }, Date.now());
    }
  }

  async #deliver(hookKey: string, change: CalendarHookChange): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling or deleting the hook unregisters it, which ends the retries.
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, change);
    } finally {
      disposeStubs(capabilities);
    }
  }

  /**
   * Open the calendar's push channel, or replace it once due, joining one being opened. A
   * deployment without a public https URL has none: Google could not reach it.
   */
  #ensureChannel(source: Source): Promise<void> {
    return this.#opening.run("channel", async () => {
      const kv = this.ctx.storage.kv;
      const address = calendarNotificationUrl(getBaseUrl(this.env), this.ctx.id.toString());
      if (address === null) return;
      if (kv.get("channel") !== undefined && (kv.get<number>("channelAt") ?? 0) > Date.now()) return;
      const api = this.#api(source.userObjectId);
      const next: PendingChannel = { id: crypto.randomUUID(), token: generateNonce() };
      // Stored first: Google may send the channel's first notification before answering.
      kv.put<PendingChannel>("nextChannel", next);
      let opened: { resourceId: string; expiration: number };
      try {
        opened = await api.watchEvents(source.calendarId, { ...next, address, ttlSeconds: CHANNEL_TTL_SECONDS });
      } catch (error) {
        logger.warn("failed to open a Google Calendar push channel; reading on a timer instead", {
          event: "calendar.hooks.channel.failed", error,
        });
        if (kv.get<PendingChannel>("nextChannel")?.id === next.id) {
          kv.delete("nextChannel");
          const failures = (kv.get<number>("channelFailures") ?? 0) + 1;
          kv.put("channelFailures", failures);
          kv.put("channelAt", Date.now() + backoff(failures, CHANNEL_RETRY_MS, CHANNEL_RETRY_MAX_MS));
        }
        return;
      }
      const pending = kv.get<PendingChannel>("nextChannel");
      if (pending?.id !== next.id) {
        // The calendar was forgotten meanwhile, as when its last hook was disabled.
        await api.stopChannel(next.id, opened.resourceId).catch((error: unknown) => {
          logger.info("couldn't stop a Google Calendar channel; it will lapse", { event: "calendar.hooks.channel.stop.failed", error });
        });
        return;
      }
      const replaced = kv.get<Channel>("channel");
      kv.put<Channel>("channel", { ...pending, resourceId: opened.resourceId, expiration: opened.expiration });
      kv.delete("nextChannel");
      kv.delete("channelFailures");
      kv.put("channelAt", opened.expiration - Math.min(CHANNEL_RENEW_LEAD_MS, (opened.expiration - Date.now()) / 2));
      if (replaced !== undefined) {
        await api.stopChannel(replaced.id, replaced.resourceId).catch((error: unknown) => {
          logger.info("couldn't stop a replaced Google Calendar channel; it will lapse", {
            event: "calendar.hooks.channel.stop.failed", error,
          });
        });
      }
    });
  }

  /** Whether notifications are known to arrive on a channel that is still open. */
  #pushing(): boolean {
    const channel = this.ctx.storage.kv.get<Channel>("channel");
    return channel?.confirmed === true && channel.expiration > Date.now();
  }

  /** Begin a first listing from FIRST_LISTING_LOOKBACK_MS ago. */
  #startListing(): SyncState {
    const state: SyncState = {
      epoch: crypto.randomUUID(), timeMin: new Date(Date.now() - FIRST_LISTING_LOOKBACK_MS).toISOString(),
    };
    this.ctx.storage.kv.put<SyncState>("sync", state);
    return state;
  }

  /** Forget the events read, and how far, so the next read lists the calendar again. */
  #forgetEvents(): void {
    const kv = this.ctx.storage.kv;
    // Listed in full first, as deleting would invalidate a live listing.
    const known = [...kv.list({ prefix: "known:" })];
    for (const [key] of known) kv.delete(key);
    kv.delete("sync");
  }

  /** Forget everything about the calendar once no hook watches it, returning its open channel. */
  #forgetCalendar(): Channel | undefined {
    const kv = this.ctx.storage.kv;
    const channel = kv.get<Channel>("channel");
    this.#forgetEvents();
    for (const key of ["syncAt", "syncFailures", "channel", "nextChannel", "channelAt", "channelFailures"]) kv.delete(key);
    return channel;
  }

  /** Remove one hook, finishing its queued changes. */
  #drop(key: string): void {
    const kv = this.ctx.storage.kv;
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
  }

  #api(userObjectId: string): GoogleCalendarApi {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return new GoogleCalendarApi(async opts => (await account.getAccessToken(opts)).token);
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
    if (this.#registrations().length > 0) {
      times.push(kv.get<number>("syncAt") ?? Date.now());
      const channelAt = kv.get<number>("channelAt");
      if (channelAt !== undefined) times.push(channelAt);
    }
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
}

// ── Notifications ───────────────────────────────────────────────────

/** The channel ID and token headers Google sets are at most 64 and 256 characters. */
const MAX_CHANNEL_ID_LENGTH = 64;
const MAX_CHANNEL_TOKEN_LENGTH = 256;

/**
 * Handle `POST {BASE_URL}/calendar/notifications/{driver}`: hand the notification to the driver it
 * names, which acts on it only for its own channel's token, and acknowledge it whether or not it was
 * genuine. A notification carries no event, so a forged one could at most make the driver read the
 * calendar with its own credentials. A 503 asks Google to retry; the driver's timed reads cover a
 * notification it doesn't.
 */
export async function handleCalendarNotification(request: Request, driver: string,
                                                 exports: Cloudflare.Exports): Promise<Response> {
  if (request.method !== "POST" || !/^[0-9a-f]{64}$/.test(driver)) return new Response("Not Found", { status: 404 });
  let id: DurableObjectId;
  try {
    id = exports.CalendarHookDriver.idFromString(driver);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const channelId = request.headers.get("X-Goog-Channel-ID") ?? "";
  const token = request.headers.get("X-Goog-Channel-Token") ?? "";
  const state = request.headers.get("X-Goog-Resource-State") ?? "";
  if (!channelId || channelId.length > MAX_CHANNEL_ID_LENGTH || !token || token.length > MAX_CHANNEL_TOKEN_LENGTH) {
    return new Response(null, { status: 204 });
  }
  try {
    await exports.CalendarHookDriver.get(id).notify(channelId, token, state);
  } catch (error) {
    logger.warn("failed to pass a Google Calendar notification on", { event: "calendar.hooks.notify.failed", error });
    return new Response("Service Unavailable", { status: 503 });
  }
  return new Response(null, { status: 204 });
}
