// The Calendar configurator frame as the Workshop hosts it, in Chromium: the journeys a user takes
// through it, with the gatekeeper capability faked so each test decides what it answers and when.

import { describe, expect, it } from "vitest";
import type { CalendarConfiguratorStatus, CalendarRow } from "../src/configurator/calendar-configurator-types";
import type { Locator } from "playwright";
import { startFrame, useFrameHost, type Answer, type Hosted } from "./frame-host";

const PATTERN = "https://outlook.office.com/calendar/*";
const READY: CalendarConfiguratorStatus = {
  state: "ready", me: { address: "phillip@contoso.com", name: "Phillip Jones" },
  levels: ["read", "edit", "schedule"], sharedLevels: ["read"], limitedByDeployment: false,
};
const CALENDARS: CalendarRow[] = [
  { id: "AAMkCalendarMain0001", name: "Calendar", isDefault: true, canEdit: true },
  { id: "AAMkCalendarTeam0002", name: "Gadgets Spike Team", isDefault: false, canEdit: true, color: "#0078d4" },
  { id: "AAMkCalendarHoliday3", name: "United States holidays", isDefault: false, canEdit: false },
];
const SARAH = { address: "sarah@contoso.com", name: "Sarah James" };
const SARAHS_PROJECTS: CalendarRow = { id: "AAMkCalendarSarah002", name: "Projects", isDefault: false, canEdit: true };

useFrameHost();

const start = (answers: Record<string, Answer>, initialResource?: string) => startFrame("calendar", { answers, initialResource });

const group = (hosted: Hosted, name: string) => hosted.frame().getByRole("radiogroup", { name });
/** A radio by its group's and its own accessible names; a card's name starts with its title. */
const radio = (hosted: Hosted, groupName: string, name: string | RegExp) =>
  group(hosted, groupName).getByRole("radio", { name, exact: typeof name === "string" });
const target = (hosted: Hosted, title: string) => radio(hosted, "What to connect", new RegExp(`^${title}`));
const calendarRows = (hosted: Hosted) => group(hosted, "Calendars").getByRole("radio");
/** "More options", where a calendar's event details live. */
const more = (hosted: Hosted) => hosted.frame().getByRole("button", { name: /^More options/ });
const button = (hosted: Hosted, name: string) => hosted.frame().getByRole("button", { name, exact: true });
const alert = (hosted: Hosted) => hosted.frame().getByRole("alert");
const ready = async (hosted: Hosted) => (await hosted.state()).ready;
/** Chooses a radio or checkbox as a user does, by its label: a segment's input is visually hidden. */
async function choose(hosted: Hosted, control: Locator): Promise<void> {
  await hosted.frame().locator(`label[for="${await control.getAttribute("id")}"]`).click();
}

/** What the frame binds: the draft it hands the gatekeeper, which is then answered so collection ends. */
async function draft(hosted: Hosted): Promise<unknown> {
  const value = await hosted.collected();
  hosted.waiting("resourceUrlFor").at(-1)!.resolve("https://outlook.office.com/calendar/");
  return value;
}

async function chooseTeamCalendar(hosted: Hosted): Promise<void> {
  await choose(hosted, target(hosted, "One calendar"));
  await choose(hosted, radio(hosted, "Calendars", "Gadgets Spike Team"));
}

describe("the Calendar configurator frame", () => {
  it("opens on every calendar, read only, with nothing more to choose", async () => {
    const frame = await start({ getStatus: () => READY });
    expect(await target(frame, "All your calendars").isChecked()).toBe(true);
    expect(await radio(frame, "Permission", "Read only").isChecked()).toBe(true);
    expect(await frame.text()).toContain("Nothing can be changed.");
    expect(await more(frame).count()).toBe(0);
    await expect.poll(() => ready(frame)).toBe(true);
    expect(await draft(frame)).toEqual({ kind: "all", access: "read" });
    // Nothing is read to show the user beyond what they choose from.
    expect(frame.calls.map(call => call.method)).toEqual(["getStatus", "resourceUrlFor"]);
    // A script the policy refused, or a missing global, would show here.
    expect(frame.consoleErrors).toEqual([]);
  });

  it("chooses one calendar, and offers its permission and details once it's chosen", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await choose(frame, target(frame, "One calendar"));
    await expect.poll(() => ready(frame)).toBe(false);
    expect(await group(frame, "Permission").count()).toBe(0);
    expect(await more(frame).count()).toBe(0);
    await expect.poll(() => calendarRows(frame).evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))))
      .toEqual(["Calendar, Main calendar", "Gadgets Spike Team", "United States holidays, Read only"]);
    const team = radio(frame, "Calendars", "Gadgets Spike Team");
    await choose(frame, team);
    await expect.poll(() => ready(frame)).toBe(true);
    // Focus stays on the chosen radio across the rebuild.
    expect(await team.evaluate(node => node.matches(":focus"))).toBe(true);
    expect(await radio(frame, "Permission", "Read only").isChecked()).toBe(true);
    expect(await more(frame).getAttribute("aria-expanded")).toBe("false");
    expect(await more(frame).textContent()).toContain("All details");
    expect(await draft(frame)).toEqual({ kind: "calendar", calendarId: "AAMkCalendarTeam0002", details: "full", privateEvents: "busy", access: "read" });
  });

  it("allows changes only with all details, and keeps the permission chosen for when they're back", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await chooseTeamCalendar(frame);
    await choose(frame, radio(frame, "Permission", "Also invite"));
    await expect.poll(() => frame.text()).toContain("Invitations can also be sent and answered. Each one waits for your approval.");
    await more(frame).click();
    await choose(frame, radio(frame, "Event details", "Titles and places"));
    await expect.poll(() => radio(frame, "Permission", "Add and change").isDisabled()).toBe(true);
    expect(await radio(frame, "Permission", "Also invite").isDisabled()).toBe(true);
    expect(await radio(frame, "Permission", "Read only").isChecked()).toBe(true);
    expect(await frame.text()).toContain("Changes need all details, under More options.");
    // Private events can only be shown in full.
    expect(await frame.frame().getByRole("checkbox").count()).toBe(0);
    await choose(frame, radio(frame, "Event details", "All details"));
    await expect.poll(() => radio(frame, "Permission", "Also invite").isChecked()).toBe(true);
  });

  it("shows private events only when asked, and drops them with full details", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await chooseTeamCalendar(frame);
    await more(frame).click();
    const privateEvents = frame.frame().getByRole("checkbox", { name: "Show private events in full" });
    await choose(frame, privateEvents);
    await expect.poll(() => more(frame).textContent()).toContain("All details · private events shown");
    expect(await draft(frame)).toMatchObject({ details: "full", privateEvents: "show" });
    await choose(frame, radio(frame, "Event details", "Free/busy"));
    await privateEvents.waitFor({ state: "detached" });
    expect(await draft(frame)).toMatchObject({ details: "freeBusy", privateEvents: "busy" });
  });

  it("keeps a read-only calendar read only, and says why", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await choose(frame, target(frame, "One calendar"));
    await choose(frame, radio(frame, "Calendars", "United States holidays, Read only"));
    await expect.poll(() => radio(frame, "Permission", "Add and change").isDisabled()).toBe(true);
    expect(await frame.text()).toContain(`You can't change events in "United States holidays" yourself.`);
  });

  it("offers the user's free time as free/busy of their main calendar, with nothing more to choose", async () => {
    const frame = await start({ getStatus: () => READY });
    await choose(frame, target(frame, "Your free time"));
    await group(frame, "Permission").waitFor({ state: "detached" });
    expect(await more(frame).count()).toBe(0);
    expect(await draft(frame)).toEqual({ kind: "calendar", calendarId: "default", details: "freeBusy", privateEvents: "busy", access: "read" });
  });

  it("offers colleagues' availability with nothing more to choose", async () => {
    const frame = await start({ getStatus: () => READY });
    await choose(frame, target(frame, "Colleagues' availability"));
    await group(frame, "Permission").waitFor({ state: "detached" });
    expect(await draft(frame)).toEqual({ kind: "availability" });
  });

  it("opens a colleague's calendars only once the gatekeeper has, and limits their permission to what the grant allows", async () => {
    const frame = await start({ getStatus: () => READY, listCalendars: () => CALENDARS });
    await choose(frame, target(frame, "One calendar"));
    await choose(frame, radio(frame, "Whose", "A colleague's"));
    await group(frame, "Calendars").waitFor({ state: "detached" });
    const address = frame.frame().getByLabel("Colleague's email address");
    await address.fill("sarah");
    await button(frame, "Open").click();
    await expect.poll(() => alert(frame).textContent()).toBe(`"sarah" isn't an email address. Enter one like sarah@contoso.com.`);
    expect(frame.callsOf("openColleague")).toHaveLength(0);
    await address.fill("phillip@contoso.com");
    await address.press("Enter");
    await expect.poll(() => alert(frame).textContent()).toBe("That's you. Choose Yours above instead.");

    await address.fill("Sarah@Contoso.com");
    await address.press("Enter");
    await expect.poll(() => frame.text()).toContain("Opening…");
    await expect.poll(() => frame.waiting("openColleague")).toHaveLength(1);
    frame.waiting("openColleague")[0]!.reject("Sarah James hasn't shared a calendar with you.");
    await expect.poll(() => alert(frame).textContent()).toBe("Sarah James hasn't shared a calendar with you.");

    await button(frame, "Open").click();
    await expect.poll(() => frame.waiting("openColleague")).toHaveLength(1);
    expect(frame.waiting("openColleague")[0]!.args).toEqual(["sarah@contoso.com"]);
    frame.waiting("openColleague")[0]!.resolve({ ...SARAH, calendars: [SARAHS_PROJECTS] });
    await expect.poll(() => frame.text()).toContain("Sarah James");
    expect(await frame.text()).toContain("sarah@contoso.com");
    // Her only calendar is chosen for the user.
    expect(await radio(frame, "Calendars", "Projects").isChecked()).toBe(true);
    expect(await radio(frame, "Permission", "Add and change").isDisabled()).toBe(true);
    expect(await frame.text()).toContain(`For colleagues' calendars, this connection allows up to "Read only".`);
    expect(await draft(frame)).toEqual({ kind: "calendar", owner: "sarah@contoso.com", calendarId: "AAMkCalendarSarah002", details: "full", privateEvents: "busy", access: "read" });

    await button(frame, "Change").click();
    expect(await address.inputValue()).toBe("sarah@contoso.com");
    await expect.poll(() => ready(frame)).toBe(false);
  });

  it("offers no colleague's calendar when the grant can't open one, and says what would", async () => {
    const frame = await start({ getStatus: () => ({ ...READY, sharedLevels: [] }), listCalendars: () => CALENDARS });
    await choose(frame, target(frame, "One calendar"));
    await expect.poll(() => calendarRows(frame).count()).toBe(3);
    expect(await group(frame, "Whose").count()).toBe(0);
    expect(await frame.text()).toContain("Calendars others share with you open through your own account, once an admin approves more Microsoft 365 permissions and you reconnect.");
  });

  it("names the deployment when it, not the grant, caps the permission", async () => {
    const frame = await start({ getStatus: () => ({ ...READY, levels: ["read", "edit"], sharedLevels: [], limitedByDeployment: true }) });
    expect(await radio(frame, "Permission", "Also invite").isDisabled()).toBe(true);
    expect(await frame.text()).toContain(`Your organization allows up to "Add and change".`);
    const grant = await start({ getStatus: () => ({ ...READY, levels: ["read"], sharedLevels: [] }) });
    await expect.poll(() => grant.text()).toContain(`This connection allows up to "Read only". Reconnect Microsoft 365 to allow more.`);
  });

  it("asks for calendar access from the click, then reads the status again", async () => {
    let status: CalendarConfiguratorStatus = { state: "needsAccess" };
    const frame = await start({ getStatus: () => status });
    await expect.poll(() => frame.text()).toContain("hasn't been allowed to open calendars yet");
    expect(await ready(frame)).toBe(false);
    status = READY;
    await button(frame, "Allow access").click();
    await expect.poll(() => frame.text()).toContain("What to connect");
    expect((await frame.state()).ensured).toEqual([[PATTERN]]);
  });

  it("says when there's no calendar at all", async () => {
    const frame = await start({ getStatus: () => ({ state: "unavailable", message: "This Microsoft 365 account has no Outlook calendar." }) });
    expect(await alert(frame).textContent()).toContain("no Outlook calendar");
    expect(await group(frame, "What to connect").count()).toBe(0);
  });

  it("collects the resource URL the gatekeeper writes", async () => {
    const frame = await start({ getStatus: () => READY });
    await choose(frame, radio(frame, "Permission", "Add and change"));
    const collecting = frame.collect();
    await expect.poll(() => frame.waiting("resourceUrlFor")).toHaveLength(1);
    const [resolving] = frame.waiting("resourceUrlFor");
    expect(resolving!.args).toEqual([{ kind: "all", access: "edit" }]);
    resolving!.resolve("https://outlook.office.com/calendar/?access=edit");
    await expect(collecting).resolves.toEqual({ url: "https://outlook.office.com/calendar/?access=edit" });
  });

  it("opens a binding being edited as it was: a calendar at its permission", async () => {
    const url = "https://outlook.office.com/calendar/id/AAMkCalendarTeam0002?details=full&private=show&access=edit";
    const frame = await start({
      getStatus: () => READY, listCalendars: () => CALENDARS,
      locate: () => ({ kind: "calendar", calendar: CALENDARS[1], details: "full", privateEvents: "show", access: "edit" }),
    }, url);
    // "More options" opens itself to show what the binding changed from the defaults, and still closes.
    expect(await more(frame).getAttribute("aria-expanded")).toBe("true");
    await more(frame).click();
    await expect.poll(() => more(frame).getAttribute("aria-expanded")).toBe("false");
    await more(frame).click();
    await expect.poll(() => more(frame).getAttribute("aria-expanded")).toBe("true");
    for (const chosen of [
      target(frame, "One calendar"), radio(frame, "Whose", "Yours"), radio(frame, "Calendars", "Gadgets Spike Team"),
      radio(frame, "Event details", "All details"), frame.frame().getByRole("checkbox", { name: "Show private events in full" }),
      radio(frame, "Permission", "Add and change"),
    ]) {
      expect(await chosen.isChecked(), String(chosen)).toBe(true);
    }
  });

  it("opens free/busy of the main calendar as the user's free time, and a colleague's calendar under them", async () => {
    const freeTime = await start({
      getStatus: () => READY,
      locate: () => ({ kind: "calendar", calendar: CALENDARS[0], details: "freeBusy", privateEvents: "busy", access: "read" }),
    }, "https://outlook.office.com/calendar/id/AAMkCalendarMain0001?details=freeBusy&access=read");
    expect(await target(freeTime, "Your free time").isChecked()).toBe(true);

    const theirs = await start({
      getStatus: () => READY,
      openColleague: () => ({ ...SARAH, calendars: [SARAHS_PROJECTS] }),
      locate: () => ({ kind: "calendar", owner: SARAH, calendar: SARAHS_PROJECTS, details: "limited", privateEvents: "busy", access: "read" }),
    }, "https://outlook.office.com/calendar/sarah%40contoso.com/id/AAMkCalendarSarah002?details=limited&access=read");
    for (const chosen of [
      target(theirs, "One calendar"), radio(theirs, "Whose", "A colleague's"), radio(theirs, "Calendars", "Projects"),
      radio(theirs, "Event details", "Titles and places"),
    ]) {
      expect(await chosen.isChecked(), String(chosen)).toBe(true);
    }
    expect(await theirs.text()).toContain("Sarah James");
    expect(await theirs.text()).toContain("sarah@contoso.com");
    expect(theirs.callsOf("openColleague").map(call => call.args)).toEqual([["sarah@contoso.com"]]);
  });

  it("says what failed and retries just that", async () => {
    let fail = true;
    const frame = await start({
      getStatus: () => READY,
      listCalendars: () => {
        if (fail) throw new Error("Outlook didn't answer. Try again in a moment.");
        return CALENDARS;
      },
    });
    await choose(frame, target(frame, "One calendar"));
    await expect.poll(() => alert(frame).textContent()).toBe("Outlook didn't answer. Try again in a moment.");
    fail = false;
    await button(frame, "Try again").click();
    await expect.poll(() => calendarRows(frame).count()).toBe(3);
  });
});
