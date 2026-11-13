// Behavior tests for how long the Google Doc, Calendar and BigQuery sessions hold their approval
// queue. The Workshop counts a collaborator live for as long as any stub to the queue a session was
// started with survives, so each session must release its duplicate when the client disposes it.

import {env, RpcStub, RpcTarget} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {
  ActionDescription, GitCache, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {
  BigQueryGatekeeperImpl, GoogleCalendarGatekeeperImpl, GoogleDocGatekeeperImpl,
} from "../../src/google";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  BigQueryGatekeeperImpl: DurableObjectNamespace<BigQueryGatekeeperImpl>;
  GoogleCalendarGatekeeperImpl: DurableObjectNamespace<GoogleCalendarGatekeeperImpl>;
  GoogleDocGatekeeperImpl: DurableObjectNamespace<GoogleDocGatekeeperImpl>;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

/** A queue that records when its last stub goes away, which is when the kernel's `leave` runs. */
class ReleaseTrackingQueue extends RpcTarget {
  readonly observations: ObservationDescription[] = [];
  released = false;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(_action: number, _description: ActionDescription): Promise<void> {
    throw new Error("Unexpected action submission");
  }

  // Untyped as the gatekeeper's own test queue is: the generic `ApprovalQueue.bindHook()` does not
  // survive the stub types of a Durable Object call.
  async bindHook(): Promise<void> {
    throw new Error("Unexpected hook binding");
  }

  [Symbol.dispose](): void {
    this.released = true;
  }
}

/** A connected Google account whose stored access token is `token`. */
async function account(name: string, token: string): Promise<string> {
  const accountId = testEnv.UserAccount.idFromName(`${name}-${token}`);
  await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", `${token}-refresh`);
    state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
  });
  return accountId.toString();
}

/**
 * Start a session through the gatekeeper facet with a fresh queue, dropping the test's own stub to
 * it, then read while holding the session: the read authorizes through the queue, which stays held.
 * Disposing the session must then release the queue.
 */
async function expectReleasedOnDispose<Session extends Disposable>(
    start: (queue: RpcStub<ReleaseTrackingQueue>) => Promise<Session>,
    read: (session: Session) => Promise<unknown>,
): Promise<void> {
  const queue = new ReleaseTrackingQueue();
  const queueStub = new RpcStub(queue);
  const session = await start(queueStub);
  queueStub[Symbol.dispose]();
  await read(session);
  // A second read round-trips through the facet after the test's stub is gone, so a release the
  // session failed to hold off would have landed by now.
  await read(session);
  expect(queue.observations).toHaveLength(2);
  expect(queue.released).toBe(false);
  session[Symbol.dispose]();
  await vi.waitFor(() => expect(queue.released).toBe(true));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("approval queue release", () => {
  it("Google Doc sessions release their queue once disposed, and not before", async () => {
    const key = `release-${crypto.randomUUID()}`;
    const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(key));
    const id = testEnv.GoogleDocGatekeeperImpl.idFromName(key).toString();
    await expectReleasedOnDispose(
      queue => hook.startDocSessionWith(`doc-${key}`, id, {creation: {title: "Draft"}}, queue),
      session => session.getMetadata());
  });

  it("Google Calendar sessions release their queue once disposed, and not before", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      return url.pathname.endsWith("/events")
        ? Response.json({items: []})
        : Response.json({error: {code: 404}}, {status: 404});
    });
    const key = `release-${crypto.randomUUID()}`;
    const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(key));
    const id = testEnv.GoogleCalendarGatekeeperImpl.idFromName(key).toString();
    const props = {
      userObjectId: await account(key, "owner"), calendarId: "team@example.com",
      availabilityMode: "thisCalendar" as const,
    };
    await expectReleasedOnDispose(
      queue => hook.startCalendarSessionWith(`calendar-${key}`, id, props, queue),
      session => session.listEvents({
        timeMin: new Date("2026-11-03T00:00:00Z"), timeMax: new Date("2026-11-04T00:00:00Z"),
      }));
  });

  it("BigQuery sessions release their queue once disposed, and not before", async () => {
    const key = `release-${crypto.randomUUID()}`;
    const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(key));
    const id = testEnv.BigQueryGatekeeperImpl.idFromName(key).toString();
    const props = {userObjectId: await account(key, "owner"), scopedProjectId: "proj"};
    await expectReleasedOnDispose(
      queue => hook.startBigQuerySessionWith(`bigquery-${key}`, id, props, queue),
      session => session.getProject());
  });
});
