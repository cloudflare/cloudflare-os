// The requests this gatekeeper sends to Slack, the name each is counted under, and how an answer
// is counted where its status does not say. A call's name is the literal at its call site, so
// these drive the real client against a stubbed fetch and read the points it writes.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import {
  SLACK_METHODS, SlackApi, SlackApiError, exchangeAuthCode, refreshAccessToken, revokeToken, slackUpstream,
} from "./slack-api";

const API = "https://slack.com/api";
const TOKEN_OPERATIONS = ["token.exchange", "token.refresh", "token.revoke"];

// Each kind of request the gatekeeper makes: its HTTP method, its URL and the name it is counted
// under.
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${API}/auth.test`, "auth.test"],
  ["GET", `${API}/auth.teams.list`, "auth.teams.list"],
  ["GET", `${API}/team.info`, "team.info"],
  ["GET", `${API}/users.info`, "users.info"],
  ["GET", `${API}/users.list`, "users.list"],
  ["GET", `${API}/users.conversations`, "users.conversations"],
  ["GET", `${API}/conversations.list`, "conversations.list"],
  ["GET", `${API}/conversations.info`, "conversations.info"],
  ["GET", `${API}/conversations.members`, "conversations.members"],
  ["GET", `${API}/conversations.history`, "conversations.history"],
  ["GET", `${API}/conversations.replies`, "conversations.replies"],
  ["GET", `${API}/search.messages`, "search.messages"],
  ["POST", `${API}/oauth.v2.access`, "token.exchange"],
  ["POST", `${API}/oauth.v2.access`, "token.refresh"],
  ["POST", `${API}/auth.revoke`, "token.revoke"],
];

type Point = { blobs?: unknown[]; doubles?: unknown[] };

const ambient = env as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
let points: Point[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void points.push(point) };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A written point's value in one column.
function column(point: Point, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its operation, outcome, reason and HTTP status.
function counted() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// How many calls were counted under each operation, a point of summed calls standing for several.
function callsByOperation() {
  const calls = new Map<unknown, number>();
  for (const point of points) {
    const operation = column(point, SUBSERVICE_V1_SLOTS.operation);
    calls.set(operation, (calls.get(operation) ?? 0) + Number(column(point, SUBSERVICE_V1_SLOTS.calls)));
  }
  return calls;
}

// One request the stubbed fetch was handed.
type Sent = { method: string; url: URL; init: RequestInit };

// A global fetch that answers every request with what `answerOf` gives, and the requests sent.
function answering(answerOf: (sent: Sent) => Response): Sent[] {
  const requests: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const sent = { method: init.method ?? "GET", url: new URL(input), init };
    requests.push(sent);
    return answerOf(sent);
  });
  return requests;
}

// The method and the URL without its query of each request sent, as the rows of `REQUESTS` have
// them.
function rowsOf(requests: Sent[]) {
  return requests.map(({ method, url }) => [method, url.origin + url.pathname]);
}

// What a fake Slack answers one Web API method with, from the request's parameters.
type Answers = Record<string, (params: URLSearchParams) => Record<string, unknown>>;

// A Slack with one workspace of an Enterprise organisation, answering every Web API method this
// gatekeeper calls, with `overrides` in place of its own answer for the methods they name.
function fakeSlack(overrides: Answers = {}): Sent[] {
  const message = { ts: "1700000000.000100", user: "WSELF", text: "hello" };
  const answers: Answers = {
    "auth.test": () => ({ team_id: "EORG", user_id: "WSELF", is_enterprise_install: true }),
    "auth.teams.list": () => ({ teams: [{ id: "TONE", name: "One" }] }),
    "team.info": () => ({ team: { id: "TONE", name: "One", domain: "one" } }),
    "users.info": params => ({
      user: { id: params.get("user"), name: "self", enterprise_user: { teams: ["TONE"] } },
    }),
    "users.list": () => ({ members: [{ id: "WSELF", name: "self" }] }),
    "users.conversations": () => ({ channels: [{ id: "DONE", is_im: true, user: "WPEER" }] }),
    "conversations.list": () => ({ channels: [{ id: "CONE" }] }),
    // A channel that names no workspace, which the listing then has to prove.
    "conversations.info": params => ({ channel: { id: params.get("channel"), name: "general" } }),
    "conversations.members": () => ({ members: ["WSELF"] }),
    "conversations.history": () => ({ messages: [message] }),
    "conversations.replies": () => ({ messages: [message] }),
    "search.messages": () => ({
      messages: { matches: [{ ...message, channel: { id: "CONE" } }], paging: { page: 1, pages: 1 } },
    }),
    ...overrides,
  };
  return answering(({ url }) => {
    const answer = answers[url.pathname.slice("/api/".length)];
    if (!answer) throw new Error(`Unexpected Slack request: ${url.pathname}`);
    return Response.json({ ok: true, ...answer(url.searchParams) });
  });
}

const unbound = () => new SlackApi(async () => "user-token");

// How many calls each point written for `operation` stands for, in the order they were written.
function callsOf(operation: string) {
  return points.filter(point => column(point, SUBSERVICE_V1_SLOTS.operation) === operation)
      .map(point => column(point, SUBSERVICE_V1_SLOTS.calls));
}

// How many times each name occurs in `names`.
function countsOf(names: string[]) {
  const counts = new Map<unknown, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

// How many requests of the Web API method `method` were sent.
function sentOf(requests: Sent[], method: string) {
  return rowsOf(requests).filter(([, url]) => url === `${API}/${method}`).length;
}

// The answer of a listing whose pages are `pages`, each named by the cursor that asks for it: the
// first by none, and each next one by its place.
function pageOf(params: URLSearchParams, key: string, pages: unknown[][]) {
  const at = Number(params.get("cursor") ?? 0);
  return { [key]: pages[at], response_metadata: { next_cursor: at + 1 < pages.length ? String(at + 1) : "" } };
}

describe("the names of Slack requests", () => {
  it("lists every Web API method and every token request once in the table", () => {
    expect(REQUESTS.map(([, , name]) => name).toSorted())
        .toEqual([...SLACK_METHODS, ...TOKEN_OPERATIONS].toSorted());
  });

  it("counts each Web API call under its method, and calls every method", async () => {
    const requests = fakeSlack();
    const api = unbound().forWorkspace("TONE");

    await api.getWorkspaceInfo();
    await api.listUsers(undefined, 10);
    await api.listUserConversations(["im"], undefined, 10);
    await api.listConversationMembers("CONE", undefined, 10);
    await api.listHistory("CONE", undefined, 10);
    await api.listReplies("CONE", "1700000000.000100", undefined, 10);
    await api.searchMessages("hello", undefined, 10);

    // Every request sent is a row of the table, and is counted under that row's name.
    const sentByName = new Map<unknown, number>();
    for (const [method, url] of rowsOf(requests)) {
      const row = REQUESTS.find(([rowMethod, rowUrl]) => rowMethod === method && rowUrl === url);
      expect(row, `${method} ${url}`).toBeDefined();
      sentByName.set(row?.[2], (sentByName.get(row?.[2]) ?? 0) + 1);
    }
    expect(callsByOperation()).toEqual(sentByName);
    expect([...sentByName.keys()].toSorted()).toEqual([...SLACK_METHODS].toSorted());
    for (const point of points) {
      expect(column(point, SUBSERVICE_V1_SLOTS.source)).toBe("gatekeeper.slack.api");
      expect(column(point, SUBSERVICE_V1_SLOTS.service)).toBe("slack");
      expect(column(point, COMMON_SLOTS.outcome)).toBe("success");
    }
    // No redirect is followed.
    expect(new Set(requests.map(({ init }) => init.redirect))).toEqual(new Set(["manual"]));
  });

  it.each<[string, () => Promise<unknown>, Record<string, unknown>]>([
    ["token.exchange", () => exchangeAuthCode("code", "client", "secret", "https://gatekeeper.example/oauth"),
      { authed_user: { id: "WSELF", access_token: "user-token" } }],
    ["token.refresh", () => refreshAccessToken("refresh-token", "client", "secret"),
      { access_token: "user-token" }],
    ["token.revoke", () => revokeToken("user-token"), {}],
  ])("counts the request of %s under that name", async (name, send, answer) => {
    const requests = answering(() => Response.json({ ok: true, ...answer }));

    await send();

    expect(rowsOf(requests)).toEqual(REQUESTS.filter(row => row[2] === name).map(([method, url]) => [method, url]));
    expect(counted()).toEqual([[name, "success", "", 200]]);
    expect(requests[0].init.redirect).toBe("manual");
  });

  it("takes no name from a URL: a request that is given none is named by its method", () => {
    for (const [method, url] of REQUESTS) expect(slackUpstream.operationOf(method, url)).toBe(method);
    expect(slackUpstream.operationOf("GET", `${API}/admin.users.list`)).toBe("GET");
  });
});

describe("an error inside a success", () => {
  it("counts a call that Slack fails with a 200 as an error of the API", async () => {
    const requests = answering(() => Response.json({ ok: false, error: "invalid_auth" }));

    await expect(unbound().authedUserId()).rejects.toMatchObject({ code: "invalid_auth", status: 200 });

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["auth.test", "error", "api", 200]]);
  });

  it("counts a rate limit that Slack names in a 200 as a refusal, and sends the call once", async () => {
    const requests = answering(() => Response.json({ ok: false, error: "ratelimited" }));

    await expect(unbound().authedUserId()).rejects.toMatchObject({ code: "ratelimited", status: 200 });

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["auth.test", "refused", "rate", 200]]);
  });

  it("counts a token request that Slack fails with a 200 as an error of the API", async () => {
    answering(({ url }) => Response.json({
      ok: false, error: url.pathname.endsWith("auth.revoke") ? "invalid_auth" : "invalid_grant",
    }));

    await expect(exchangeAuthCode("code", "client", "secret", "https://gatekeeper.example/oauth"))
        .rejects.toThrow("Slack OAuth exchange failed: invalid_grant");
    await expect(refreshAccessToken("refresh-token", "client", "secret")).resolves.toBeNull();
    await expect(revokeToken("user-token")).rejects.toMatchObject({ code: "invalid_auth", status: 200 });

    expect(counted()).toEqual(TOKEN_OPERATIONS.map(name => [name, "error", "api", 200]));
  });
});

// The exchange of a code and the refresh of a token, each with the form it posts and what it
// throws where Slack's answer holds no user token.
const GRANTS = {
  "token.exchange": {
    send: (): Promise<unknown> => exchangeAuthCode("code", "client", "secret", "https://gatekeeper.example/oauth"),
    form: "code=code&client_id=client&client_secret=secret"
        + "&redirect_uri=https%3A%2F%2Fgatekeeper.example%2Foauth&grant_type=authorization_code",
    tokenless: "Slack did not return a user token. Make sure the app requests user scopes (user_scope).",
    failed: (error: string) => `Slack OAuth exchange failed: ${error}`,
  },
  "token.refresh": {
    send: (): Promise<unknown> => refreshAccessToken("refresh-token", "client", "secret"),
    form: "client_id=client&client_secret=secret&grant_type=refresh_token&refresh_token=refresh-token",
    tokenless: "Slack token refresh returned no access token.",
    failed: (error: string) => `Slack token refresh failed: ${error}`,
  },
};

// Each request sent, as its method, its URL and its form.
function formsOf(requests: Sent[]) {
  return requests.map(({ method, url, init }) => [method, url.href, String(init.body)]);
}

// What `send` threw, or undefined where it threw nothing.
async function thrownBy(send: () => Promise<unknown>): Promise<unknown> {
  try {
    await send();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("a grant with no user token", () => {
  it.each<[keyof typeof GRANTS, string, Record<string, unknown>]>([
    ["token.exchange", "names no user", {}],
    ["token.exchange", "names a user that has no token", { authed_user: { id: "WSELF", scope: "search:read" } }],
    ["token.exchange", "names a user whose token is empty", { authed_user: { id: "WSELF", access_token: "" } }],
    ["token.exchange", "names a user whose token is null", { authed_user: { id: "WSELF", access_token: null } }],
    ["token.exchange", "names a user whose token is false", { authed_user: { id: "WSELF", access_token: false } }],
    ["token.exchange", "names a user whose token is 0", { authed_user: { id: "WSELF", access_token: 0 } }],
    ["token.exchange", "names null for its user", { authed_user: null }],
    // The token of the app's bot is at the top level, and is no user's.
    ["token.exchange", "holds a token at its top level alone", { access_token: "bot-token", token_type: "bot" }],
    ["token.refresh", "holds no token", {}],
    ["token.refresh", "holds an empty token", { access_token: "" }],
    ["token.refresh", "holds null for its token", { access_token: null }],
    ["token.refresh", "holds false for its token", { access_token: false }],
    ["token.refresh", "holds 0 for its token", { access_token: 0 }],
    // A refreshed user token is at the top level, and is read nowhere else.
    ["token.refresh", "holds a token under a user alone", { authed_user: { id: "WSELF", access_token: "user-token" } }],
  ])("counts %s an error of the API where a 200 that says ok %s, sent once and failing as the helper does", async (name, _lacking, answer) => {
    const { send, form, tokenless } = GRANTS[name];
    const requests = answering(() => Response.json({ ok: true, ...answer }));

    const failure = await thrownBy(send);

    expect(failure).toEqual(new Error(tokenless));
    expect(Object.getPrototypeOf(failure)).toBe(Error.prototype);
    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, form]]);
    expect(counted()).toEqual([[name, "error", "api", 200]]);
  });

  it("counts an exchange a success where the answer holds the user's token, and returns the grant", async () => {
    const requests = answering(() => Response.json({
      ok: true, access_token: "bot-token", team: { id: "TONE", name: "One" },
      authed_user: { id: "WSELF", access_token: "user-token", refresh_token: "next-refresh", scope: "search:read,users:read" },
    }));

    expect(await GRANTS["token.exchange"].send()).toMatchObject({
      accessToken: { token: "user-token" }, refreshToken: "next-refresh",
      grantedScopes: ["search:read", "users:read"], userId: "WSELF", teamId: "TONE", teamName: "One",
    });

    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, GRANTS["token.exchange"].form]]);
    expect(counted()).toEqual([["token.exchange", "success", "", 200]]);
  });

  it("counts a refresh a success where the answer holds a token, and returns the grant", async () => {
    const requests = answering(() => Response.json({
      ok: true, access_token: "user-token", refresh_token: "next-refresh", scope: "search:read",
    }));

    expect(await GRANTS["token.refresh"].send()).toMatchObject({
      accessToken: { token: "user-token" }, refreshToken: "next-refresh", grantedScopes: ["search:read"],
    });

    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, GRANTS["token.refresh"].form]]);
    expect(counted()).toEqual([["token.refresh", "success", "", 200]]);
  });

  // The helpers ask whether the answer holds a token, and not what the token is: the count follows
  // the one check, so a request whose helper returns a grant is a success.
  it.each<[keyof typeof GRANTS, string, unknown]>([
    ["token.exchange", "a number", 123],
    ["token.exchange", "an object", {}],
    ["token.refresh", "a number", 123],
    ["token.refresh", "an object", {}],
  ])("counts %s a success where the token of a 200 that says ok is %s, which the helper returns", async (name, _kind, token) => {
    const { send, form } = GRANTS[name];
    // The exchange reads the token of the user, and the refresh the one at the top level.
    const grant = name === "token.exchange" ? { authed_user: { id: "WSELF", access_token: token } } : { access_token: token };
    const requests = answering(() => Response.json({ ok: true, ...grant }));

    expect(await send()).toMatchObject({ accessToken: { token } });

    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, form]]);
    expect(counted()).toEqual([[name, "success", "", 200]]);
  });

  it.each<[keyof typeof GRANTS, string, string, string]>([
    ["token.exchange", "invalid_client", "error", "api"],
    ["token.exchange", "ratelimited", "refused", "rate"],
    ["token.refresh", "invalid_client", "error", "api"],
    ["token.refresh", "ratelimited", "refused", "rate"],
  ])("counts %s by what the envelope says where a 200 says %s and holds no token: %s with the reason %s", async (name, error, outcome, reason) => {
    const { send, form, failed } = GRANTS[name];
    const requests = answering(() => Response.json({ ok: false, error }));

    expect(await thrownBy(send)).toEqual(new Error(failed(error)));

    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, form]]);
    expect(counted()).toEqual([[name, outcome, reason, 200]]);
  });

  it("counts a refresh that asks for a new authorization an error of the API, and resolves to null", async () => {
    const requests = answering(() => Response.json({ ok: false, error: "invalid_refresh_token" }));

    await expect(GRANTS["token.refresh"].send()).resolves.toBeNull();

    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, GRANTS["token.refresh"].form]]);
    expect(counted()).toEqual([["token.refresh", "error", "api", 200]]);
  });

  // The missing token is an error inside a success only: an answer that is none counts by its
  // status, as a throttle of the token endpoint does.
  it.each<[keyof typeof GRANTS, number, string, string]>([
    ["token.exchange", 429, "refused", "rate"],
    ["token.exchange", 500, "error", "http"],
    ["token.refresh", 429, "refused", "rate"],
    ["token.refresh", 500, "error", "http"],
  ])("counts %s by its status where a %d says ok and holds no token: %s with the reason %s", async (name, status, outcome, reason) => {
    const { send, form, tokenless } = GRANTS[name];
    const requests = answering(() => Response.json({ ok: true }, { status }));

    expect(await thrownBy(send)).toEqual(new Error(tokenless));

    expect(formsOf(requests)).toEqual([["POST", `${API}/oauth.v2.access`, form]]);
    expect(counted()).toEqual([[name, outcome, reason, status]]);
  });
});

// Each request sent, as its method, its URL, its headers and its form.
function revocationsOf(requests: Sent[]) {
  return requests.map(({ method, url, init }) => [
    method, url.href, Object.fromEntries(new Headers(init.headers)), String(init.body),
  ]);
}

// The one request the revocation of the token `user-token` sends.
const REVOCATION = ["POST", `${API}/auth.revoke`, {
  "authorization": "Bearer user-token", "content-type": "application/x-www-form-urlencoded",
}, "token=user-token"];

describe("the revocation of a token", () => {
  it.each(["token_revoked", "token_expired"])(
      "resolves and is counted a success where a 200 says %s: the token is revoked already", async error => {
    const requests = answering(() => Response.json({ ok: false, error }));

    await expect(revokeToken("user-token")).resolves.toBeUndefined();

    expect(revocationsOf(requests)).toEqual([REVOCATION]);
    expect(counted()).toEqual([["token.revoke", "success", "", 200]]);
  });

  // The revocation resolves for either error whatever status it comes with, and is counted by
  // that same check, so the status of a refusal or of a failure of Slack's own is a success here.
  it.each([401, 429, 503].flatMap(status => ["token_revoked", "token_expired"].map(error => [status, error] as const)))(
      "resolves and is counted a success with the status Slack gave where a %d says %s, sent once", async (status, error) => {
    const requests = answering(() => Response.json({ ok: false, error }, { status }));

    await expect(revokeToken("user-token")).resolves.toBeUndefined();

    expect(revocationsOf(requests)).toEqual([REVOCATION]);
    expect(counted()).toEqual([["token.revoke", "success", "", status]]);
  });

  it.each(["token_revoked", "token_expired"])(
      "is the only request counted a success where a 200 says %s: a refresh, an exchange and a Web API call are errors of the API", async error => {
    const requests = answering(() => Response.json({ ok: false, error }));

    await expect(refreshAccessToken("refresh-token", "client", "secret")).resolves.toBeNull();
    await expect(exchangeAuthCode("code", "client", "secret", "https://gatekeeper.example/oauth"))
        .rejects.toThrow(`Slack OAuth exchange failed: ${error}`);
    await expect(unbound().authedUserId()).rejects.toMatchObject({ code: error, status: 200 });

    expect(requests).toHaveLength(3);
    expect(counted()).toEqual([
      ["token.refresh", "error", "api", 200], ["token.exchange", "error", "api", 200], ["auth.test", "error", "api", 200],
    ]);
  });

  it.each<[string, string, string]>([
    ["invalid_auth", "error", "api"],
    ["account_inactive", "error", "api"],
    // An error that only names a token, and is neither of the two the revocation resolves for.
    ["token_revoked_by_admin", "error", "api"],
    ["ratelimited", "refused", "rate"],
  ])("fails where a 200 says %s, counted %s with the reason %s", async (error, outcome, reason) => {
    const requests = answering(() => Response.json({ ok: false, error }));

    await expect(revokeToken("user-token")).rejects.toMatchObject({ code: error, status: 200 });

    expect(revocationsOf(requests)).toEqual([REVOCATION]);
    expect(counted()).toEqual([["token.revoke", outcome, reason, 200]]);
  });

  it("fails where Slack answers an error of its own, counted by its status and sent once", async () => {
    const requests = answering(() => Response.json({ ok: false, error: "internal_error" }, { status: 500 }));

    await expect(revokeToken("user-token")).rejects.toMatchObject({ code: "internal_error", status: 500 });

    expect(revocationsOf(requests)).toEqual([REVOCATION]);
    expect(counted()).toEqual([["token.revoke", "error", "http", 500]]);
  });

  it("is counted a success where Slack revokes the token", async () => {
    const requests = answering(() => Response.json({ ok: true, revoked: true }));

    await expect(revokeToken("user-token")).resolves.toBeUndefined();

    expect(revocationsOf(requests)).toEqual([REVOCATION]);
    expect(counted()).toEqual([["token.revoke", "success", "", 200]]);
  });
});

// What each helper throws where Slack answers a 200 whose JSON is `null`, and where it is any
// other JSON that is no object.
const BODILESS: [name: string, send: () => Promise<unknown>, onNull: Error, otherwise: Error][] = [
  ["auth.test", () => unbound().authedUserId(),
    new TypeError("Cannot read properties of null (reading 'ok')"), new SlackApiError(undefined, 200)],
  ["token.exchange", GRANTS["token.exchange"].send,
    new TypeError("Cannot read properties of null (reading 'ok')"), new Error(GRANTS["token.exchange"].failed("200"))],
  ["token.refresh", GRANTS["token.refresh"].send,
    new TypeError("Cannot read properties of null (reading 'ok')"), new Error(GRANTS["token.refresh"].failed("200"))],
  ["token.revoke", () => revokeToken("user-token"),
    new TypeError("Cannot read properties of null (reading 'error')"), new SlackApiError(undefined, 200)],
];

describe("a success whose body is no envelope", () => {
  it.each(BODILESS.flatMap(([name, send, onNull, otherwise]) => [
    [name, "null", send, onNull] as const,
    [name, '"ok"', send, otherwise] as const,
    [name, "[]", send, otherwise] as const,
    [name, "7", send, otherwise] as const,
    [name, "true", send, otherwise] as const,
  ]))("counts %s an error of the API where a 200 holds %s, sent once and failing as the helper does", async (name, body, send, thrown) => {
    const requests = answering(() => new Response(body, { headers: { "Content-Type": "application/json" } }));

    const failure = await thrownBy(send);

    expect(failure).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(failure)).toBe(Object.getPrototypeOf(thrown));
    expect(failure).toMatchObject({ message: thrown.message });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([[name, "error", "api", 200]]);
  });

  it("counts a call by its status where the body that is no envelope comes with a failure", async () => {
    const requests = answering(() => Response.json(null, { status: 500 }));

    await expect(unbound().authedUserId()).rejects.toThrow(new TypeError("Cannot read properties of null (reading 'ok')"));

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["auth.test", "error", "http", 500]]);
  });

  it("counts a 200 that is no JSON as an answer that could not be parsed", async () => {
    const requests = answering(() => new Response("<html>"));

    await expect(unbound().authedUserId()).rejects.toBeInstanceOf(SyntaxError);

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["auth.test", "error", "parse", 200]]);
  });
});

// A client of a workspace install whose saved installation says so.
const workspaceInstall = () => new SlackApi(async () => "user-token", {
  installation: async () => ({ teamId: "TONE", isEnterpriseInstall: false }),
});

// A listing that names the same cursor for the page after every page.
const circling = (key: string) => () => ({ [key]: [], response_metadata: { next_cursor: "again" } });

describe("an envelope that says ok and lacks what the call was sent for", () => {
  it.each<[string, string, () => Promise<unknown>, Answers, string]>([
    ["users.info", "names no user", () => unbound().getUser("WGONE"), { "users.info": () => ({}) },
      "Slack user not found: WGONE"],
    ["conversations.info", "names no conversation",
      () => unbound().forWorkspace("TONE").getConversationInfo("CONE"), { "conversations.info": () => ({}) },
      "Slack conversation not found: CONE"],
    ["conversations.info", "names another conversation",
      () => unbound().forWorkspace("TONE").getConversationInfo("CONE"),
      { "conversations.info": () => ({ channel: { id: "COTHER", team_id: "TONE" } }) },
      "Slack conversation not found: CONE"],
    ["team.info", "names no workspace", () => unbound().forWorkspace("TONE").getWorkspaceInfo(),
      { "team.info": () => ({}) },
      "Slack returned an enterprise or a different workspace instead of the selected workspace."],
    ["team.info", "names an enterprise", () => unbound().forWorkspace("TONE").getWorkspaceInfo(),
      { "team.info": () => ({ team: { id: "EORG", name: "Org", domain: "org" } }) },
      "Slack returned an enterprise or a different workspace instead of the selected workspace."],
    ["team.info", "names another workspace", () => unbound().forWorkspace("TONE").getWorkspaceInfo(),
      { "team.info": () => ({ team: { id: "TTWO", name: "Two", domain: "two" } }) },
      "Slack returned an enterprise or a different workspace instead of the selected workspace."],
    ["auth.test", "names no user for an organisation's token", () => unbound().listWorkspaces(),
      { "auth.test": () => ({ team_id: "EORG", is_enterprise_install: true }) },
      "Slack returned no user identity."],
    ["auth.test", "names nobody", () => unbound().listWorkspaces(), { "auth.test": () => ({}) },
      "Slack returned no user identity."],
    ["auth.test", "names no workspace for the token of a workspace install", () => workspaceInstall().listWorkspaces(),
      { "auth.test": () => ({ team_id: "EORG", user_id: "WSELF" }) },
      "Slack returned no workspace identity."],
    ["auth.test", "names no workspace for a workspace install whose host is asked for",
      () => workspaceInstall().workspaceIdForDomain("one"), { "auth.test": () => ({ user_id: "WSELF" }) },
      "Slack returned no workspace identity."],
  ])("counts %s an error of the API where it %s, sent once and failing as the client does", async (name, _lacking, send, answers, message) => {
    const requests = fakeSlack(answers);

    const failure = await thrownBy(send);

    expect(failure).toEqual(new Error(message));
    expect(Object.getPrototypeOf(failure)).toBe(Error.prototype);
    // The call that is refused is the last one sent, and the only one of its method that failed.
    expect(rowsOf(requests).at(-1)).toEqual(["GET", `${API}/${name}`]);
    expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([[name, "error", "api", 200]]);
    expect(callsByOperation()).toEqual(countsOf(rowsOf(requests).map(([, url]) => url.slice(`${API}/`.length))));
  });

  it("counts a search an error of the API where a match names no conversation, after the lookups before it", async () => {
    const matches = [{ ts: "1700000000.000100", channel: { id: "CONE" } }, { ts: "1700000000.000200" }];
    const requests = fakeSlack({
      "search.messages": () => ({ messages: { matches, paging: { page: 1, pages: 1 } } }),
      "conversations.info": params => ({ channel: { id: params.get("channel"), team_id: "TONE" } }),
    });

    const failure = await thrownBy(() => unbound().forWorkspace("TONE").searchMessages("hello", undefined, 10));

    expect(failure).toEqual(new Error("Slack search returned a message without a conversation."));
    expect(Object.getPrototypeOf(failure)).toBe(Error.prototype);
    expect(sentOf(requests, "search.messages")).toBe(1);
    // The conversation of the match before it is looked up all the same.
    expect(sentOf(requests, "conversations.info")).toBe(1);
    expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([["search.messages", "error", "api", 200]]);
  });

  it("counts a search an error of the API where a match names no conversation, though the lookup of the match before it fails first", async () => {
    const matches = [{ ts: "1700000000.000100", channel: { id: "CTWO" } }, { ts: "1700000000.000200" }];
    const requests = fakeSlack({
      "search.messages": () => ({ messages: { matches, paging: { page: 1, pages: 1 } } }),
      "conversations.info": () => ({ ok: false, error: "channel_not_found" }),
    });

    await expect(unbound().forWorkspace("TONE").searchMessages("hello", undefined, 10))
        .rejects.toMatchObject({ code: "channel_not_found", status: 200 });

    expect(sentOf(requests, "search.messages")).toBe(1);
    expect(sentOf(requests, "conversations.info")).toBe(1);
    expect(counted().filter(([, outcome]) => outcome !== "success"))
        .toEqual([["search.messages", "error", "api", 200], ["conversations.info", "error", "api", 200]]);
  });

  it.each<[string, string, () => Promise<unknown>, Answers, string]>([
    ["users.list", "lists members that are no list", () => unbound().forWorkspace("TONE").listUsers(undefined, 10),
      { "users.list": () => ({ members: 5 }) }, "(data.members ?? []).filter is not a function"],
    ["users.list", "lists a member that is none", () => unbound().forWorkspace("TONE").listUsers(undefined, 10),
      { "users.list": () => ({ members: [null] }) }, "Cannot read properties of null (reading 'deleted')"],
    ["auth.teams.list", "lists a workspace that is none", () => unbound().listWorkspaces(),
      { "auth.teams.list": () => ({ teams: [null] }) }, "Cannot read properties of null (reading 'id')"],
    ["users.conversations", "lists conversations that are no list",
      () => unbound().forWorkspace("TONE").listUserConversations(["im"], undefined, 10),
      { "users.conversations": () => ({ channels: 5 }) }, "raws.filter is not a function"],
    ["users.conversations", "lists a conversation that is none",
      () => unbound().forWorkspace("TONE").listUserConversations(["im"], undefined, 10),
      { "users.conversations": () => ({ channels: [null] }) }, "Cannot read properties of null (reading 'is_im')"],
    ["conversations.list", "lists conversations that are no list, asked whether one is the workspace's",
      () => unbound().forWorkspace("TONE").getConversationInfo("CONE"),
      { "conversations.list": () => ({ channels: 5 }) }, "page.channels?.some is not a function"],
    ["conversations.list", "lists a conversation that is none, asked whether one is the workspace's",
      () => unbound().forWorkspace("TONE").getConversationInfo("CONE"),
      { "conversations.list": () => ({ channels: [null] }) }, "Cannot read properties of null (reading 'id')"],
    ["conversations.history", "lists messages that are no list",
      () => unbound().forWorkspace("TONE").listHistory("CONE", undefined, 10),
      { "conversations.history": () => ({ messages: 5 }) }, "messages is not iterable"],
    ["conversations.history", "lists a message that is none",
      () => unbound().forWorkspace("TONE").listHistory("CONE", undefined, 10),
      { "conversations.history": () => ({ messages: [null] }) }, "Cannot read properties of null (reading 'user')"],
    ["conversations.replies", "lists messages that are no list",
      () => unbound().forWorkspace("TONE").listReplies("CONE", "1700000000.000100", undefined, 10),
      { "conversations.replies": () => ({ messages: 5 }) }, "messages is not iterable"],
    ["search.messages", "lists a match that is none", () => unbound().forWorkspace("TONE").searchMessages("hello", undefined, 10),
      { "search.messages": () => ({ messages: { matches: [null] } }) }, "Cannot read properties of null (reading 'channel')"],
  ])("counts %s an error of the API where it %s, sent once and failing as the client does on reading it", async (name, _lacking, send, answers, message) => {
    const requests = fakeSlack(answers);

    const failure = await thrownBy(send);

    expect(Object.getPrototypeOf(failure)).toBe(TypeError.prototype);
    expect(failure).toMatchObject({ message });
    expect(rowsOf(requests).at(-1)).toEqual(["GET", `${API}/${name}`]);
    expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([[name, "error", "api", 200]]);
    expect(callsByOperation()).toEqual(countsOf(rowsOf(requests).map(([, url]) => url.slice(`${API}/`.length))));
  });

  // Such a page says nothing of whether the app may reach a workspace: the check of access throws,
  // and denies nothing.
  it.each<[string, unknown]>([["no list", undefined], ["workspaces that are no list", 5]])(
    "counts users.info an error of the API where the user's workspaces are %s, and throws from the check of access", async (_what, teams) => {
      const requests = fakeSlack({ "users.info": () => ({ user: { id: "WSELF", enterprise_user: teams === undefined ? {} : { teams } } }) });

      const failure = await thrownBy(() => unbound().hasWorkspaceAccess("TONE"));

      expect(failure).toMatchObject({ message: "Slack returned a malformed list of the user's workspaces." });
      expect(rowsOf(requests).at(-1)).toEqual(["GET", `${API}/users.info`]);
      expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([["users.info", "error", "api", 200]]);
    });

  it.each<[string, unknown]>([["no list", undefined], ["workspaces that are no list", 5]])(
    "counts auth.teams.list an error of the API where its page holds %s, and throws from the check of access", async (_what, teams) => {
      const requests = fakeSlack({ "auth.teams.list": () => (teams === undefined ? {} : { teams }) });

      const failure = await thrownBy(() => unbound().hasWorkspaceAccess("TONE"));

      expect(failure).toMatchObject({ message: "Slack returned a malformed list of workspaces." });
      expect(rowsOf(requests).at(-1)).toEqual(["GET", `${API}/auth.teams.list`]);
      expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([["auth.teams.list", "error", "api", 200]]);
    });

  it("asks once for the peer of a direct message as the conversation names it, where it names a list of users", async () => {
    const requests = fakeSlack({
      "users.conversations": () => ({ channels: [{ id: "DONE", is_im: true, user: ["WA", "WB"] }] }),
    });

    const page = await unbound().forWorkspace("TONE").listUserConversations(["im"], undefined, 10);

    const asked = requests.filter(({ url }) => url.pathname === "/api/users.info").map(({ url }) => url.searchParams.get("user"));
    expect(asked.filter(user => user !== "WSELF")).toEqual(["WA,WB"]);
    expect(page.items.map(({ id, peer }) => [id, peer?.id])).toEqual([["DONE", "WA,WB"]]);
    expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([]);
  });

  it("counts a search a success where the match that names no conversation is outside the conversation searched", async () => {
    const matches = [{ ts: "1700000000.000100", channel: { id: "CONE" } }, { ts: "1700000000.000200" }];
    fakeSlack({
      "search.messages": () => ({ messages: { matches, paging: { page: 1, pages: 1 } } }),
      "conversations.info": params => ({ channel: { id: params.get("channel"), team_id: "TONE" } }),
    });

    const page = await unbound().forWorkspace("TONE").searchMessages("hello", undefined, 10, "CONE");

    expect(page.items.map(({ channelId }) => channelId)).toEqual(["CONE"]);
    expect(counted().filter(([operation]) => operation === "search.messages")).toEqual([["search.messages", "success", "", 200]]);
  });

  it.each<[string, () => Promise<unknown>, Answers]>([
    ["auth.teams.list", () => unbound().listWorkspaces(), { "auth.teams.list": circling("teams") }],
    ["users.list", () => unbound().forWorkspace("TONE").getWorkspaceUser("WGONE"), { "users.list": circling("members") }],
    ["conversations.list", () => unbound().forWorkspace("TONE").getConversationInfo("CONE"),
      { "conversations.list": circling("channels") }],
    ["users.conversations", () => unbound().forWorkspace("TONE").getConversationInfo("DONE"), {
      "conversations.info": params => ({ channel: { id: params.get("channel"), is_im: true } }),
      "users.conversations": circling("channels"),
    }],
  ])("counts the page of %s that names a cursor again an error of the API, and the page before it a success", async (name, send, answers) => {
    const requests = fakeSlack(answers);

    const failure = await thrownBy(send);

    expect(failure).toEqual(new Error("Slack repeated a pagination cursor."));
    expect(Object.getPrototypeOf(failure)).toBe(Error.prototype);
    expect(requests.filter(({ url }) => url.pathname === `/api/${name}`).map(({ url }) => url.searchParams.get("cursor")))
        .toEqual([null, "again"]);
    expect(counted().filter(([operation]) => operation === name))
        .toEqual([[name, "success", "", 200], [name, "error", "api", 200]]);
    expect(callsOf(name)).toEqual([1, 1]);
  });

  it("counts a call a success where the saved installation its answer is read with cannot be loaded", async () => {
    const requests = fakeSlack();
    const unloaded = new Error("The installation could not be loaded.");
    const api = new SlackApi(async () => "user-token", { installation: () => Promise.reject(unloaded) });

    expect(await thrownBy(() => api.listWorkspaces())).toBe(unloaded);

    expect(rowsOf(requests)).toEqual([["GET", `${API}/auth.test`]]);
    expect(counted()).toEqual([["auth.test", "success", "", 200]]);
  });

  it.each<[string, () => Promise<unknown>, Answers, string]>([
    // Every page is read and the user is on none: the user is outside the workspace.
    ["users.list", () => unbound().forWorkspace("TONE").getWorkspaceUser("WGONE"), {}, "access_denied"],
    // The workspace is read, and its host is another than the one asked for.
    ["team.info", () => workspaceInstall().workspaceIdForDomain("other"),
      { "auth.test": () => ({ team_id: "TONE", user_id: "WSELF" }) }, "team_access_not_granted"],
  ])("counts %s a success where the client refuses what a well-formed answer says", async (name, send, answers, code) => {
    fakeSlack(answers);

    await expect(send()).rejects.toMatchObject({ code, status: 200 });

    expect(counted().filter(([operation]) => operation === name)).toEqual([[name, "success", "", 200]]);
    expect(counted().filter(([, outcome]) => outcome !== "success")).toEqual([]);
  });
});

describe("a rate-limited call", () => {
  it.each<[string | undefined, number]>([
    ["7", 7_000],
    // Slack's wait is believed up to 30 seconds.
    ["30", 30_000],
    ["120", 30_000],
    ["Infinity", 30_000],
    ["0.5", 500],
    // A second where Slack names no wait, or none that is a number of seconds.
    [undefined, 1_000],
    ["0", 1_000],
    ["Wed, 21 Oct 2026 07:28:00 GMT", 1_000],
  ])("is sent three times, %j waiting %d ms before each resend, then fails as rate limited", async (retryAfter, waited) => {
    vi.useFakeTimers();
    const times: number[] = [];
    answering(() => {
      times.push(Date.now());
      return Response.json({ ok: false, error: "ratelimited" },
          { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
    });

    const failed = expect(unbound().authedUserId())
        .rejects.toMatchObject({ code: "ratelimited", status: 429 });
    await vi.advanceTimersByTimeAsync(120_000);
    await failed;

    expect(times.slice(1).map((time, at) => time - times[at])).toEqual([waited, waited]);
    expect(counted()).toEqual([1, 2, 3].map(() => ["auth.test", "refused", "rate", 429]));
  });

  it("is answered once the limit lifts", async () => {
    vi.useFakeTimers();
    const requests = answering(() => requests.length < 3
      ? Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "1" } })
      : Response.json({ ok: true, user_id: "WSELF" }));

    const answered = unbound().authedUserId();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await answered).toBe("WSELF");
    expect(counted().map(([, outcome]) => outcome)).toEqual(["refused", "refused", "success"]);
  });

  it("is the only answered call sent again: one answered 503 is sent once", async () => {
    const requests = answering(() => Response.json({ ok: false, error: "service_unavailable" }, { status: 503 }));

    await expect(unbound().authedUserId())
        .rejects.toMatchObject({ code: "service_unavailable", status: 503 });

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["auth.test", "error", "http", 503]]);
  });

  it("is sent once where it is a token request", async () => {
    const requests = answering(() => Response.json({ ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "0" } }));

    await expect(refreshAccessToken("refresh-token", "client", "secret"))
        .rejects.toThrow("Slack token refresh failed: ratelimited");
    await expect(revokeToken("user-token")).rejects.toMatchObject({ code: "ratelimited", status: 429 });

    expect(requests).toHaveLength(2);
    expect(counted()).toEqual([
      ["token.refresh", "refused", "rate", 429], ["token.revoke", "refused", "rate", 429],
    ]);
  });
});

describe("a call that got no answer", () => {
  it("is sent three times where it is a Web API call, a read, then fails with what fetch threw", async () => {
    vi.useFakeTimers();
    const failure = new TypeError("fetch failed");
    const requests = answering(() => { throw failure; });

    const failed = expect(unbound().authedUserId()).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(120_000);
    await failed;

    expect(requests).toHaveLength(3);
    expect(counted()).toEqual([1, 2, 3].map(() => ["auth.test", "error", "network", 0]));
  });

  it("is sent once where it is a token request", async () => {
    const failure = new TypeError("fetch failed");
    const requests = answering(() => { throw failure; });

    await expect(refreshAccessToken("refresh-token", "client", "secret")).rejects.toBe(failure);

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["token.refresh", "error", "network", 0]]);
  });
});

describe("an operation that pages", () => {
  it("writes the pages of a listing of workspaces as one point", async () => {
    const requests = answering(({ url }) => {
      const method = url.pathname.slice("/api/".length);
      if (method === "auth.test") {
        return Response.json({ ok: true, team_id: "EORG", user_id: "WSELF", is_enterprise_install: true });
      }
      if (method === "users.info") {
        return Response.json({ ok: true, user: { id: "WSELF", name: "self", enterprise_user: { teams: ["TONE", "TTWO"] } } });
      }
      const first = url.searchParams.get("cursor") === null;
      return Response.json({
        ok: true, teams: [{ id: first ? "TONE" : "TTWO" }], response_metadata: { next_cursor: first ? "next" : "" },
      });
    });

    expect(await unbound().listWorkspaces()).toEqual([{ id: "TONE", name: "TONE" }, { id: "TTWO", name: "TTWO" }]);

    expect(rowsOf(requests).filter(([, url]) => url === `${API}/auth.teams.list`)).toHaveLength(2);
    const pages = points.filter(point => column(point, SUBSERVICE_V1_SLOTS.operation) === "auth.teams.list");
    expect(pages.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([2]);
  });

  it("writes the pages of members a user is looked up in as one point", async () => {
    const requests = fakeSlack({
      "users.list": params => pageOf(params, "members",
          [[{ id: "WONE", name: "one" }], [{ id: "WTWO", name: "two" }], [{ id: "WSELF", name: "self" }]]),
    });

    expect(await unbound().forWorkspace("TONE").getWorkspaceUser("WSELF")).toMatchObject({ id: "WSELF" });

    expect(sentOf(requests, "users.list")).toBe(3);
    expect(callsOf("users.list")).toEqual([3]);
  });

  it("writes the pages of conversations that prove a conversation's workspace as one point", async () => {
    const requests = fakeSlack({
      "conversations.list": params => pageOf(params, "channels", [[{ id: "COTHER" }], [{ id: "CONE" }]]),
    });

    expect(await unbound().forWorkspace("TONE").getConversationInfo("CONE")).toMatchObject({ id: "CONE" });

    expect(sentOf(requests, "conversations.list")).toBe(2);
    expect(callsOf("conversations.list")).toEqual([2]);
  });

  it("writes the lookups of the conversations a page of search matched as one point", async () => {
    const matches = ["CONE", "CTWO"].map(id => ({ ts: "1700000000.000100", user: "WSELF", channel: { id } }));
    const requests = fakeSlack({
      "search.messages": () => ({ messages: { matches, paging: { page: 1, pages: 1 } } }),
      // A conversation that names its workspace, which no listing has to prove.
      "conversations.info": params => ({ channel: { id: params.get("channel"), team_id: "TONE" } }),
    });

    const page = await unbound().forWorkspace("TONE").searchMessages("hello", undefined, 10);

    expect(page.items.map(({ channelId }) => channelId)).toEqual(["CONE", "CTWO"]);
    expect(sentOf(requests, "conversations.info")).toBe(2);
    expect(callsOf("conversations.info")).toEqual([2]);
  });

  it("writes the lookups of the authors of a page of messages as one point", async () => {
    const requests = fakeSlack({
      "conversations.history": () => ({
        messages: [{ ts: "1700000000.000100", user: "WONE" }, { ts: "1700000000.000200", user: "WTWO" }],
      }),
    });

    const page = await unbound().forWorkspace("TONE").listHistory("CONE", undefined, 10);

    expect(page.items.map(({ author }) => author?.id)).toEqual(["WONE", "WTWO"]);
    // The proof of the workspace looks its own user up, a point of its own, before the authors.
    expect(sentOf(requests, "users.info")).toBe(3);
    expect(callsOf("users.info")).toEqual([1, 2]);
  });
});
