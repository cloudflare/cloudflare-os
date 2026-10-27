// Calendar against the live tenant. Phillip's "Gadgets Spike Team" calendar is shared `read` with
// Sarah and `freeBusyRead` with Bob; his main calendar gives the organization `freeBusyRead`. Each
// run makes its own events on a day weeks out, tags them with a run ID, and removes them at the end,
// so nothing depends on what earlier runs left.
//
// Opening a calendar shared with you needs `Calendars.Read.Shared` and `User.ReadBasic.All`, which
// the test app hasn't been granted, so shared bindings are tested from the owner's side only: who
// may observe a binding, which is what keeps a shared one from leaking.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Availability, CalendarInfo, CalendarOverview, EventContent, EventInfo, FreeTimes } from "../../src/calendar-types";
import type { CalendarScope } from "../../src/calendar-scope";
import type { CalendarGatekeeperProps } from "../../src/microsoft-env";
import { account, connect, failure, facet, hooks, live, run, unwrap, walk, type Label } from "./tenant";

const RUN = `run-${Date.now().toString(36)}`;
const OUTSIDE = /is outside what this Calendar connection covers, or doesn't exist/;
const TEAM_NAME = "Gadgets Spike Team";

/** A weekday five weeks out, so the run's events never collide with anything near today. */
const DAY = (() => {
  const day = new Date(Date.now() + 35 * 86_400_000);
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
})();
const at = (hour: number, minute = 0) => `${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
const WINDOW = { start: at(0), end: `${DAY}T23:59:00Z` };

type Submitted = { actionId: number; description: { title: string; description: string; fields?: unknown } };

function address(label: Label): string {
  return account(label).username.toLowerCase();
}

async function bindCalendar(label: Label, url: string): Promise<CalendarGatekeeperProps> {
  const userObjectId = await connect(label);
  return { userObjectId, scope: unwrap<CalendarScope>(await hooks().resolveCalendar(userObjectId, url)) };
}

async function lastSubmitted(name: string): Promise<Submitted> {
  return (await hooks().queueLog(name)).submitted.at(-1) as Submitted;
}

async function approveLast(name: string, props: CalendarGatekeeperProps): Promise<Submitted> {
  const last = await lastSubmitted(name);
  unwrap(await hooks().applyAction(name, props, last.actionId));
  return last;
}

async function events(name: string, props: CalendarGatekeeperProps, options: Record<string, unknown> = {}): Promise<EventInfo[]> {
  return await walk<EventInfo>(name, props, [["listEvents", { ...WINDOW, ...options }]], 10);
}

/** Polls `events` until `match` holds, as a change can take a few seconds to reach another mailbox. */
async function eventually(name: string, props: CalendarGatekeeperProps, match: (listed: EventInfo[]) => boolean, tries = 20): Promise<EventInfo[]> {
  for (let attempt = 0; ; attempt++) {
    const listed = await events(name, props);
    if (match(listed) || attempt === tries) return listed;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}

/** Events made directly in Graph, for the gatekeeper to find, and removed after the run. */
const made: { label: Label; id: string }[] = [];

/**
 * Makes an event in Graph and returns its ID as the gatekeeper names it. The setup hook's requests
 * don't ask for immutable IDs, which every gatekeeper request does, so the event is found again
 * through an all-calendars binding, by its run-tagged subject.
 */
async function makeEvent(label: Label, calendarPath: string, fields: Record<string, unknown>): Promise<string> {
  const userObjectId = await connect(label);
  const subject = `${fields.subject as string} ${RUN}`;
  const created = unwrap<{ id: string }>(await hooks().graph(userObjectId, "POST", `${calendarPath}/events`, { showAs: "busy", ...fields, subject }));
  made.push({ label, id: created.id });
  const everything = await bindCalendar(label, "https://outlook.office.com/calendar/?access=read");
  const found = (await events(facet(`find-${label}`), everything)).find(event => event.subject === subject);
  if (!found) throw new Error(`"${subject}" never listed`);
  return found.id;
}

const utc = (iso: string) => ({ dateTime: iso.replace(/Z$/, ""), timeZone: "UTC" });

describe.skipIf(!live)("calendar", { timeout: 180_000 }, () => {
  let team: CalendarInfo;
  let teamSync: string;
  let teamPrivate: string;
  let mainEvent: string;
  let sarahBusy: string;

  beforeAll(async () => {
    const everything = await bindCalendar("phillip", "https://outlook.office.com/calendar/");
    const calendars = unwrap<CalendarInfo[]>(await run(facet("setup"), everything, [["listCalendars"]]));
    team = calendars.find(calendar => calendar.name === TEAM_NAME)!;
    expect(team, `Phillip has no "${TEAM_NAME}" calendar`).toBeDefined();
    const teamPath = `/me/calendars/${encodeURIComponent(team.id)}`;
    teamSync = await makeEvent("phillip", teamPath, { subject: "Team sync", start: utc(at(17)), end: utc(at(17, 30)), location: { displayName: "Room 4" }, body: { contentType: "HTML", content: "<p>Agenda: <b>roadmap</b></p>" } });
    teamPrivate = await makeEvent("phillip", teamPath, { subject: "Team private", start: utc(at(19)), end: utc(at(20)), sensitivity: "private" });
    mainEvent = await makeEvent("phillip", "/me/calendar", { subject: "Main calendar only", start: utc(at(21)), end: utc(at(21, 30)) });
    sarahBusy = await makeEvent("sarah", "/me/calendar", { subject: "Sarah busy secret", start: utc(at(18)), end: utc(at(19)) });
  });

  afterAll(async () => {
    for (const { label, id } of made) await hooks().graph(await connect(label), "DELETE", `/me/events/${encodeURIComponent(id)}`);
  });

  it("an all-calendars binding sees every calendar, private events included, and says which each is in", async () => {
    const props = await bindCalendar("phillip", "https://outlook.office.com/calendar/view/week");
    expect(props.scope).toEqual({ kind: "all", access: "schedule" });
    const name = facet("all");
    const overview = unwrap<CalendarOverview>(await run(name, props, [["getOverview"]]));
    expect(overview).toMatchObject({ kind: "all", details: "full", access: "schedule" });
    expect(overview.timeZone).toBeTruthy();
    const listed = await events(name, props);
    const byId = new Map(listed.map(event => [event.id, event]));
    expect(byId.get(teamSync)).toMatchObject({ subject: `Team sync ${RUN}`, calendarId: team.id, location: "Room 4" });
    expect(byId.get(teamPrivate)).toMatchObject({ subject: `Team private ${RUN}`, sensitivity: "private" });
    expect(byId.get(mainEvent)).toBeDefined();
    const content = unwrap<EventContent>(await run(name, props, [["getEvent", teamSync]]));
    expect(content.body).toContain("**roadmap**");
    // Someone else's event, by its real ID, isn't reachable through the user's own binding.
    expect(failure(await run(name, props, [["getEvent", sarahBusy]]))).toMatch(OUTSIDE);
  });

  it("a calendar binding covers that calendar alone, and shows its private events as busy time", async () => {
    const props = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?access=read`);
    expect(props.scope).toMatchObject({ kind: "calendar", calendar: { id: team.id, name: TEAM_NAME }, details: "full", privateEvents: "busy", access: "read" });
    const name = facet("team");
    const listed = await events(name, props);
    expect(listed.map(event => event.id)).toEqual(expect.arrayContaining([teamSync, teamPrivate]));
    expect(listed.map(event => event.id)).not.toContain(mainEvent);
    const hidden = listed.find(event => event.id === teamPrivate)!;
    expect(hidden).toEqual({ id: teamPrivate, start: expect.any(String), end: expect.any(String), allDay: false, showAs: "busy", private: true });
    expect(failure(await run(name, props, [["getEvent", mainEvent]]))).toMatch(OUTSIDE);
    expect(failure(await run(name, props, [["getEvent", sarahBusy]]))).toMatch(OUTSIDE);
    expect(JSON.stringify((await hooks().queueLog(name)).observations)).not.toContain("Team private");
    // A read binding has no write methods.
    expect(failure(await run(name, props, [["createEvent", { subject: "x", start: at(9), end: at(10) }]]))).toMatch(/createEvent|not a function|undefined/);
  });

  it("free/busy and limited bindings reveal only what their level allows", async () => {
    const freeBusy = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?details=freeBusy`);
    expect(freeBusy.scope.access).toBe("read");
    const fb = await events(facet("team-fb"), freeBusy);
    const sync = fb.find(event => event.id === teamSync)!;
    expect(Object.keys(sync).toSorted()).toEqual(["allDay", "end", "id", "showAs", "start"]);
    const limited = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?details=limited`);
    const name = facet("team-limited");
    const lim = await events(name, limited);
    expect(lim.find(event => event.id === teamSync)).toMatchObject({ subject: `Team sync ${RUN}`, location: "Room 4" });
    expect(lim.find(event => event.id === teamSync)).not.toHaveProperty("attendees");
    expect(unwrap<EventContent>(await run(name, limited, [["getEvent", teamSync]])).body).toBe("");
    const editable = `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?details=limited&access=edit`;
    expect(failure(await hooks().resolveCalendar(await connect("phillip"), editable))).toMatch(/full details/);
  });

  it("observers: a calendar binding is shared only with people its calendar is shared with, at that level", async () => {
    const full = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?access=read`);
    const name = facet("observe-full");
    await events(name, full);
    unwrap(await hooks().addObserver(name, full, "sarah", await connect("sarah")));
    expect(failure(await hooks().addObserver(name, full, "bob", await connect("bob")))).toBeTruthy();

    const freeBusy = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?details=freeBusy`);
    const fbName = facet("observe-fb");
    await events(fbName, freeBusy);
    unwrap(await hooks().addObserver(fbName, freeBusy, "sarah", await connect("sarah")));
    unwrap(await hooks().addObserver(fbName, freeBusy, "bob", await connect("bob")));

    // Showing private events is for the owner and private-access delegates alone.
    const shown = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?private=show&access=read`);
    const shownName = facet("observe-private");
    const withPrivate = await events(shownName, shown);
    expect(withPrivate.find(event => event.id === teamPrivate)).toMatchObject({ subject: `Team private ${RUN}` });
    expect(failure(await hooks().addObserver(shownName, shown, "sarah", await connect("sarah")))).toBeTruthy();

    // The main calendar's organization-wide free/busy admits colleagues at free/busy, and no further.
    const mainFb = await bindCalendar("phillip", "https://outlook.office.com/calendar/default?details=freeBusy");
    const mainName = facet("observe-main");
    await events(mainName, mainFb);
    unwrap(await hooks().addObserver(mainName, mainFb, "bob", await connect("bob")));
    const mainLimited = await bindCalendar("phillip", "https://outlook.office.com/calendar/default?details=limited");
    const limitedName = facet("observe-main-limited");
    await events(limitedName, mainLimited);
    expect(failure(await hooks().addObserver(limitedName, mainLimited, "bob", await connect("bob")))).toBeTruthy();

    // An all-calendars binding that has read events is the user's alone.
    const all = await bindCalendar("phillip", "https://outlook.office.com/calendar/?access=read");
    const allName = facet("observe-all");
    await events(allName, all);
    expect(failure(await hooks().addObserver(allName, all, "sarah", await connect("sarah")))).toBeTruthy();
  });

  it("an availability binding reads colleagues' busy time without subjects, and finds time everyone is free", async () => {
    const props = await bindCalendar("phillip", "https://outlook.office.com/calendar/availability");
    expect(props.scope).toEqual({ kind: "availability", access: "read" });
    const name = facet("availability");
    expect(failure(await run(name, props, [["listEvents", WINDOW]]))).toMatch(/availability only/);
    const [sarah, stranger] = unwrap<Availability[]>(await run(name, props, [["getAvailability", [address("sarah"), `nobody-${RUN}@${address("sarah").split("@")[1]}`], WINDOW.start, WINDOW.end]]));
    expect(JSON.stringify(sarah)).not.toContain("secret");
    expect(sarah!.busy.some(block => Date.parse(block.start) <= Date.parse(at(18)) && Date.parse(block.end) >= Date.parse(at(19)))).toBe(true);
    expect(stranger!.error).toBeTruthy();

    const free = unwrap<FreeTimes>(await run(name, props, [["findFreeTimes", { people: [address("sarah"), address("bob")], duration: 30, start: at(15), end: at(23), workingHoursOnly: false }]]));
    expect(free.slots.length).toBeGreaterThan(0);
    // Not while Sarah is busy, nor while Phillip is. Exchange's free/busy is the main calendar's
    // alone, so his team sync doesn't count, and that free time is offered.
    for (const slot of free.slots) {
      expect(Date.parse(slot.end) <= Date.parse(at(18)) || Date.parse(slot.start) >= Date.parse(at(19))).toBe(true);
      expect(Date.parse(slot.end) <= Date.parse(at(21)) || Date.parse(slot.start) >= Date.parse(at(21, 30))).toBe(true);
    }
    expect(free.slots.some(slot => Date.parse(slot.start) <= Date.parse(at(17)) && Date.parse(slot.end) >= Date.parse(at(17, 30)))).toBe(true);
    // Whoever is told what this read shows must be able to see those people's free/busy themselves.
    unwrap(await hooks().addObserver(name, props, "bob", await connect("bob")));
  });

  // Fixture: Bob shares nothing with the organization, not even free/busy.
  it("someone who shares nothing reads as unknown, never as free, and nobody else is admitted to their time", async () => {
    const props = await bindCalendar("phillip", "https://outlook.office.com/calendar/availability");
    const name = facet("availability-hidden");
    const [bob] = unwrap<Availability[]>(await run(name, props, [["getAvailability", [address("bob")], WINDOW.start, WINDOW.end]]));
    expect(bob!.error).toBeTruthy();
    expect(bob!.busy).toEqual([]);
    const free = unwrap<FreeTimes>(await run(name, props, [["findFreeTimes", { people: [address("bob")], duration: 30, start: at(15), end: at(23), workingHoursOnly: false }]]));
    expect(free.unknown?.map(entry => entry.address)).toEqual([address("bob")]);

    // Bob's own busy time is his to show: Sarah can't see it, so she can't observe a read of it.
    const own = await bindCalendar("bob", "https://outlook.office.com/calendar/availability");
    const ownName = facet("availability-own");
    const [himself] = unwrap<Availability[]>(await run(ownName, own, [["getAvailability", [address("bob")], WINDOW.start, WINDOW.end]]));
    expect(himself!.error).toBeUndefined();
    expect(failure(await hooks().addObserver(ownName, own, "sarah", await connect("sarah")))).toBeTruthy();
    const main = await bindCalendar("bob", "https://outlook.office.com/calendar/default?details=freeBusy");
    const mainName = facet("observe-bob-main");
    await events(mainName, main);
    expect(failure(await hooks().addObserver(mainName, main, "sarah", await connect("sarah")))).toBeTruthy();
  });

  it("writes: create, read back pending, apply, change, refuse a stale change, delete, and revert", async () => {
    const props = await bindCalendar("phillip", `https://outlook.office.com/calendar/id/${encodeURIComponent(team.id)}?access=edit`);
    const name = facet("writes");
    const pending = unwrap<EventInfo>(await run(name, props, [["createEvent", { subject: `Planning ${RUN}`, start: at(22), end: at(22, 45), location: "Room 9", body: "Bring the **numbers**." }]]));
    expect(pending).toMatchObject({ id: expect.stringMatching(/^~/), pending: "create" });
    expect((await events(name, props)).map(event => event.id)).toContain(pending.id);
    const created = await approveLast(name, props);
    expect(created.description.title).toContain("Planning");
    const real = unwrap<EventContent>(await run(name, props, [["getEvent", pending.id]]));
    expect(real.id).not.toMatch(/^~/);
    made.push({ label: "phillip", id: real.id });
    expect(real.body).toContain("**numbers**");
    expect(real).toMatchObject({ location: "Room 9", start: expect.any(String) });
    expect(Date.parse(real.end) - Date.parse(real.start)).toBe(45 * 60_000);

    unwrap(await run(name, props, [["updateEvent", real.id, { subject: `Planning (moved) ${RUN}`, start: at(23) }]]));
    const moved = await approveLast(name, props);
    const after = unwrap<EventContent>(await run(facet("writes-check"), props, [["getEvent", real.id]]));
    expect(after).toMatchObject({ subject: `Planning (moved) ${RUN}` });
    expect(Date.parse(after.start)).toBe(Date.parse(at(23)));
    unwrap(await hooks().revertAction(name, props, moved.actionId));
    const reverted = unwrap<EventContent>(await run(facet("writes-check"), props, [["getEvent", real.id]]));
    expect(reverted.subject).toBe(`Planning ${RUN}`);
    expect(Date.parse(reverted.start)).toBe(Date.parse(at(22)));

    // Changed in Outlook after the agent proposed: nothing is overwritten.
    unwrap(await run(name, props, [["updateEvent", real.id, { location: "Room 10" }]]));
    unwrap(await hooks().graph(props.userObjectId, "PATCH", `/me/events/${encodeURIComponent(real.id)}`, { location: { displayName: "Room 11" } }));
    expect(failure(await hooks().applyAction(name, props, (await lastSubmitted(name)).actionId))).toMatch(/changed after this was proposed/);

    unwrap(await run(name, props, [["deleteEvent", real.id]]));
    expect((await events(name, props)).map(event => event.id)).not.toContain(real.id);
    const deleted = await approveLast(name, props);
    expect(failure(await run(facet("writes-check"), props, [["getEvent", real.id]]))).toMatch(OUTSIDE);
    unwrap(await hooks().revertAction(name, props, deleted.actionId));
    const back = (await events(facet("writes-check"), props)).filter(event => event.subject === `Planning ${RUN}`);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ location: "Room 11" });
    made.push({ label: "phillip", id: back[0]!.id });
  });

  it("meetings: an invitation reaches Sarah, she answers it, and the organizer cancels it", async () => {
    const phillip = await bindCalendar("phillip", "https://outlook.office.com/calendar/");
    const name = facet("meeting");
    expect(unwrap<{ tag: string }[]>(await hooks().autoApprovable(name, phillip)).map(kind => kind.tag)).not.toContain("calendar.invitations");
    unwrap(await run(name, phillip, [["createEvent", { subject: `Kickoff ${RUN}`, start: at(16), end: at(16, 30), attendees: [address("sarah"), "someone.new@example.com"] }]]));
    const proposed = await lastSubmitted(name);
    expect(JSON.stringify(proposed.description)).toContain("outside your organization");
    // Reject rather than invite a stranger; then invite Sarah alone.
    unwrap(await hooks().rejectAction(name, phillip, proposed.actionId));
    const pending = unwrap<EventInfo>(await run(name, phillip, [["createEvent", { subject: `Kickoff ${RUN}`, start: at(16), end: at(16, 30), attendees: [address("sarah")] }]]));
    await approveLast(name, phillip);
    const meeting = unwrap<EventContent>(await run(name, phillip, [["getEvent", pending.id]]));
    made.push({ label: "phillip", id: meeting.id });
    expect(meeting).toMatchObject({ isOrganizer: true, attendees: [expect.objectContaining({ address: expect.stringMatching(new RegExp(`^${address("sarah")}$`, "i")) })] });

    const sarah = await bindCalendar("sarah", "https://outlook.office.com/calendar/");
    const sarahName = facet("meeting-sarah");
    const invitation = (await eventually(sarahName, sarah, listed => listed.some(event => event.subject === `Kickoff ${RUN}`)))
      .find(event => event.subject === `Kickoff ${RUN}`)!;
    expect(invitation).toMatchObject({ isOrganizer: false, response: "notResponded", organizer: { address: expect.stringMatching(new RegExp(address("phillip"), "i")) } });
    made.push({ label: "sarah", id: invitation.id });
    expect(failure(await run(sarahName, sarah, [["updateEvent", invitation.id, { subject: "Mine now" }]]))).toMatch(/Only the organizer/);
    expect(failure(await run(sarahName, sarah, [["deleteEvent", invitation.id]]))).toMatch(/decline/);
    const answered = unwrap<EventInfo>(await run(sarahName, sarah, [["respond", invitation.id, "accept", { message: `See you ${RUN}` }]]));
    expect(answered).toMatchObject({ response: "accepted", pending: "respond" });
    await approveLast(sarahName, sarah);

    const accepted = await (async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const now = unwrap<EventContent>(await run(facet("meeting-check"), phillip, [["getEvent", meeting.id]]));
        if (now.attendees?.[0]?.response === "accepted") return now;
        await new Promise(resolve => setTimeout(resolve, 2_000));
      }
      return null;
    })();
    expect(accepted, "Sarah's acceptance never reached Phillip").not.toBeNull();

    unwrap(await run(name, phillip, [["deleteEvent", meeting.id, { message: "Moving this" }]]));
    const cancel = await lastSubmitted(name);
    expect(JSON.stringify(cancel.description).toLowerCase()).toContain(address("sarah").toLowerCase());
    await approveLast(name, phillip);
    const cancelled = (await eventually(sarahName, sarah, listed => listed.some(event => event.id === invitation.id && event.cancelled)))
      .find(event => event.id === invitation.id);
    expect(cancelled).toMatchObject({ cancelled: true });
  });
});
