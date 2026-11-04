// What the Google Calendar gatekeeper submits for review: every action carries a kind the user can
// opt into auto-approving, and the catalog lists exactly those kinds.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {
  GoogleCalendarGatekeeperImpl, GoogleCalendarGatekeeperImplProps, UserAccount,
} from "../../src/google";
import type {CalendarEventDraft} from "../../src/calendar-types";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GoogleCalendarGatekeeperImpl: DurableObjectNamespace<GoogleCalendarGatekeeperImpl>;
  UserAccount: DurableObjectNamespace<UserAccount>;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const BOUND = "team@group.calendar.google.com";
const CREATE = {tag: "calendarCreateEvent", label: "Create calendar events"};
const UPDATE = {tag: "calendarUpdateEvent", label: "Update calendar events"};

function calendarHarness() {
  // Nothing these tests do should reach Google.
  vi.stubGlobal("fetch", async () => new Response(null, {status: 500}));

  const name = `calendar-actions-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GoogleCalendarGatekeeperImpl.idFromName(name).toString();
  const facetName = `calendar-${name}`;
  const queueId = `queue-${crypto.randomUUID()}`;
  const ready = (async () => {
    const accountId = testEnv.UserAccount.idFromName(name);
    await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", "owner-refresh");
      state.storage.kv.put("accessToken", {token: "owner", expires: new Date(Date.now() + 3_600_000)});
    });
    const props: GoogleCalendarGatekeeperImplProps = {
      userObjectId: accountId.toString(), calendarId: BOUND, availabilityMode: "thisCalendar",
    };
    await hook.calendarStartSession(facetName, id, props, queueId);
    return props;
  })();

  return {
    session: async () => hook.openCalendarSession(facetName, id, await ready, queueId),
    autoApprovable: async () => hook.calendarAutoApprovableActions(facetName, id, await ready),
    submissions: async () => {
      await ready;
      const {submissions} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return submissions.map(submission => submission.description as Record<string, unknown>);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Calendar actions", () => {
  it("lists creating and updating events as auto-approvable kinds", async () => {
    const calendar = calendarHarness();
    expect(await calendar.autoApprovable()).toEqual([CREATE, UPDATE]);
  });

  it("submits every event creation as auto-approvable, including ones that notify attendees", async () => {
    const calendar = calendarHarness();
    using session = await calendar.session();
    const event: CalendarEventDraft = {
      title: "Planning",
      start: {kind: "dateTime", dateTime: new Date("2026-11-05T15:00:00Z")},
      end: {kind: "dateTime", dateTime: new Date("2026-11-05T16:00:00Z")},
      attendees: [{email: "alice@example.com"}],
    };

    await session.createEvent(event);
    await session.createEvent(event, {sendUpdates: "none"});

    const submissions = await calendar.submissions();
    expect(submissions).toHaveLength(2);
    for (let description of submissions) {
      expect(description).toMatchObject({actionKind: CREATE, autoApprovable: true, implementsRevert: true});
    }
  });

  it("submits every event update as auto-approvable, including ones that notify attendees", async () => {
    const calendar = calendarHarness();
    using session = await calendar.session();

    await session.updateEvent("standup", {title: "Standup (moved)"});
    await session.updateEvent("standup", {location: "Room 2"}, {sendUpdates: "externalOnly"});

    const submissions = await calendar.submissions();
    expect(submissions).toHaveLength(2);
    for (let description of submissions) {
      expect(description).toMatchObject({actionKind: UPDATE, autoApprovable: true, implementsRevert: true});
    }
  });
});
