// Turns a Calendar binding URL into what the binding covers, as the user, at binding time: an
// owner's address becomes their object ID, `default` and calendar IDs become the calendar's
// immutable ID and MAPI entry ID (what its events name as their parent), and the access level is
// capped by the ceiling, the detail level, and whether the user can edit the calendar. Renaming a
// calendar later can neither break nor widen the binding; deleting it ends it.

import type { GraphApi } from "./graph-api";
import { CalendarApi } from "./calendar-graph";
import { findUser } from "./directory";
import {
  CalendarUrlError, accessCeiling, lowerAccess, parseCalendarUrl, type CalendarAccessLevel, type CalendarOwnerRef, type CalendarScope,
} from "./calendar-scope";

/**
 * Resolves a binding URL as the signed-in user.
 * @param ceiling The most the binding may do: the deployment's ceiling, narrowed by the grant.
 * @param me The signed-in user's own address, so a link naming their own calendar isn't taken as shared.
 * @throws CalendarUrlError, saying what is wrong, for a URL that names nothing the user can open.
 */
export async function resolveCalendarUrl(api: GraphApi, url: string, ceiling: CalendarAccessLevel, me: string): Promise<CalendarScope> {
  const target = parseCalendarUrl(url);
  if (target.kind === "availability") return { kind: "availability", access: "read" };
  if (target.kind === "all") return { kind: "all", access: lowerAccess(target.access ?? ceiling, ceiling) };
  const owner = await resolveOwner(api, target.owner, me);
  const calendars = new CalendarApi(api, owner);
  // Null for a calendar that isn't the owner's, or one they haven't shared (400, 403 or 404).
  const calendar = await calendars.calendar(target.calendar === "default" ? "default" : target.calendar.id);
  const whose = owner.kind === "shared" ? `${owner.address}'s` : "your";
  if (calendar === null) {
    throw new CalendarUrlError(owner.kind === "shared"
      ? `That calendar isn't one of ${owner.address}'s that you've been given access to. Ask them to share it with you.`
      : "That calendar isn't one of yours anymore, or never was.");
  }
  if (owner.kind === "me" && !calendar.isDefault) {
    // Someone else's calendar added to the user's list lists as the user's, but its sharing list,
    // which decides who may observe the binding, is its owner's, so it must be connected as theirs.
    const main = await calendars.calendar("default");
    if (main !== null && calendar.owner.address.toLowerCase() !== main.owner.address.toLowerCase()) {
      throw new CalendarUrlError(`"${calendar.name}" is ${calendar.owner.address}'s calendar, added to your list. Connect it from their calendars instead.`);
    }
  }
  const scope: CalendarScope = {
    kind: "calendar", owner, calendar: { id: calendar.id, entryId: calendar.entryId, name: calendar.name },
    details: target.details, privateEvents: target.privateEvents, access: "read",
  };
  let access = lowerAccess(lowerAccess(target.access ?? ceiling, ceiling), accessCeiling(scope));
  if (!calendar.canEdit) {
    if (target.access !== undefined && target.access !== "read") throw new CalendarUrlError(`You can't change events in ${whose} calendar "${calendar.name}", so it can only be connected to read.`);
    access = "read";
  }
  return { ...scope, access };
}

/** The owner a URL names: the user, or someone in their organization, by object ID. */
async function resolveOwner(api: GraphApi, address: string | undefined, me: string): Promise<CalendarOwnerRef> {
  if (address === undefined || address === me.toLowerCase()) return { kind: "me" };
  const user = await findUser(api, address);
  if (user === null) throw new CalendarUrlError(`There's nobody with the address ${address} in your organization.`);
  // Another of the user's own addresses names the user, whose calendars are checked as their own.
  const self = await api.get<{ id?: unknown }>("/me", { query: { $select: "id" } });
  if (typeof self?.id === "string" && self.id.toLowerCase() === user.id.toLowerCase()) return { kind: "me" };
  return { kind: "shared", id: user.id.toLowerCase(), address: user.mail.toLowerCase() };
}
