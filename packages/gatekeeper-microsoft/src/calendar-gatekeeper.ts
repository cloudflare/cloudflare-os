// The per-binding Calendar gatekeeper Durable Object: one instance per binding of a Microsoft 365
// connection to calendars, whatever it covers (every calendar, availability only, or one calendar
// at a level of detail, the user's or one shared with them). It owns the binding's action journal,
// the temporary IDs of events not yet created, a read cache partitioned by connection, and its
// observer records. It pins the Entra user the connection belongs to, and mints the capabilities
// gadgets hold (calendar-session.ts).

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import TYPES_CODE from "./calendar-types.txt";
import { DESCRIPTION_TTL_MS, RETAINED_ACTION_TTL_MS, housekeep, isProvisional, PinnedUser, provisionalId, revertRefused } from "./binding";
import { GraphApi } from "./graph-api";
import { findUserByMail, organizationDomains } from "./directory";
import { accountSource } from "./microsoft-credentials";
import { effectiveCalendarAccess, grantsSharedCalendars, type CalendarGatekeeperProps, type Env } from "./microsoft-env";
import {
  actions, dependedRefs, providedRefs, requiredAccess, revert, type CalendarAction, type CalendarActionHost, type EventVersion, type RevertOutcome,
} from "./calendar-actions";
import { ownerAcl } from "./calendar-acl";
import { CalendarApi } from "./calendar-graph";
import { calendarObservers } from "./calendar-observers";
import { accessCeiling, allows, calendarUrl, describeScope, lowerAccess, type CalendarAccessLevel } from "./calendar-scope";
import { CalendarContext, CalendarReaderImpl, CalendarSessionImpl, type CalendarSessionHost } from "./calendar-session";
import type { CalendarReader, CalendarSession } from "./calendar-types";


/**
 * How long a calendar's sharing list is reused when deciding observers. A share removed in Outlook
 * stops counting for observers within this long.
 */
const ACL_TTL_MS = 2 * 60 * 1000;
const DIRECTORY_TTL_MS = 60 * 60 * 1000;
const ORGANIZATION_TTL_MS = 24 * 60 * 60 * 1000;

// Storage keys of this class's own. binding.ts owns `pinnedUser` and `housekeptAt`; the kit modules
// own theirs: `calendar:` and the journal's tiers, `refs:`, `cache:@calendar:`,
// `observer:`/`observedUnit:`.
const DESCRIPTION_KEY = "description";
/** The change key an event this binding created had after it last wrote it: what a later action proposed against its `~N` is fenced on. */
const EVENT_VERSION_PREFIX = "eventVersion:";

/** Which action tags each access level can submit, for the auto-approval catalog. */
const LEVEL_TAGS: Record<CalendarAccessLevel, readonly string[]> = {
  read: [],
  edit: ["calendar.events"],
  schedule: ["calendar.events"],
};

type Session = CalendarReader | CalendarSession;

/** One Calendar binding: see the module comment. */
@validateRpc()
export class CalendarGatekeeper extends DurableObject<Env, CalendarGatekeeperProps> implements Gatekeeper<Session> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #journal = new ActionJournal<CalendarAction>(this.ctx.storage.kv, { namespace: "calendar" });
  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, { namespace: "refs:", isProvisional });
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "calendar" });
  readonly #observers = calendarObservers(this.ctx.storage.kv, () => this.#user.get(), ownerAcl({
    // Read as the binding's owner: only an owner can read a calendar's sharing list.
    permissions: calendarId => this.#cache.cached(`acl:${calendarId}`, ACL_TTL_MS,
      () => this.#graph(api => new CalendarApi(api, { kind: "me" }).permissions(calendarId), true)),
    // Not found, or not allowed to look, counts as a group, which can only lower the default.
    isPerson: address => this.#cache.cached(`person:${address}`, DIRECTORY_TTL_MS,
      () => this.#graph(async api => await findUserByMail(api, address) !== null, true)),
    orgDomains: () => this.#cache.cached("orgDomains", ORGANIZATION_TTL_MS, () => this.#graph(organizationDomains, true)),
  }));

  readonly #user = new PinnedUser(this.ctx.storage.kv, () => this.#account().getIdentity(), "the calendar");

  readonly #actionHost: CalendarActionHost = {
    refs: this.#refs,
    graph: (op, options) => this.#graph(op, options?.replayable === true),
    invalidate: async () => this.#cache.invalidateAll(),
    noteEventVersion: (id, changeKey) => this.ctx.storage.kv.put<EventVersion>(EVENT_VERSION_PREFIX + id, { changeKey, at: Date.now() }),
    eventVersion: id => this.ctx.storage.kv.get<EventVersion>(EVENT_VERSION_PREFIX + id),
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

  #sessionHost(access: CalendarAccessLevel): CalendarSessionHost {
    return {
      scope: this.ctx.props.scope,
      access,
      owner: () => this.#user.get(),
      read: op => this.#graph(op, true),
      cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
      pending: () => this.#journal.listPending(),
      resolve: id => this.#refs.resolve(id),
      allocate: kind => this.#refs.allocate(provisionalId, { kind }),
      submit: async (queue, kind, payload) => {
        return await this.#actions.submit(queue, kind, payload, { fence: await this.#user.fence() });
      },
    };
  }

  async describe(): Promise<ResourceDescription> {
    const scope = this.ctx.props.scope;
    const access = await this.#access();
    const tsType = access === "read" ? "CalendarReader" : "CalendarSession";
    const kv = this.ctx.storage.kv;
    const stored = kv.get<{ value: ResourceDescription; at: number }>(DESCRIPTION_KEY);
    if (stored && Date.now() - stored.at < DESCRIPTION_TTL_MS) return { ...stored.value, tsType };
    const me = await this.#user.get();
    const description: ResourceDescription = {
      url: calendarUrl(scope),
      title: scope.kind === "calendar" ? scope.calendar.name : scope.kind === "availability" ? "Availability" : "Calendar",
      snippet: describeScope(scope, me.name),
      suggestedBindingName: scope.kind === "calendar" ? "TEAM_CALENDAR" : scope.kind === "availability" ? "AVAILABILITY" : "CALENDAR",
      tsType,
    };
    kv.put(DESCRIPTION_KEY, { value: description, at: Date.now() });
    return description;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const tags = LEVEL_TAGS[await this.#access()];
    return this.#actions.autoApprovableKinds().filter(kind => tags.includes(kind.tag));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session> {
    const access = await this.#access();
    const ctx = new CalendarContext(this.#sessionHost(access), approvalQueue.dup(), this.#observers);
    return access === "read" ? new CalendarReaderImpl(ctx) : new CalendarSessionImpl(ctx);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await housekeep(this.ctx.storage.kv, this.#journal, this.#actions, "calendar", now => {
      // An event's version matters for as long as an action proposed against its `~N` could apply.
      const kv = this.ctx.storage.kv;
      for (const [key, version] of kv.list<EventVersion>({ prefix: EVENT_VERSION_PREFIX })) {
        if (version.at < now - RETAINED_ACTION_TTL_MS) kv.delete(key);
      }
    });
    // Access is checked when a session is minted; a change approved after the binding's owner, the
    // deployment or the grant lowered it waits, retryable, rather than landing.
    const record = this.#journal.get(actionId);
    if (record !== undefined && !allows(await this.#access(), requiredAccess(record.action))) {
      throw new Error("This connection no longer allows that change to the calendar.");
    }
    await this.#actions.apply(actionId, await this.#user.fence());
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Rejecting the creation of an event later actions build on retires those too, and the gadget
    // may hold its temporary ID: restart it rather than leave the ID dangling.
    const record = this.#journal.get(actionId);
    const provided = record ? providedRefs(record.action) : [];
    const builtOn = provided.length > 0 && this.#journal.listUndecided().some(({ id, action }) =>
      id !== actionId && dependedRefs(action).some(ref => provided.includes(ref)));
    await this.#actions.reject(actionId);
    return builtOn ? { restart: true } : undefined;
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return await this.#actions.runExclusive(async (): Promise<RevertOutcome> => {
      const record = this.#journal.get(actionId);
      if (record?.state !== "applied") return { message: "This action is too old to undo automatically.", canRetry: false };
      // An undo writes at the level its action did: one asked for after the ceiling dropped waits, as applying would.
      if (!allows(await this.#access(), requiredAccess(record.action))) {
        return { message: "This connection no longer allows that change to the calendar, so it wasn't undone.", canRetry: true };
      }
      let outcome: RevertOutcome;
      try {
        outcome = await revert(record.action, this.#actionHost);
      } catch (error) {
        return revertRefused(error, "Calendar");
      }
      // A failure says whether to retry; a message alone reports a revert that happened.
      if (outcome && outcome.canRetry !== undefined) return outcome;
      this.#journal.retire(actionId);
      await this.#cache.invalidateAll();
      await this.#actions.resolved("reverted");
      return outcome;
    });
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers.addObserver(id, user);
  }

  async removeObserver(id: string): Promise<void> {
    await this.#observers.removeObserver(id);
  }

  // -- the connection ----------------------------------------------------------------------

  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  /** What the binding, the deployment and the grant together allow: never more than any of them. */
  async #access(): Promise<CalendarAccessLevel> {
    const scope = this.ctx.props.scope;
    const scopes = await this.#account().getGrantedScopes();
    const access = effectiveCalendarAccess(this.env, scopes, lowerAccess(scope.access, accessCeiling(scope)));
    if (access === null) throw new Error("This Microsoft 365 connection no longer grants calendar access. Reconnect the Microsoft 365 account.");
    if (scope.kind === "calendar" && scope.owner.kind === "shared" && !grantsSharedCalendars(scopes, access)) {
      throw new Error("This Microsoft 365 connection no longer grants access to calendars shared with you. Reconnect the Microsoft 365 account.");
    }
    return access;
  }


  async #graph<T>(op: (api: GraphApi) => Promise<T>, replayable: boolean): Promise<T> {
    await this.#user.get();
    return await this.#creds.run(creds => op(new GraphApi(creds.accessToken)), { replayable });
  }
}
