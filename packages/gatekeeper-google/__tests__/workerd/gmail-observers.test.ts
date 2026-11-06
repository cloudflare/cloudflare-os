// Behavior tests for the Gmail gatekeeper's observer checks: the mailbox owner's account every read
// reports as a subresource, and how verifyObserverAccess() answers for it. Google is faked at the
// fetch layer, naming each caller's account by its token.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {GmailGatekeeperImplProps} from "../../src/gmail";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GmailGatekeeperImpl: DurableObjectNamespace;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const OWNER_TOKEN = "owner-token";
/** The subresource the owner's mailbox reads report. */
const OWNER = "gmail/user/owner-subject";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

type Observation = {title: string; subresources?: string[]};

/** The fake Google's per-token state, which tests set. */
type GoogleBackend = {
  /** The Google account subject behind each token. */
  subjects: Map<string, string>;
  /** Tokens whose userinfo lookups fail as an outage would. */
  failing: Set<string>;
};

/**
 * Google as far as these reads use it: userinfo names the account behind each token in `subjects`,
 * failing with 500 for a token in `failing`, and the mailbox holds one message, `abc123`.
 */
function googleBackend(): GoogleBackend {
  const subjects = new Map([[OWNER_TOKEN, "owner-subject"]]);
  const failing = new Set<string>();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      if (failing.has(token)) return json({error: "backend_error"}, 500);
      const sub = subjects.get(token);
      if (!sub) throw new Error(`Unexpected token: ${token}`);
      return json({sub, email: `${sub}@example.com`});
    }
    if (url.pathname === "/gmail/v1/users/me/messages/abc123") {
      return json({
        id: "abc123", threadId: "def456", internalDate: "1", labelIds: ["INBOX"],
        payload: {headers: [
          {name: "From", value: "sender@example.com"}, {name: "To", value: "owner-subject@example.com"},
          {name: "Subject", value: "Quarterly numbers"}, {name: "Message-ID", value: "<abc123@example.com>"},
        ]},
      });
    }
    if (url.pathname === "/gmail/v1/users/me/labels") return json({labels: []});
    throw new Error(`Unexpected request: ${url}`);
  });
  return {subjects, failing};
}

function gmailHarness(backend: GoogleBackend) {
  const name = `gmail-observers-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GmailGatekeeperImpl.idFromName(name).toString();
  const facetName = `gmail-${name}`;
  const queueId = `queue-${name}`;
  /** A connected Google account whose stored access token is `token`. */
  const account = async (token: string): Promise<string> => {
    const accountId = testEnv.UserAccount.idFromName(`${name}-${token}`);
    await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
      state.storage.kv.put("refreshToken", `${token}-refresh`);
      state.storage.kv.put("accessToken", {token, expires: new Date(Date.now() + 3_600_000)});
    });
    return accountId.toString();
  };
  const props = account(OWNER_TOKEN).then((userObjectId): GmailGatekeeperImplProps => ({userObjectId}));
  return {
    /** Start a session on the owner's mailbox, returning a way to run operations through it. */
    session: async () => {
      await hook.startSession(facetName, id, await props, queueId);
      return async (operation: string, args: unknown[] = []) =>
        hook.runSessionOperation(facetName, id, await props, queueId, operation, args);
    },
    observations: async (): Promise<Observation[]> => {
      const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
      return observations as Observation[];
    },
    /** An observer's connected account, which Google identifies as `subject`. */
    observer: (token: string, subject: string): Promise<string> => {
      backend.subjects.set(token, subject);
      return account(token);
    },
    verify: async (observers: Array<{id: string; userObjectId: string}>, subresources: string[]) =>
      hook.gmailVerifyObserverAccess(facetName, id, await props, observers, subresources),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail observations", () => {
  it("report the mailbox owner's account, from the session and the capabilities it hands out", async () => {
    const gmail = gmailHarness(googleBackend());
    const run = await gmail.session();
    expect(await run("session.getMailboxAddress")).toEqual({address: "owner-subject@example.com"});
    expect(await run("message.getMetadata", ["abc123"])).toMatchObject({subject: "Quarterly numbers"});

    const observations = await gmail.observations();
    expect(observations.map(observation => observation.title))
      .toEqual(["Read Gmail mailbox address", "Gmail message: Quarterly numbers"]);
    for (const observation of observations) expect(observation.subresources).toEqual([OWNER]);
  });
});

describe("Gmail verifyObserverAccess", () => {
  it("allows only observers whose account is the mailbox owner's Google account", async () => {
    const gmail = gmailHarness(googleBackend());
    const observers = [
      // The owner, through another connection to the same Google account.
      {id: "owner", userObjectId: await gmail.observer("owner-again-token", "owner-subject")},
      {id: "colleague", userObjectId: await gmail.observer("colleague-token", "colleague-subject")},
    ];
    expect(await gmail.verify(observers, [OWNER])).toEqual({allowedObserverIds: ["owner"]});
  });

  it("refuses the whole call for an ID that does not name a Gmail user", async () => {
    const gmail = gmailHarness(googleBackend());
    const observers = [{id: "owner", userObjectId: await gmail.observer("owner-again-token", "owner-subject")}];
    for (const id of [
      "gmail/user/owner%2Dsubject",
      "gmail/inbox/owner-subject",
      "gmail/user/owner-subject/label/INBOX",
      "user/owner-subject",
      "drive/user/owner-subject",
      // Other Google gatekeepers' IDs, which the observer's account could check.
      "calendar/freeBusy/alice%40example.com",
      "bigquery/project/proj/dataset/sales",
    ]) {
      await expect(gmail.verify(observers, [OWNER, id]), id).rejects.toThrow(/subresource ID/);
    }
  });

  it("fails the whole call when an observer's account cannot be identified", async () => {
    const backend = googleBackend();
    const gmail = gmailHarness(backend);
    const observers = [
      {id: "owner", userObjectId: await gmail.observer("owner-again-token", "owner-subject")},
      {id: "flaky", userObjectId: await gmail.observer("flaky-token", "owner-subject")},
    ];
    backend.failing.add("flaky-token");
    await expect(gmail.verify(observers, [OWNER])).rejects.toThrow(/Failed to fetch user info: 500/);
  });
});
