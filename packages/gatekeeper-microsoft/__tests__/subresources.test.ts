// The subresource IDs Microsoft 365 reads report: the Workshop records them and checks every
// collaborator against them on later opens, so their spelling is part of the stored contract.

import { describe, expect, it } from "vitest";
import {
  calendarSubresourceId, outlookSubresourceId, parseBindingSubresources, parseMicrosoftSubresource, sharePointSubresourceId,
  tenantSubresourceId, type MicrosoftSubresource,
} from "../src/subresources";

const TENANT = "aaaaaaaa-0000-0000-0000-00000000000a";
const USER = "bbbbbbbb-0000-0000-0000-00000000000b";
const SITE = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";
const DRIVE = "b!abc_DEF-123";
const ITEM = "01ABCDEFGHIJKLMNOPQRSTUVWX";
const LIST = "33333333-3333-3333-3333-333333333333";
const PAGE = "44444444-4444-4444-4444-444444444444";
const MAIL_ID = "AAMk/x+y=";
const CALENDAR = "AAMkCal=";

const every: [MicrosoftSubresource, string][] = [
  [{ kind: "tenant", tenantId: TENANT }, `tenant/${TENANT}`],
  [{ kind: "sharepoint", unit: { kind: "site", siteId: SITE } }, `sharepoint/site/${encodeURIComponent(SITE)}`],
  [{ kind: "sharepoint", unit: { kind: "drive", driveId: DRIVE } }, `sharepoint/drive/${encodeURIComponent(DRIVE)}`],
  [{ kind: "sharepoint", unit: { kind: "item", driveId: DRIVE, itemId: ITEM } }, `sharepoint/drive/${encodeURIComponent(DRIVE)}/item/${ITEM}`],
  [{ kind: "sharepoint", unit: { kind: "list", siteId: SITE, listId: LIST } }, `sharepoint/site/${encodeURIComponent(SITE)}/list/${LIST}`],
  [{ kind: "sharepoint", unit: { kind: "listItem", siteId: SITE, listId: LIST, itemId: "7" } },
    `sharepoint/site/${encodeURIComponent(SITE)}/list/${LIST}/item/7`],
  [{ kind: "sharepoint", unit: { kind: "page", siteId: SITE, pageId: PAGE } }, `sharepoint/site/${encodeURIComponent(SITE)}/page/${PAGE}`],
  [{ kind: "sharepoint", unit: { kind: "content", driveId: DRIVE, itemId: ITEM } }, `sharepoint/drive/${encodeURIComponent(DRIVE)}/content/${ITEM}`],
  [{ kind: "sharepoint", unit: { kind: "versions", driveId: DRIVE, itemId: ITEM } }, `sharepoint/drive/${encodeURIComponent(DRIVE)}/versions/${ITEM}`],
  [{ kind: "sharepoint", unit: { kind: "fileVersion", driveId: DRIVE, itemId: ITEM, version: "3.1" } },
    `sharepoint/drive/${encodeURIComponent(DRIVE)}/item/${ITEM}/version/3.1`],
  [{ kind: "sharepoint", unit: { kind: "listItemVersion", siteId: SITE, listId: LIST, itemId: "7", version: "2.0" } },
    `sharepoint/site/${encodeURIComponent(SITE)}/list/${LIST}/item/7/version/2.0`],
  [{ kind: "sharepoint", unit: { kind: "pageVersion", siteId: SITE, pageId: PAGE, version: "1.1" } },
    `sharepoint/site/${encodeURIComponent(SITE)}/page/${PAGE}/version/1.1`],
  [{ kind: "outlook", unit: { kind: "mailbox", userId: USER } }, `outlook/user/${USER}`],
  [{ kind: "outlook", unit: { kind: "mailFolder", userId: USER, folderId: MAIL_ID } }, `outlook/user/${USER}/folder/AAMk%2Fx%2By%3D`],
  [{ kind: "outlook", unit: { kind: "mail", userId: USER, messageId: MAIL_ID } }, `outlook/user/${USER}/message/AAMk%2Fx%2By%3D`],
  [{ kind: "calendar", unit: { kind: "calendars", ownerId: USER } }, `calendar/user/${USER}`],
  [{ kind: "calendar", unit: { kind: "calendar", ownerId: USER, calendarId: CALENDAR, level: "freeBusy" } }, `calendar/user/${USER}/freeBusy/AAMkCal%3D`],
  [{ kind: "calendar", unit: { kind: "calendar", ownerId: USER, calendarId: CALENDAR, level: "limited" } }, `calendar/user/${USER}/limitedCalendar/AAMkCal%3D`],
  [{ kind: "calendar", unit: { kind: "calendar", ownerId: USER, calendarId: CALENDAR, level: "full" } }, `calendar/user/${USER}/calendar/AAMkCal%3D`],
  [{ kind: "calendar", unit: { kind: "calendar", ownerId: USER, calendarId: CALENDAR, level: "private" } }, `calendar/user/${USER}/privateCalendar/AAMkCal%3D`],
  [{ kind: "calendar", unit: { kind: "availability", address: "sarah@contoso.com" } }, "calendar/availability/sarah%40contoso.com"],
];

function spell(resource: MicrosoftSubresource): string {
  switch (resource.kind) {
    case "tenant": return tenantSubresourceId(resource.tenantId);
    case "sharepoint": return sharePointSubresourceId(resource.unit);
    case "outlook": return outlookSubresourceId(resource.unit);
    case "calendar": return calendarSubresourceId(resource.unit);
  }
}

describe("subresource IDs", () => {
  it("spells every kind one way, and reads it back", () => {
    for (const [resource, id] of every) {
      expect(spell(resource)).toBe(id);
      expect(parseMicrosoftSubresource(id)).toEqual(resource);
    }
  });

  it("names people the same whatever case Graph gave them in", () => {
    expect(tenantSubresourceId(TENANT.toUpperCase())).toBe(`tenant/${TENANT}`);
    expect(outlookSubresourceId({ kind: "mailbox", userId: USER.toUpperCase() })).toBe(`outlook/user/${USER}`);
    expect(calendarSubresourceId({ kind: "calendars", ownerId: USER.toUpperCase() })).toBe(`calendar/user/${USER}`);
    expect(calendarSubresourceId({ kind: "availability", address: "Sarah@Contoso.com" })).toBe("calendar/availability/sarah%40contoso.com");
  });

  it("refuses an ID it doesn't spell, rather than read it as some nearby resource", () => {
    for (const id of [
      `gmail/user/${USER}`,
      `sharepoint/folder/${ITEM}`,
      "sharepoint/drive/b%21abc",
      `sharepoint/drive/${encodeURIComponent("b!a:b")}/item/${ITEM}`,
      `sharepoint/drive/${encodeURIComponent("b!a/b")}/item/${ITEM}`,
      `sharepoint/drive/${encodeURIComponent("b!a?b")}/item/${ITEM}`,
      `sharepoint/drive/${encodeURIComponent(DRIVE)}/item/${ITEM}/version/latest`,
      `outlook/user/not-a-guid`,
      `outlook/user/${USER.toUpperCase()}`,
      `outlook/user/${USER}/message/${encodeURIComponent("has spaces")}`,
      `calendar/user/${USER}/everything/AAMkCal%3D`,
      "calendar/availability/no-at-sign",
      "calendar/availability/Sarah%40contoso.com",
      `tenant/${TENANT.toUpperCase()}`,
      `tenant/${TENANT}/user/${USER}`,
      "sharepoint/site/a%2fb",
    ]) {
      expect(() => parseMicrosoftSubresource(id), id).toThrow();
    }
  });

  it("refuses, for a binding, IDs that only another resource's reads report", () => {
    const tenant = `tenant/${TENANT}`;
    const mailbox = `outlook/user/${USER}`;
    expect(parseBindingSubresources([tenant, mailbox], "outlook")).toHaveLength(2);
    expect(() => parseBindingSubresources([tenant, mailbox], "sharepoint")).toThrow("Not a subresource ID this Microsoft 365 binding reports.");
    expect(() => parseBindingSubresources([`calendar/user/${USER}`], "outlook")).toThrow();
  });
});
