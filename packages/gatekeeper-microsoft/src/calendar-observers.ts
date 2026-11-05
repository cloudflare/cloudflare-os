// Observers of a workspace that reads a calendar: who may see what a Calendar binding read. The rule
// is Exchange's own: a collaborator sees a read only if Outlook already shows them what it revealed.
// Every read names what it revealed as units, reported as subresource IDs (subresources.ts):
//
// - one calendar's events at `freeBusy`, `limited` or `full` detail, or `private` for a private
//   event shown in detail;
// - everything in every calendar someone has (an "all" binding's reads);
// - someone's free/busy.
//
// A calendar the connected user owns is decided from the owner's side, from its sharing list
// (`calendarPermissions`), which only the owner can read: the collaborator's role there is the one
// Exchange gives them (calendar-acl.ts). For someone else's calendar, and for "all", only the owner
// passes. Availability is probed as the collaborator, with their own `getSchedule`: if Exchange
// gives them that person's free/busy, the read showed them nothing more. So no collaborator needs a
// calendar permission beyond what Outlook already gives them.
//
// Units recorded before reads reported subresources stay in the binding's legacy tracker
// (`calendarObservers`), spelled `calendar:<ownerId>:<calendarId>:<level>`, `calendars:<ownerId>`
// and `availability:<address>`, which admission still checks.

import { trackedCollectionObservers, type ObserverKv, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import { OBSERVED_UNIT_PREFIX } from "./binding";
import type { GraphApi } from "./graph-api";
import { CalendarApi, isCalendarId, type GraphSchedule } from "./calendar-graph";
import { DETAIL_LEVELS, roleSees, type RevealLevel, type SharingRole } from "./calendar-scope";
import { DAY_MS } from "./calendar-time";
import type { MicrosoftVerifierApi, StoredIdentity, VerifiedIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import { AccessProbeError } from "./sharepoint-observers";
import { calendarSubresourceId, isObjectId, isScheduleAddress } from "./subresources";

/** What one read revealed: see the module comment. */
export type CalendarUnit =
  | { kind: "calendar"; ownerId: string; calendarId: string; level: RevealLevel }
  | { kind: "calendars"; ownerId: string }
  | { kind: "availability"; address: string };

const SEPARATOR = ":";
const LEVELS: readonly string[] = [...DETAIL_LEVELS, "private"];

/** A unit as the legacy tracker spelled it, or null for one that isn't a calendar unit (or is malformed). */
export function decodeCalendarUnit(id: string): CalendarUnit | null {
  const [kind, first, second, third, ...rest] = id.split(SEPARATOR);
  if (rest.length > 0 || first === undefined) return null;
  switch (kind) {
    case "calendar":
      return isObjectId(first) && isCalendarId(second) && third !== undefined && LEVELS.includes(third)
        ? { kind, ownerId: first, calendarId: second, level: third as RevealLevel } : null;
    case "calendars": return isObjectId(first) && second === undefined ? { kind, ownerId: first } : null;
    case "availability": return isScheduleAddress(first) && second === undefined ? { kind, address: first } : null;
    default: return null;
  }
}

/** Whether a legacy tracker's unit is one the verifier probes with free/busy. */
export function isAvailabilityUnit(id: string): boolean {
  return id.startsWith("availability:");
}

/**
 * Whether `api`'s user is given each person's free/busy, in order. No address (null) denies, as
 * does a person whose schedule came back with an error (`parseSchedule` makes "no information"
 * one); a failure of the whole request throws: the check could not be made.
 */
export async function probeAvailability(api: GraphApi, addresses: readonly (string | null)[]): Promise<boolean[]> {
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

/**
 * Whether `observer` is shown what a read revealed of one calendar: its owner always is; on the
 * binding owner's own calendar, whoever its sharing list gives a role that sees that much; on
 * anyone else's, nobody, since only a calendar's owner can read its sharing list.
 */
export async function seesCalendar(
  unit: Extract<CalendarUnit, { kind: "calendar" }>, observer: VerifiedIdentity, owner: Pick<StoredIdentity, "objectId">, acl: OwnerAcl,
): Promise<boolean> {
  const ownerId = unit.ownerId.toLowerCase();
  if (ownerId === observer.objectId.toLowerCase()) return true;
  return ownerId === owner.objectId.toLowerCase() && roleSees(await acl.roleOf(unit.calendarId, observer), unit.level);
}

/** The most distinct calendar units one binding tracks while staying shareable. */
const MAX_TRACKED_CALENDAR_UNITS = 2000;

/**
 * The binding's legacy observer strategy, for the units reads recorded before they reported
 * subresources: a collaborator needs a working connection in the owner's own organization, and
 * then must be shown, by Exchange, everything those reads revealed.
 */
export function calendarObservers(kv: ObserverKv, owner: () => Promise<StoredIdentity>, acl: OwnerAcl): ObserverStrategy {
  return trackedCollectionObservers<MicrosoftVerifierApi>({
    kv,
    collectionPrefix: OBSERVED_UNIT_PREFIX,
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

/** The verdict for each legacy unit: see the module comment. Exported for tests. */
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
        verdicts[index] = await seesCalendar(unit, observer, me, acl);
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

/** Subresource IDs of what a binding's reads reveal of `ownerId`'s calendars, and of anyone's free/busy. */
export function calendarUnits(ownerId: string) {
  return {
    calendar: (calendarId: string, level: RevealLevel) => calendarSubresourceId({ kind: "calendar", ownerId, calendarId, level }),
    everything: () => calendarSubresourceId({ kind: "calendars", ownerId }),
    availability: (address: string) => calendarSubresourceId({ kind: "availability", address }),
  };
}
