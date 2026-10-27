// Observers of a workspace that reads a calendar: who may see what a Calendar binding read. The rule
// is Exchange's own: a collaborator sees a read only if Outlook already shows them what it revealed.
// Every read names what it revealed as units:
//
// - `calendar:<ownerId>:<calendarId>:<level>`: events of one calendar at `freeBusy`, `limited` or
//   `full` detail, or `private` for a private event shown in detail.
// - `calendars:<ownerId>`: everything in every calendar someone has (an "all" binding's reads).
// - `availability:<address>`: someone's free/busy.
//
// A calendar the connected user owns is decided from the owner's side, from its sharing list
// (`calendarPermissions`), which only the owner can read: the collaborator's role there is the one
// Exchange gives them (calendar-acl.ts). For someone else's calendar, and for "all", only the owner
// passes. Availability is probed as the collaborator, with their own `getSchedule`: if Exchange
// gives them that person's free/busy, the read showed them nothing more. So no collaborator needs a
// calendar permission beyond what Outlook already gives them.

import { trackedCollectionObservers, type ObserverKv, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { GraphApi } from "./graph-api";
import { CalendarApi, isCalendarId, type GraphSchedule } from "./calendar-graph";
import { DETAIL_LEVELS, roleSees, type RevealLevel, type SharingRole } from "./calendar-scope";
import { DAY_MS } from "./calendar-time";
import type { MicrosoftVerifierApi, StoredIdentity, VerifiedIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import { AccessProbeError } from "./sharepoint-observers";

/** What one read revealed: see the module comment. */
export type CalendarUnit =
  | { kind: "calendar"; ownerId: string; calendarId: string; level: RevealLevel }
  | { kind: "calendars"; ownerId: string }
  | { kind: "availability"; address: string };

const SEPARATOR = ":";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^[^\s@:<>()",;/]+@[^\s@:<>()",;/]+$/;
const LEVELS: readonly string[] = [...DETAIL_LEVELS, "private"];

/** A unit as its tracked collection ID. */
export function encodeCalendarUnit(unit: CalendarUnit): string {
  switch (unit.kind) {
    case "calendar": return ["calendar", unit.ownerId.toLowerCase(), unit.calendarId, unit.level].join(SEPARATOR);
    case "calendars": return ["calendars", unit.ownerId.toLowerCase()].join(SEPARATOR);
    case "availability": return ["availability", unit.address.toLowerCase()].join(SEPARATOR);
  }
}

/** A collection ID back as its unit, or null for one that isn't a calendar unit (or is malformed). */
export function decodeCalendarUnit(id: string): CalendarUnit | null {
  const [kind, first, second, third, ...rest] = id.split(SEPARATOR);
  if (rest.length > 0 || first === undefined) return null;
  switch (kind) {
    case "calendar":
      return GUID.test(first) && isCalendarId(second) && third !== undefined && LEVELS.includes(third)
        ? { kind, ownerId: first, calendarId: second, level: third as RevealLevel } : null;
    case "calendars": return GUID.test(first) && second === undefined ? { kind, ownerId: first } : null;
    case "availability": return ADDRESS.test(first) && second === undefined ? { kind, address: first } : null;
    default: return null;
  }
}

/** Whether a collection ID is one the verifier probes with free/busy. */
export function isAvailabilityUnit(id: string): boolean {
  return id.startsWith("availability:");
}

/**
 * Whether `api`'s user is given each person's free/busy, in order. A unit that isn't availability
 * denies, as does a person whose schedule came back with an error (`parseSchedule` makes "no
 * information" one); a failure of the whole request throws, which the tracker counts against the
 * observer.
 */
export async function probeAvailability(api: GraphApi, ids: readonly string[]): Promise<boolean[]> {
  const addresses = ids.map(id => {
    const unit = decodeCalendarUnit(id);
    return unit?.kind === "availability" ? unit.address : null;
  });
  const wanted = [...new Set(addresses.filter((address): address is string => address !== null))];
  let schedules: GraphSchedule[];
  try {
    const now = Date.now();
    schedules = await new CalendarApi(api, { kind: "me" }).schedules(wanted, now, now + DAY_MS);
  } catch (error) {
    throw new AccessProbeError(error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 502);
  }
  const visible = new Set(schedules.filter(schedule => schedule.error === undefined).map(schedule => schedule.address));
  return addresses.map(address => address !== null && visible.has(address));
}

/** What the binding owner's side answers about their own calendars. */
export type OwnerAcl = {
  /** The role Exchange gives `observer` on one of the owner's own calendars. */
  roleOf(calendarId: string, observer: VerifiedIdentity): Promise<SharingRole>;
};

/** The most distinct calendar units one binding tracks while staying shareable. */
const MAX_TRACKED_CALENDAR_UNITS = 2000;

/**
 * The binding's observer strategy: a collaborator needs a working connection in the owner's own
 * organization, and then must be shown, by Exchange, everything each read revealed.
 */
export function calendarObservers(kv: ObserverKv, owner: () => Promise<StoredIdentity>, acl: OwnerAcl): ObserverStrategy {
  return trackedCollectionObservers<MicrosoftVerifierApi>({
    kv,
    collectionPrefix: "observedUnit:",
    maxTrackedCollections: MAX_TRACKED_CALENDAR_UNITS,
    verifyBaseline: async verifier => {
      const [observer, me] = await Promise.all([verifier.getIdentity(), owner()]);
      if (observer === null) {
        throw new Error("This collaborator has no working Microsoft 365 connection. They need to connect " +
          "(or reconnect) Microsoft 365 before they can observe this workspace.");
      }
      if (observer.tenantId !== me.tenantId) {
        throw new Error("This collaborator's Microsoft 365 account is in a different organization than the " +
          "calendar this workspace read, so they can't observe it.");
      }
    },
    hasCollectionAccess: async (verifier, ids) => {
      const [observer, me] = await Promise.all([verifier.getIdentity(), owner()]);
      if (observer === null || observer.tenantId !== me.tenantId) return ids.map(() => false);
      return await decide(ids, observer, me, acl, availability => verifier.canAccess(availability));
    },
    denyMessage: () => "This workspace has read calendar details this collaborator can't see in Outlook, so they can't observe it.",
    vendorId: VENDOR_ID,
  });
}

/** The verdict for each unit: see the module comment. Exported for tests. */
export async function decide(
  ids: readonly string[], observer: VerifiedIdentity, me: Pick<StoredIdentity, "objectId">, acl: OwnerAcl,
  probe: (ids: string[]) => Promise<boolean[]>,
): Promise<boolean[]> {
  const verdicts = Array.from({ length: ids.length }, () => false);
  const probed: number[] = [];
  const self = observer.objectId.toLowerCase();
  const ownAddress = observer.email?.toLowerCase();
  for (const [index, id] of ids.entries()) {
    const unit = decodeCalendarUnit(id);
    if (unit === null) continue;
    switch (unit.kind) {
      case "calendars":
        verdicts[index] = unit.ownerId === self;
        break;
      case "calendar":
        if (unit.ownerId === self) verdicts[index] = true;
        // Only the owner can read a calendar's sharing list, so only their own calendars are decided here.
        else if (unit.ownerId === me.objectId.toLowerCase()) verdicts[index] = roleSees(await acl.roleOf(unit.calendarId, observer), unit.level);
        break;
      case "availability":
        if (ownAddress !== undefined && unit.address === ownAddress) verdicts[index] = true;
        else probed.push(index);
        break;
    }
  }
  if (probed.length > 0) {
    const answers = await probe(probed.map(index => ids[index]!));
    probed.forEach((index, at) => { verdicts[index] = answers[at] === true; });
  }
  return verdicts;
}

/** Unit constructors for a binding. */
export function calendarUnits(ownerId: string) {
  return {
    calendar: (calendarId: string, level: RevealLevel) => encodeCalendarUnit({ kind: "calendar", ownerId, calendarId, level }),
    everything: () => encodeCalendarUnit({ kind: "calendars", ownerId }),
    availability: (address: string) => encodeCalendarUnit({ kind: "availability", address }),
  };
}
