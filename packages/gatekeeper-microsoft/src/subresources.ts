// The subresource IDs Microsoft 365 reads report, which the Workshop records and checks every
// collaborator against through the binding's verifyObserverAccess() (observer-access.ts). Each
// names something a read revealed, as Graph names it, and is checked the way its access unit was
// before reads reported IDs (sharepoint-, outlook- and calendar-observers.ts):
//
// - `tenant/<tenantId>`: the owner's organization, for a read that revealed nothing narrower.
// - SharePoint and OneDrive: `sharepoint/site/<siteId>`, `sharepoint/drive/<driveId>`,
//   `sharepoint/drive/<driveId>/item/<itemId>`, `sharepoint/site/<siteId>/list/<listId>`,
//   `sharepoint/site/<siteId>/list/<listId>/item/<itemId>` and `sharepoint/site/<siteId>/page/<pageId>`;
//   a file's bytes as `sharepoint/drive/<driveId>/content/<itemId>` and its version history as
//   `sharepoint/drive/<driveId>/versions/<itemId>`; and the draft the owner saw of a file, list
//   item or page as its ID followed by `/version/<version>`.
// - Outlook: `outlook/user/<userId>` for a mailbox, by its owner's object ID, and
//   `outlook/user/<userId>/folder/<folderId>` or `outlook/user/<userId>/message/<messageId>` for
//   one folder or message in it.
// - Calendar: `calendar/user/<userId>` for everything in someone's calendars; one calendar's events
//   as `calendar/user/<userId>/<projection>/<calendarId>`, where the projection, what the read
//   showed of them, is `freeBusy`, `limitedCalendar`, `calendar` (all details) or
//   `privateCalendar` (private events in detail); and someone's free/busy as
//   `calendar/availability/<address>`.
//
// No other ID names the tenant: a binding is pinned to one, which its verifyObserverAccess()
// requires of every collaborator alongside whatever they are asked about.

import { formatSubresourceId, parseSubresourceId, type SubresourceFragment } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { CalendarUnit } from "./calendar-observers";
import type { RevealLevel } from "./calendar-scope";
import { isMailId } from "./outlook-graph";
import type { MailUnit } from "./outlook-observers";
import type { AccessUnit } from "./sharepoint-observers";

/** The resource a subresource ID names. */
export type MicrosoftSubresource =
  | { kind: "tenant"; tenantId: string }
  | { kind: "sharepoint"; unit: AccessUnit }
  | { kind: "outlook"; unit: MailUnit }
  | { kind: "calendar"; unit: CalendarUnit };

/** The resources a binding's reads name besides the tenant. */
export type BindingResource = Exclude<MicrosoftSubresource["kind"], "tenant">;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A SharePoint ID as a Graph path segment takes it: none of `/`, `:`, `?` and `#`, which would change what the path names. */
const SEGMENT = /^[^/:?#]+$/;
const VERSION = /^[0-9]{1,6}\.[0-9]{1,6}$/;
const ADDRESS = /^[^\s@:<>()",;/]+@[^\s@:<>()",;/]+$/;

/** Whether `id` is an Entra object or tenant ID. */
export function isObjectId(id: string | undefined): id is string {
  return id !== undefined && GUID.test(id);
}

/** Whether `version` is a SharePoint version label, such as `1.0`. */
export function isVersionLabel(version: string | undefined): version is string {
  return version !== undefined && VERSION.test(version);
}

/** Whether `address` is an email address a schedule can be asked about. */
export function isScheduleAddress(address: string | undefined): address is string {
  return address !== undefined && ADDRESS.test(address);
}

/** The fragment names each calendar projection is spelled with. */
const PROJECTIONS: Record<RevealLevel, string> = {
  freeBusy: "freeBusy", limited: "limitedCalendar", full: "calendar", private: "privateCalendar",
};

/** The subresource ID of the owner's tenant. */
export function tenantSubresourceId(tenantId: string): string {
  return formatSubresourceId({ fragments: [{ name: "tenant", id: tenantId.toLowerCase() }] });
}

/** The subresource ID of a SharePoint access unit. */
export function sharePointSubresourceId(unit: AccessUnit): string {
  const path = ((): [name: string, id: string][] => {
    switch (unit.kind) {
      case "site": return [["site", unit.siteId]];
      case "drive": return [["drive", unit.driveId]];
      case "item": return [["drive", unit.driveId], ["item", unit.itemId]];
      case "list": return [["site", unit.siteId], ["list", unit.listId]];
      case "listItem": return [["site", unit.siteId], ["list", unit.listId], ["item", unit.itemId]];
      case "page": return [["site", unit.siteId], ["page", unit.pageId]];
      case "content": return [["drive", unit.driveId], ["content", unit.itemId]];
      case "versions": return [["drive", unit.driveId], ["versions", unit.itemId]];
      case "fileVersion": return [["drive", unit.driveId], ["item", unit.itemId], ["version", unit.version]];
      case "listItemVersion": return [["site", unit.siteId], ["list", unit.listId], ["item", unit.itemId], ["version", unit.version]];
      case "pageVersion": return [["site", unit.siteId], ["page", unit.pageId], ["version", unit.version]];
    }
  })();
  return formatSubresourceId({ namespace: "sharepoint", fragments: path.map(([name, id]) => ({ name, id })) });
}

/** The subresource ID of an Outlook mailbox, folder or message. */
export function outlookSubresourceId(unit: MailUnit): string {
  const fragments: SubresourceFragment[] = [{ name: "user", id: unit.userId.toLowerCase() }];
  if (unit.kind === "mailFolder") fragments.push({ name: "folder", id: unit.folderId });
  if (unit.kind === "mail") fragments.push({ name: "message", id: unit.messageId });
  return formatSubresourceId({ namespace: "outlook", fragments });
}

/** The subresource ID of what a read showed of someone's calendars. */
export function calendarSubresourceId(unit: CalendarUnit): string {
  const fragments: SubresourceFragment[] = unit.kind === "availability"
    ? [{ name: "availability", id: unit.address.toLowerCase() }]
    : [{ name: "user", id: unit.ownerId.toLowerCase() }];
  if (unit.kind === "calendar") fragments.push({ name: PROJECTIONS[unit.level], id: unit.calendarId });
  return formatSubresourceId({ namespace: "calendar", fragments });
}

/**
 * What a subresource ID names, with every component checked as the probe that reads it needs.
 * @throws Error for any ID {@link tenantSubresourceId}, {@link sharePointSubresourceId},
 * {@link outlookSubresourceId} or {@link calendarSubresourceId} doesn't spell.
 */
export function parseMicrosoftSubresource(id: string): MicrosoftSubresource {
  const { namespace, fragments } = parseSubresourceId(id);
  const shape = fragments.map(({ name }) => name).join("/");
  const ids = fragments.map(({ id: value }) => value);
  const parsed = ((): MicrosoftSubresource | null => {
    switch (namespace) {
      case undefined:
        return shape === "tenant" && isObjectId(ids[0]) && ids[0] === ids[0].toLowerCase()
          ? { kind: "tenant", tenantId: ids[0] } : null;
      case "sharepoint": {
        const unit = sharePointUnit(shape, ids);
        return unit && { kind: "sharepoint", unit };
      }
      case "outlook": {
        const unit = mailUnit(shape, ids);
        return unit && { kind: "outlook", unit };
      }
      case "calendar": {
        const unit = calendarUnit(shape, ids);
        return unit && { kind: "calendar", unit };
      }
      default:
        return null;
    }
  })();
  if (parsed === null) throw new Error("Not a Microsoft 365 subresource ID.");
  return parsed;
}

function sharePointUnit(shape: string, ids: string[]): AccessUnit | null {
  if (!ids.every(id => SEGMENT.test(id))) return null;
  const [a, b, c, d] = ids as [string, string, string, string];
  switch (shape) {
    case "site": return { kind: "site", siteId: a };
    case "drive": return { kind: "drive", driveId: a };
    case "drive/item": return { kind: "item", driveId: a, itemId: b };
    case "site/list": return { kind: "list", siteId: a, listId: b };
    case "site/list/item": return { kind: "listItem", siteId: a, listId: b, itemId: c };
    case "site/page": return { kind: "page", siteId: a, pageId: b };
    case "drive/content": return { kind: "content", driveId: a, itemId: b };
    case "drive/versions": return { kind: "versions", driveId: a, itemId: b };
    case "drive/item/version": return isVersionLabel(c) ? { kind: "fileVersion", driveId: a, itemId: b, version: c } : null;
    case "site/list/item/version":
      return isVersionLabel(d) ? { kind: "listItemVersion", siteId: a, listId: b, itemId: c, version: d } : null;
    case "site/page/version": return isVersionLabel(c) ? { kind: "pageVersion", siteId: a, pageId: b, version: c } : null;
    default: return null;
  }
}

function mailUnit(shape: string, ids: string[]): MailUnit | null {
  const [userId, item] = ids;
  if (!isObjectId(userId) || userId !== userId.toLowerCase()) return null;
  switch (shape) {
    case "user": return { kind: "mailbox", userId };
    case "user/folder": return isMailId(item) ? { kind: "mailFolder", userId, folderId: item } : null;
    case "user/message": return isMailId(item) ? { kind: "mail", userId, messageId: item } : null;
    default: return null;
  }
}

function calendarUnit(shape: string, ids: string[]): CalendarUnit | null {
  const [first, calendarId] = ids;
  if (shape === "availability") {
    return isScheduleAddress(first) && first === first.toLowerCase() ? { kind: "availability", address: first } : null;
  }
  if (!isObjectId(first) || first !== first.toLowerCase()) return null;
  if (shape === "user") return { kind: "calendars", ownerId: first };
  const [user, projection] = shape.split("/");
  const level = (Object.keys(PROJECTIONS) as RevealLevel[]).find(candidate => PROJECTIONS[candidate] === projection);
  return user === "user" && level !== undefined && isMailId(calendarId)
    ? { kind: "calendar", ownerId: first, calendarId, level } : null;
}

/**
 * Parses what a binding of `resource` was asked about, refusing every ID its reads never report,
 * which would otherwise be checked as if they had.
 * @throws Error for an ID that names neither the tenant nor a `resource` resource.
 */
export function parseBindingSubresources(subresources: readonly string[], resource: BindingResource): MicrosoftSubresource[] {
  return subresources.map(id => {
    const parsed = parseMicrosoftSubresource(id);
    if (parsed.kind !== "tenant" && parsed.kind !== resource) throw new Error("Not a subresource ID this Microsoft 365 binding reports.");
    return parsed;
  });
}
