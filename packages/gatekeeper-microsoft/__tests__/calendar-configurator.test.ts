// The Calendar configurator's capability against a fake Microsoft Graph: what it lists, the URL it
// writes, and the binding it reads back.

import { describe, expect, it } from "vitest";
import type { CalendarDraft } from "../src/configurator/calendar-configurator-types";
import { CalendarConfiguratorUI, calendarAccessLevels, draftUrl } from "../src/calendar-configurator";
import type { ConfiguratorConnection } from "../src/configurator-connection";
import { parseCalendarUrl } from "../src/calendar-scope";
import { GraphApi } from "../src/graph-api";
import type { StoredIdentity } from "../src/microsoft-credentials";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ALL_SCOPES = ["User.Read", "Calendars.ReadWrite", "Calendars.ReadWrite.Shared", "MailboxSettings.Read", "People.Read", "User.ReadBasic.All"];
const OWN_ONLY = ["User.Read", "Calendars.ReadWrite", "MailboxSettings.Read", "People.Read"];

// IDs shaped like Exchange's: long enough for the URL grammar.
const MAIN = "AAMkCalendarMain0001";
const TEAM = "AAMkCalendarTeam0002";
const HOLIDAYS = "AAMkCalendarHoliday3";
const SHARED_IN = "AAMkCalendarSharedIn";
const SARAH_MAIN = "AAMkCalendarSarah001";
const SARAH_PROJECT = "AAMkCalendarSarah002";
const SARAH_ID = "66666666-2222-3333-4444-555555555555";
const BOB_ID = "77777777-2222-3333-4444-555555555555";

// -- a fake calendar service, served as Microsoft Graph would serve it --------------------------------

type Calendar = { id: string; name: string; owner: string; isDefault?: boolean; canEdit?: boolean; color?: string };
class FakeGraph {
  requests: string[] = [];
  mine: Calendar[] = [
    { id: TEAM, name: "Gadgets Spike Team", owner: "Phillip@Contoso.com", canEdit: true, color: "#0078D4" },
    { id: HOLIDAYS, name: "United States holidays", owner: "Phillip@Contoso.com" },
    { id: MAIN, name: "Calendar", owner: "Phillip@Contoso.com", isDefault: true, canEdit: true },
    // Someone else's calendar added to the user's own list in Outlook.
    { id: SHARED_IN, name: "Sarah's projects", owner: "sarah@contoso.com", canEdit: false },
  ];
  /** By mail address. `upn` is the sign-in name, when it differs from the address. */
  users: Record<string, { id: string; displayName: string; calendars: Calendar[]; listable: boolean; person?: boolean; upn?: string }> = {
    "sarah@contoso.com": {
      id: SARAH_ID, displayName: "Sarah James", listable: true,
      calendars: [{ id: SARAH_MAIN, name: "Calendar", owner: "sarah@contoso.com", isDefault: true }, { id: SARAH_PROJECT, name: "Projects", owner: "sarah@contoso.com", canEdit: true }],
    },
    "bob@contoso.com": { id: BOB_ID, displayName: "Bob Smith", listable: false, calendars: [] },
  };
  mailboxEnabled = true;
  directoryReadable = true;

  fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    const { status, body } = this.answer(url);
    return Response.json(body, { status });
  };

  answer(url: URL): { status: number; body: unknown } {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    this.requests.push(path);
    if (path === "/me") return { status: 200, body: { id: "phillip-object-id", mail: "phillip@contoso.com", displayName: "Phillip Jones" } };
    if (path === "/users") {
      if (!this.directoryReadable) return error(403, "Authorization_RequestDenied");
      const mail = /^mail eq '((?:[^']|'')*)'$/.exec(url.searchParams.get("$filter") ?? "");
      if (!mail) return error(400, "unexpected filter");
      const address = mail[1]!.replace(/''/g, "'").toLowerCase();
      const user = this.users[address];
      return { status: 200, body: { value: user && user.person !== false ? [{ id: user.id, displayName: user.displayName }] : [] } };
    }
    let owner: Calendar[];
    let rest: string;
    const users = /^\/users\/([^/]+)(\/.*)?$/.exec(path);
    if (users) {
      // Graph finds a user here by object ID or sign-in name, not by mail address.
      const key = users[1]!.toLowerCase();
      const user = Object.entries(this.users).find(([address, candidate]) => (candidate.upn ?? address) === key || candidate.id === key);
      if (users[2] === undefined) {
        if (!this.directoryReadable) return error(403, "Authorization_RequestDenied");
        if (!user || user[1].person === false) return error(404, "Request_ResourceNotFound");
        return { status: 200, body: { id: user[1].id, mail: user[0], displayName: user[1].displayName } };
      }
      if (!user) return error(404, "ErrorInvalidUser");
      if (users[2] === "/calendars" && !user[1].listable) return error(403, "ErrorAccessDenied");
      owner = user[1].calendars;
      rest = users[2];
    } else if (path.startsWith("/me/")) {
      if (!this.mailboxEnabled) return error(404, "MailboxNotEnabledForRESTAPI");
      owner = this.mine;
      rest = path.slice(3);
    } else {
      return error(400, `unexpected ${path}`);
    }
    if (rest === "/calendars") return { status: 200, body: { value: owner.map(calendarJson) } };
    if (rest === "/calendar") {
      const main = owner.find(calendar => calendar.isDefault);
      return main ? { status: 200, body: calendarJson(main) } : error(404, "ErrorItemNotFound");
    }
    const calendar = /^\/calendars\/([^/]+)$/.exec(rest);
    if (calendar) {
      const found = owner.find(candidate => candidate.id === calendar[1]);
      if (!found) return error(404, "ErrorItemNotFound");
      return { status: 200, body: calendarJson(found) };
    }
    return error(400, `unexpected ${path}`);
  }
}

function error(status: number, code: string) {
  return { status, body: { error: { code, message: `${code}.` } } };
}

function calendarJson(calendar: Calendar) {
  return {
    id: calendar.id, name: calendar.name, hexColor: calendar.color ?? "", isDefaultCalendar: calendar.isDefault === true,
    canEdit: calendar.canEdit === true, owner: { name: calendar.owner, address: calendar.owner },
    singleValueExtendedProperties: [{ id: "Binary 0xfff", value: Buffer.from(calendar.id).toString("base64") }],
  };
}

function configurator(options: { scopes?: string[]; ceiling?: "read" | "edit" | "schedule"; graph?: FakeGraph } = {}) {
  const graph = options.graph ?? new FakeGraph();
  const identity: StoredIdentity = { tenantId: "t", objectId: "o", name: "Phillip Jones", username: "Phillip@Contoso.com", fetchedAt: NOW };
  const connection: ConfiguratorConnection = {
    identity: async () => identity,
    grantedScopes: async () => options.scopes ?? ALL_SCOPES,
    read: async op => await op(new GraphApi("token", { fetch: graph.fetch })),
  };
  return { graph, ui: new CalendarConfiguratorUI(connection, options.ceiling ?? "schedule", () => NOW) };
}

const teamDraft = (overrides: Partial<Extract<CalendarDraft, { kind: "calendar" }>> = {}): CalendarDraft =>
  ({ kind: "calendar", calendarId: TEAM, details: "full", privateEvents: "busy", access: "read", ...overrides });

// -- pure helpers -----------------------------------------------------------------------------

describe("calendarAccessLevels", () => {
  it("offers what both the grant and the deployment allow, and colleagues' calendars only what .Shared grants", () => {
    expect(calendarAccessLevels("schedule", ALL_SCOPES)).toEqual({ own: ["read", "edit", "schedule"], shared: ["read", "edit", "schedule"], limitedByDeployment: false });
    expect(calendarAccessLevels("edit", ALL_SCOPES)).toEqual({ own: ["read", "edit"], shared: ["read", "edit"], limitedByDeployment: true });
    expect(calendarAccessLevels("schedule", OWN_ONLY)).toEqual({ own: ["read", "edit", "schedule"], shared: [], limitedByDeployment: false });
    expect(calendarAccessLevels("schedule", ["Calendars.Read", "Calendars.Read.Shared", "User.ReadBasic.All"]))
      .toEqual({ own: ["read"], shared: ["read"], limitedByDeployment: false });
    // Writing to a colleague's calendar needs ReadWrite.Shared, not just Read.Shared.
    expect(calendarAccessLevels("schedule", ["Calendars.ReadWrite", "Calendars.Read.Shared", "User.ReadBasic.All"]).shared).toEqual(["read"]);
    // A read ceiling is the deployment's doing; a read-only grant isn't.
    expect(calendarAccessLevels("read", ALL_SCOPES).limitedByDeployment).toBe(true);
    expect(calendarAccessLevels("schedule", ["Mail.Read"])).toEqual({ own: [], shared: [], limitedByDeployment: false });
  });
});

describe("draftUrl", () => {
  it("writes each draft as a URL the binding grammar reads back the same", () => {
    expect(parseCalendarUrl(draftUrl({ kind: "all", access: "edit" }))).toEqual({ kind: "all", access: "edit" });
    expect(parseCalendarUrl(draftUrl({ kind: "availability" }))).toEqual({ kind: "availability" });
    expect(parseCalendarUrl(draftUrl({ kind: "calendar", calendarId: "default", details: "freeBusy", privateEvents: "busy", access: "read" })))
      .toEqual({ kind: "calendar", calendar: "default", details: "freeBusy", privateEvents: "busy", access: "read" });
    expect(parseCalendarUrl(draftUrl(teamDraft({ owner: " Sarah@Contoso.com ", privateEvents: "show", access: "schedule" }))))
      .toEqual({ kind: "calendar", owner: "sarah@contoso.com", calendar: { id: TEAM }, details: "full", privateEvents: "show", access: "schedule" });
  });

  it("refuses what the grammar would, so a forged draft binds nothing", () => {
    expect(() => parseCalendarUrl(draftUrl(teamDraft({ details: "limited", privateEvents: "show" })))).toThrow(/only be shown with full details/);
    expect(() => parseCalendarUrl(draftUrl(teamDraft({ details: "freeBusy", access: "edit" })))).toThrow(/full details can change/);
    expect(() => parseCalendarUrl(draftUrl(teamDraft({ calendarId: "../../me/messages" })))).toThrow();
    expect(() => draftUrl(teamDraft({ owner: "not an address" }))).toThrow(/isn't an email address/);
  });
});

describe("CalendarConfiguratorUI", () => {
  it("is ready with the levels the grant and the deployment allow", async () => {
    const { ui } = configurator({ ceiling: "edit" });
    expect(await ui.getStatus()).toEqual({
      state: "ready", me: { address: "phillip@contoso.com", name: "Phillip Jones" },
      levels: ["read", "edit"], sharedLevels: ["read", "edit"], limitedByDeployment: true,
    });
  });

  it("asks for access when the grant has no calendars, and says when there's no mailbox", async () => {
    expect(await configurator({ scopes: ["User.Read", "Mail.Read"] }).ui.getStatus()).toEqual({ state: "needsAccess" });
    const graph = new FakeGraph();
    graph.mailboxEnabled = false;
    expect(await configurator({ graph }).ui.getStatus()).toMatchObject({ state: "unavailable", message: expect.stringContaining("no Outlook calendar") });
  });

  it("lists the user's own calendars, main first, and leaves out ones others shared into their list", async () => {
    const { ui } = configurator();
    expect(await ui.listCalendars()).toEqual([
      { id: MAIN, name: "Calendar", isDefault: true, canEdit: true },
      { id: TEAM, name: "Gadgets Spike Team", isDefault: false, canEdit: true, color: "#0078d4" },
      { id: HOLIDAYS, name: "United States holidays", isDefault: false, canEdit: false },
    ]);
  });

  it("opens a colleague's calendars, or their main one when Exchange won't list them", async () => {
    const { ui } = configurator();
    expect(await ui.openColleague("Sarah@Contoso.com")).toEqual({
      address: "sarah@contoso.com", name: "Sarah James",
      calendars: [{ id: SARAH_MAIN, name: "Calendar", isDefault: true, canEdit: false }, { id: SARAH_PROJECT, name: "Projects", isDefault: false, canEdit: true }],
    });
    const graph = new FakeGraph();
    graph.users["bob@contoso.com"]!.calendars = [{ id: "AAMkCalendarBob00001", name: "Calendar", owner: "bob@contoso.com", isDefault: true }];
    expect(await configurator({ graph }).ui.openColleague("bob@contoso.com")).toMatchObject({
      name: "Bob Smith", calendars: [{ id: "AAMkCalendarBob00001", isDefault: true }], notice: expect.stringContaining("Only Bob Smith's main calendar"),
    });
  });

  it("says why a colleague's calendars can't be opened", async () => {
    const { ui } = configurator();
    await expect(ui.openColleague("bob@contoso.com")).rejects.toThrow("Bob Smith hasn't shared a calendar with you");
    await expect(ui.openColleague("nobody@contoso.com")).rejects.toThrow("There's nobody with the address nobody@contoso.com");
    // Named by primary address, which `/users/{address}` doesn't match when it differs from the sign-in name.
    const byMail = new FakeGraph();
    byMail.users["ada@contoso.com"] = {
      id: "ada-object-id", displayName: "Ada Lovelace", listable: true, upn: "alovelace@contoso.com",
      calendars: [{ id: "AAMkCalendarAda00001", name: "Calendar", owner: "ada@contoso.com", isDefault: true }],
    };
    expect(await configurator({ graph: byMail }).ui.openColleague("ada@contoso.com")).toMatchObject({ address: "ada@contoso.com", name: "Ada Lovelace", calendars: [{ id: "AAMkCalendarAda00001" }] });
    await expect(ui.openColleague("PHILLIP@contoso.com")).rejects.toThrow("That's you");
    await expect(ui.openColleague("not-an-address")).rejects.toThrow("isn't an email address");
    await expect(configurator({ scopes: OWN_ONLY }).ui.openColleague("sarah@contoso.com")).rejects.toThrow(/can't open calendars shared with you/);
  });

  it("writes the URL by immutable ID once the gatekeeper has resolved the draft", async () => {
    const { ui } = configurator();
    expect(await ui.resourceUrlFor({ kind: "calendar", calendarId: "default", details: "freeBusy", privateEvents: "busy", access: "read" }))
      .toBe(`https://outlook.office.com/calendar/id/${MAIN}?details=freeBusy&access=read`);
    expect(await ui.resourceUrlFor(teamDraft({ privateEvents: "show", access: "schedule" })))
      .toBe(`https://outlook.office.com/calendar/id/${TEAM}?details=full&private=show&access=schedule`);
    expect(await ui.resourceUrlFor({ kind: "calendar", owner: "sarah@contoso.com", calendarId: SARAH_PROJECT, details: "limited", privateEvents: "busy", access: "read" }))
      .toBe(`https://outlook.office.com/calendar/sarah%40contoso.com/id/${SARAH_PROJECT}?details=limited&access=read`);
    expect(await ui.resourceUrlFor({ kind: "all", access: "edit" })).toBe("https://outlook.office.com/calendar/?access=edit");
    expect(await ui.resourceUrlFor({ kind: "availability" })).toBe("https://outlook.office.com/calendar/availability");
  });

  it("refuses a level the grant, the deployment or the calendar doesn't allow", async () => {
    await expect(configurator({ ceiling: "edit" }).ui.resourceUrlFor({ kind: "all", access: "schedule" }))
      .rejects.toThrow(`"Also invite and respond" isn't allowed here. Choose up to "Add and change events".`);
    await expect(configurator({ scopes: OWN_ONLY }).ui.resourceUrlFor({ kind: "calendar", owner: "sarah@contoso.com", calendarId: SARAH_PROJECT, details: "full", privateEvents: "busy", access: "read" }))
      .rejects.toThrow(/can't open calendars shared with you/);
    await expect(configurator().ui.resourceUrlFor(teamDraft({ calendarId: HOLIDAYS, access: "edit" }))).rejects.toThrow(/can only be connected to read/);
    await expect(configurator().ui.resourceUrlFor(teamDraft({ calendarId: "AAMkCalendarGone0000" }))).rejects.toThrow(/isn't one of yours/);
  });

  it("resolves afresh to write the URL, so a calendar deleted since it was chosen isn't bound", async () => {
    const { ui, graph } = configurator();
    await ui.resourceUrlFor(teamDraft());
    graph.mine = graph.mine.filter(calendar => calendar.id !== TEAM);
    await expect(ui.resourceUrlFor(teamDraft())).rejects.toThrow(/isn't one of yours/);
  });

  it("reads a binding URL back for editing, lowering a level no longer allowed", async () => {
    const { ui } = configurator();
    expect(await ui.locate(`https://outlook.office.com/calendar/id/${TEAM}?details=full&private=show&access=schedule`)).toEqual({
      kind: "calendar", calendar: { id: TEAM, name: "Gadgets Spike Team", isDefault: false, canEdit: true, color: "#0078d4" },
      details: "full", privateEvents: "show", access: "schedule",
    });
    expect(await ui.locate(`https://outlook.office.com/calendar/sarah@contoso.com/id/${SARAH_PROJECT}?details=limited`)).toMatchObject({
      owner: { address: "sarah@contoso.com", name: "Sarah James" }, details: "limited", access: "read",
    });
    expect(await ui.locate("https://outlook.office.com/calendar/view/week")).toEqual({ kind: "all", access: "schedule" });
    expect(await configurator({ ceiling: "edit" }).ui.locate("https://outlook.office.com/calendar/?access=schedule")).toEqual({ kind: "all", access: "edit" });
    expect(await ui.locate("https://outlook.office.com/calendar/availability")).toEqual({ kind: "availability" });
    expect(await ui.locate("https://outlook.office.com/mail/")).toBeNull();
    expect(await ui.locate("https://outlook.office.com/calendar/id/AAMkCalendarGone0000")).toBeNull();
    expect(await ui.locate("https://outlook.office.com/calendar/bob@contoso.com/default")).toBeNull();
  });

  it("reads the status afresh each time, as it's asked again after a consent pop-up", async () => {
    const { ui, graph } = configurator();
    const statusFrom = graph.requests.length;
    await ui.getStatus();
    await ui.getStatus();
    expect(graph.requests.slice(statusFrom).filter(request => request === "/me/calendar")).toHaveLength(2);
  });
});
