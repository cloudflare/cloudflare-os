// The capability the Calendar configurator frame holds: it lists the connected user's calendars and
// the ones colleagues have shared with them, and turns a draft into the resource URL the binding is
// minted from. Nothing here grants anything. It reads as the user, and the binding re-resolves the
// URL itself (`resolveCalendarUrl`), so a forged draft can at most bind something the user could
// open anyway.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  CalendarColleague, CalendarConfiguratorRpc, CalendarConfiguratorStatus, CalendarDraft, CalendarLocated, CalendarRow,
} from "./configurator/calendar-configurator-types";
import { CalendarApi, type GraphCalendar } from "./calendar-graph";
import { resolveCalendarUrl } from "./calendar-resolve";
import {
  CALENDAR_ACCESS_LEVELS, CALENDAR_ORIGIN, CalendarUrlError, allows, calendarUrl, lowerAccess,
  type CalendarAccessLevel, type CalendarOwnerRef, type CalendarScope,
} from "./calendar-scope";
import { ConnectionCache, normalizeAddress, type Cached, type ConfiguratorConnection } from "./configurator-connection";
import { findUser } from "./directory";
import { GraphApiError } from "./graph-api";
import { CALENDAR_RESOURCE, grantedCalendarAccess, grantedResourcePatterns, grantsSharedCalendars } from "./microsoft-env";

const ME: CalendarOwnerRef = { kind: "me" };

const NO_CALENDAR = "This Microsoft 365 account has no Outlook calendar, so there's nothing to choose from. " +
  "Ask your Microsoft 365 administrator for an Exchange Online license.";
const NO_SHARED = "This connection can't open calendars shared with you. Ask your Microsoft 365 administrator to " +
  "allow it (Calendars.Read.Shared), then reconnect Microsoft 365.";

/** What each access level is called in the frame, for messages that name one. */
const ACCESS_TITLES: Record<CalendarAccessLevel, string> = {
  read: "Read only", edit: "Add and change events", schedule: "Also invite and respond",
};

/** The access levels a grant allows under the deployment's ceiling, for the user's own and for colleagues' calendars. */
export function calendarAccessLevels(ceiling: CalendarAccessLevel, grantedScopes: readonly string[]): {
  own: CalendarAccessLevel[]; shared: CalendarAccessLevel[]; limitedByDeployment: boolean;
} {
  const granted = grantedCalendarAccess(grantedScopes);
  if (granted === null) return { own: [], shared: [], limitedByDeployment: false };
  const top = lowerAccess(ceiling, granted);
  const own = CALENDAR_ACCESS_LEVELS.filter(level => allows(top, level));
  return {
    own,
    shared: own.filter(level => grantsSharedCalendars(grantedScopes, level)),
    limitedByDeployment: top !== "schedule" && top === ceiling,
  };
}

/** A draft as a binding URL, for `resolveCalendarUrl` to check and resolve. */
export function draftUrl(draft: CalendarDraft): string {
  if (draft.kind === "availability") return `${CALENDAR_ORIGIN}/calendar/availability`;
  if (draft.kind === "all") return `${CALENDAR_ORIGIN}/calendar/?access=${draft.access}`;
  const owner = draft.owner === undefined ? "" : `${encodeURIComponent(normalizeAddress(draft.owner))}/`;
  const calendar = draft.calendarId === "default" ? "default" : `id/${encodeURIComponent(draft.calendarId)}`;
  const query = new URLSearchParams({ details: draft.details });
  if (draft.privateEvents === "show") query.set("private", "show");
  query.set("access", draft.access);
  return `${CALENDAR_ORIGIN}/calendar/${owner}${calendar}?${query}`;
}

function row(calendar: GraphCalendar): CalendarRow {
  return { id: calendar.id, name: calendar.name, isDefault: calendar.isDefault, canEdit: calendar.canEdit, ...(calendar.color ? { color: calendar.color } : {}) };
}

/** The main calendar first, then by name. */
const calendarOrder = (a: CalendarRow, b: CalendarRow) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name);

type Colleague = { ref: Extract<CalendarOwnerRef, { kind: "shared" }>; name: string; calendars: CalendarRow[]; notice?: string };

/** The Calendar configurator frame's capability. */
@validateRpc()
export class CalendarConfiguratorUI extends RpcTarget implements CalendarConfiguratorRpc {
  readonly #connection: ConfiguratorConnection;
  readonly #ceiling: CalendarAccessLevel;
  readonly #cache: ConnectionCache;
  readonly #colleagues = new Map<string, Cached<Colleague>>();

  /** @param ceiling The deployment's Calendar ceiling, `calendarAccess(env)`. */
  constructor(connection: ConfiguratorConnection, ceiling: CalendarAccessLevel, now: () => number = Date.now) {
    super();
    this.#connection = connection;
    this.#ceiling = ceiling;
    this.#cache = new ConnectionCache(connection, now);
  }

  async getStatus(): Promise<CalendarConfiguratorStatus> {
    // Asked again after a consent pop-up, so never answered from the cache.
    this.#cache.forget();
    const { identity, scopes, me } = await this.#cache.connected();
    if (!grantedResourcePatterns(scopes).includes(CALENDAR_RESOURCE.urlPattern)) return { state: "needsAccess" };
    const main = await this.#connection.read(api => new CalendarApi(api, ME).calendar("default"));
    if (main === null) return { state: "unavailable", message: NO_CALENDAR };
    const levels = calendarAccessLevels(this.#ceiling, scopes);
    return {
      state: "ready", me: { address: me, name: identity.name || me },
      levels: levels.own, sharedLevels: levels.shared, limitedByDeployment: levels.limitedByDeployment,
    };
  }

  async listCalendars(): Promise<CalendarRow[]> {
    const calendars = await this.#connection.read(api => new CalendarApi(api, ME).calendars());
    // A calendar someone else shared can sit in the user's own list; it is theirs, not the user's,
    // and its sharing list is theirs to read. The main calendar's owner is the user as Exchange
    // names them, whatever address they signed in with.
    const owner = calendars.find(calendar => calendar.isDefault)?.owner.address.toLowerCase();
    return calendars.filter(calendar => owner === undefined || calendar.owner.address === "" || calendar.owner.address.toLowerCase() === owner)
      .map(row).toSorted(calendarOrder);
  }

  async openColleague(address: string): Promise<CalendarColleague> {
    const wanted = normalizeAddress(address);
    const { scopes, me } = await this.#cache.connected();
    if (calendarAccessLevels(this.#ceiling, scopes).shared.length === 0) throw new Error(NO_SHARED);
    if (wanted === me) throw new Error("That's you. Choose Your calendars instead.");
    // Asked for on purpose, so a calendar shared a moment ago is found.
    this.#colleagues.delete(wanted);
    const colleague = await this.#colleague(wanted);
    return { address: colleague.ref.address, name: colleague.name, calendars: colleague.calendars, ...(colleague.notice ? { notice: colleague.notice } : {}) };
  }

  async resourceUrlFor(draft: CalendarDraft): Promise<string> {
    if (draft.kind !== "availability") {
      const { scopes } = await this.#cache.connected();
      const levels = calendarAccessLevels(this.#ceiling, scopes);
      const allowed = draft.kind === "calendar" && draft.owner !== undefined ? levels.shared : levels.own;
      if (!allowed.includes(draft.access)) {
        throw new Error(allowed.length === 0
          ? draft.kind === "calendar" && draft.owner !== undefined ? NO_SHARED : "This connection can't open calendars. Reconnect Microsoft 365 and allow calendar access."
          : `"${ACCESS_TITLES[draft.access]}" isn't allowed here. Choose up to "${ACCESS_TITLES[allowed.at(-1)!]}".`);
      }
    }
    return calendarUrl(await this.#resolve(draft));
  }

  async locate(resourceUrl: string): Promise<CalendarLocated | null> {
    const { scopes, me } = await this.#cache.connected();
    const levels = calendarAccessLevels(this.#ceiling, scopes);
    let scope: CalendarScope;
    try {
      scope = await this.#connection.read(api => resolveCalendarUrl(api, resourceUrl, "schedule", me));
    } catch (error) {
      if (error instanceof CalendarUrlError) return null;
      throw error;
    }
    if (scope.kind === "availability") return { kind: "availability" };
    const allowed = scope.kind === "calendar" && scope.owner.kind === "shared" ? levels.shared : levels.own;
    const access = allowed.includes(scope.access) ? scope.access : allowed.filter(level => allows(scope.access, level)).at(-1) ?? "read";
    if (scope.kind === "all") return { kind: "all", access };
    const owner = scope.owner;
    const calendar = await this.#connection.read(api => new CalendarApi(api, owner).calendar(scope.calendar.id));
    if (calendar === null) return null;
    return {
      kind: "calendar",
      ...(owner.kind === "shared" ? { owner: { address: owner.address, name: await this.#ownerName(owner) } } : {}),
      calendar: row(calendar), details: scope.details, privateEvents: scope.privateEvents, access,
    };
  }


  #colleague(address: string): Promise<Colleague> {
    return this.#cache.cached(this.#colleagues, address, async () => {
      const { me } = await this.#cache.connected();
      return await this.#connection.read(async api => {
        const user = await findUser(api, address);
        if (user === null) throw new Error(`There's nobody with the address ${address} in your organization. Check the address.`);
        // As `resolveCalendarUrl` names the owner, so the binding is the one previewed.
        const ref = { kind: "shared" as const, id: user.id.toLowerCase(), address: user.mail.toLowerCase() };
        if (ref.address === me) throw new Error("That's you. Choose Your calendars instead.");
        const name = user.displayName ?? ref.address;
        const calendars = new CalendarApi(api, ref);
        try {
          return { ref, name, calendars: (await calendars.calendars()).map(row).toSorted(calendarOrder) };
        } catch (error) {
          // Exchange lists someone's calendars only to a delegate; anyone else may still open one they were given.
          if (!(error instanceof GraphApiError) || ![400, 403, 404].includes(error.status)) throw error;
        }
        const main = await calendars.calendar("default");
        if (main === null) {
          throw new Error(`${name} hasn't shared a calendar with you, or not one that can be opened here. Ask them to share it with you in Outlook.`);
        }
        return {
          ref, name, calendars: [row(main)],
          notice: `Only ${name}'s main calendar can be opened from here. Exchange opens their other calendars only to their delegates.`,
        };
      });
    });
  }

  async #ownerName(owner: Extract<CalendarOwnerRef, { kind: "shared" }>): Promise<string> {
    const known = this.#colleagues.get(owner.address);
    if (known !== undefined) return (await known.value).name;
    const user = await this.#connection.read(api => api.find<{ displayName?: unknown }>(`/users/${encodeURIComponent(owner.id)}`, { query: { $select: "displayName" } }));
    return typeof user?.displayName === "string" && user.displayName !== "" ? user.displayName : owner.address;
  }

  /** A draft as the scope it would bind, checked and resolved exactly as the binding will be; access is checked by the caller. */
  async #resolve(draft: CalendarDraft): Promise<CalendarScope> {
    const { me } = await this.#cache.connected();
    return await this.#connection.read(api => resolveCalendarUrl(api, draftUrl(draft), "schedule", me));
  }
}
