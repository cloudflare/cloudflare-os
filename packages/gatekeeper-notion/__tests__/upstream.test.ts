// The requests this gatekeeper sends to Notion, the name each is counted under, and what the
// gatekeeper decides about a call that the client cannot know: a refusal inside a successful token
// answer, the replay of a request Notion answered 401, and which operations are counted summed.
// These drive the real client against a stubbed fetch and read the points it writes.
import { env as bindings } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import { UserAccount } from "../src/notion";
import { NotionStore, revertStoredAction } from "../src/notion-actions";
import {
  MAX_HELD_ERROR_BYTES, NotionApi, NotionApiError, exchangeAuthCode, refreshAccessToken,
} from "../src/notion-api";
import { itemSubresourceId } from "../src/notion-subresources";
import { NOTION_OPERATIONS, NOTION_ROUTES, notionUpstream } from "../src/notion-upstream";

// The account's Durable Object is driven as a plain class, beside the shared stub's `env`.
vi.mock("cloudflare:workers", async importOriginal => ({
  ...await importOriginal<typeof import("cloudflare:workers")>(),
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: vi.fn(),
  RpcStub: vi.fn(),
  WorkerEntrypoint: vi.fn(),
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/notion-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/notion-item-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/notion-workspace-configurator-ui.txt", () => ({ default: "" }));

const API = "https://api.notion.com/v1";
const TOKEN = `${API}/oauth/token`;
const WORKSPACE = "7c1d6a52-0f3b-4e8a-9d4e-1b2c3d4e5f60";
const PAGE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DATABASE = "01234567-89ab-cdef-0123-456789abcdef";
const SOURCE = "0aaaaaaa-1111-4222-8333-444444444444";
const BLOCK = "0bbbbbbb-1111-4222-8333-444444444444";
const USER = "0ccccccc-1111-4222-8333-444444444444";

const page = {
  object: "page", id: PAGE, url: "https://www.notion.so/page", properties: {},
  created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
};
const database = { object: "database", id: DATABASE, data_sources: [{ id: SOURCE, name: "Main" }] };
const noResults = { results: [], has_more: false, next_cursor: null };
const comment = { parent: { page_id: PAGE }, rich_text: [] };

// Each kind of request the gatekeeper makes under Notion's API root: its HTTP method, its URL, the
// name it is counted under, the method of the client that sends it, and what Notion answers.
const REQUESTS: [
  method: string, url: string, name: string, call: (api: NotionApi) => Promise<unknown>, answer: unknown,
][] = [
  ["GET", `${API}/users/me`, "users.me", api => api.getBotUser(), { id: "bot", type: "bot" }],
  ["GET", `${API}/users/${USER}`, "users.get", api => api.retrieveUser(USER), { id: USER }],
  ["GET", `${API}/users?start_cursor=c1&page_size=5`, "users.list", api => api.listUsers("c1", 5), noResults],
  ["GET", `${API}/pages/${PAGE}`, "pages.get", api => api.retrievePage(PAGE), page],
  ["POST", `${API}/pages`, "pages.create", api => api.createPage({ parent: { page_id: PAGE } }), page],
  ["PATCH", `${API}/pages/${PAGE}`, "pages.patch", api => api.updatePage(PAGE, { archived: true }), page],
  ["GET", `${API}/databases/${DATABASE}`, "databases.get", api => api.retrieveDatabase(DATABASE), database],
  ["GET", `${API}/data_sources/${SOURCE}`, "data_sources.get", api => api.retrieveDataSource(SOURCE),
    { object: "data_source", id: SOURCE }],
  ["POST", `${API}/data_sources/${SOURCE}/query`, "data_sources.query",
    api => api.queryDataSource(SOURCE, { page_size: 1 }), noResults],
  ["POST", `${API}/search`, "search", api => api.search({ query: "plan" }), noResults],
  ["GET", `${API}/blocks/${PAGE}/children?start_cursor=c1&page_size=5`, "children.list",
    api => api.listBlockChildren(PAGE, "c1", 5), noResults],
  ["PATCH", `${API}/blocks/${PAGE}/children`, "children.patch", api => api.appendBlockChildren(PAGE, []), noResults],
  ["DELETE", `${API}/blocks/${BLOCK}`, "blocks.delete", api => api.deleteBlock(BLOCK), { object: "block", id: BLOCK }],
  ["GET", `${API}/comments?block_id=${PAGE}`, "comments.list", api => api.listComments(PAGE), noResults],
  ["POST", `${API}/comments`, "comments.create", api => api.createComment(comment), { object: "comment" }],
];

// Each token request: the name it is counted under and the function that sends it.
const grant = { access_token: "access", refresh_token: "refresh", workspace_id: WORKSPACE };
const exchange = () => exchangeAuthCode("code", "client", "secret", "https://gadgets.example/oauth");
const refresh = () => refreshAccessToken("refresh", "client", "secret");
const TOKEN_REQUESTS: [name: string, call: () => Promise<unknown>][] = [
  ["token.exchange", exchange],
  ["token.refresh", refresh],
];

type Point = { blobs?: unknown[]; doubles?: unknown[] };
type Sent = [url: string, init: RequestInit];

const ambient = bindings as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
let points: Point[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void points.push(point) };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

// One column of each point written.
function columnOf(slot: string) {
  return points.map(point => column(point, slot));
}

// A global fetch that gives each of `answers` in turn, and the last to every later request. An
// error is thrown.
function answering(...answers: (Response | Error)[]) {
  const fetch = vi.fn(async (..._sent: Sent) => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === undefined) throw new Error("the test listed no answer");
    if (next instanceof Error) throw next;
    return next.clone();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// A global fetch that answers each request by its path, and with a 404 where `routes` has none.
function answeringByPath(routes: Record<string, (url: URL) => unknown>) {
  const fetch = vi.fn(async (...[url]: Sent) => {
    const parsed = new URL(url);
    const route = routes[parsed.pathname];
    return route ? Response.json(route(parsed))
      : Response.json({ code: "object_not_found", message: "Not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// The method and URL of each request sent.
function sent(fetch: ReturnType<typeof answering>) {
  return fetch.mock.calls.map(([url, init]) => [init.method, url]);
}

// One header of each request sent.
function headerOf(fetch: ReturnType<typeof answering>, name: string) {
  return fetch.mock.calls.map(([, init]) => new Headers(init.headers).get(name));
}

function memoryKv() {
  const map = new Map<string, unknown>();
  return {
    get: (key: string) => structuredClone(map.get(key)),
    put: (key: string, value: unknown) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    list: ({ prefix }: { prefix: string }) => [...map].filter(([key]) => key.startsWith(prefix)),
  };
}

const notion = (refreshed?: () => Promise<string>) => new NotionApi(async () => "token-1", refreshed);
// An answer that asks for no wait before the request is sent again.
const failing = (status: number, body: unknown = {}) =>
  Response.json(body, { status, headers: { "Retry-After": "0" } });
const unauthorized = () => Response.json({ code: "unauthorized", message: "API token is invalid." }, { status: 401 });
// A refresh that cannot give a token.
const failingRefresh = async (): Promise<string> => { throw new Error("no refresh token"); };
// A block as Notion lists it among a block's children.
const block = (id: string, has_children = false) => ({ id, type: "paragraph", has_children });

describe("the names of Notion's requests", () => {
  it("counts every request under the source and service of the vendor", () => {
    expect(notionUpstream.vendorId).toBe("notion");
    expect(notionUpstream.source).toBe("gatekeeper.notion.api");
  });

  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(notionUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(NOTION_ROUTES)).toHaveLength(8);
    expect(unreachedRouteEnds(NOTION_ROUTES, REQUESTS)).toEqual([]);
  });

  it("names a path the tree does not hold, another host and the token endpoint by the method alone", () => {
    expect(notionUpstream.operationOf("GET", `${API}/views/${PAGE}`)).toBe("GET");
    expect(notionUpstream.operationOf("DELETE", `${API}/pages/${PAGE}/properties/title`)).toBe("DELETE");
    expect(notionUpstream.operationOf("GET", `https://files.notion.example/v1/pages/${PAGE}`)).toBe("GET");
    expect(notionUpstream.operationOf("POST", TOKEN)).toBe("POST");
  });

  it("builds no name from what a path holds in place of an ID", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    expect(words.has(notionUpstream.operationOf("GET", `${API}/pages/Secret-Plan-${PAGE}`))).toBe(true);
    expect(words.has(notionUpstream.operationOf("GET", `${API}/blocks/secret-block/children`))).toBe(true);
    expect(notionUpstream.operationOf("GET", `${API}/secret-plan/${PAGE}`)).toBe("GET");
  });

  it.each(REQUESTS)("sends %s %s, counted as %s", async (method, url, name, call, answer) => {
    const fetch = answering(Response.json(answer));
    await call(notion());
    expect(sent(fetch)).toEqual([[method, url]]);
    expect(counted()).toEqual([[name, "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["notion"]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(["gatekeeper.notion.api"]);
  });

  it.each(TOKEN_REQUESTS)("counts a token request under %s", async (name, call) => {
    const fetch = answering(Response.json(grant));
    await expect(call()).resolves.toMatchObject({ accessToken: "access", workspaceId: WORKSPACE });
    expect(sent(fetch)).toEqual([["POST", TOKEN]]);
    expect(counted()).toEqual([[name, "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["notion"]);
  });

  it("sends a request for every name of the union, and lists none twice", () => {
    expect(TOKEN_REQUESTS.map(([name]) => name).toSorted()).toEqual(NOTION_OPERATIONS.toSorted());
    expect(new Set(NOTION_OPERATIONS).size).toBe(NOTION_OPERATIONS.length);
  });
});

describe("what a request to Notion's API holds", () => {
  it("sends a read with the token and the default version, and no body", async () => {
    const fetch = answering(Response.json(page));
    await notion().retrievePage(PAGE);
    const [, init] = fetch.mock.calls[0];
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: "application/json", authorization: "Bearer token-1", "notion-version": "2022-06-28",
    });
    expect(init.body).toBeUndefined();
  });

  it("sends a write as JSON, and a data source's query with the data-source version", async () => {
    const fetch = answering(Response.json(noResults));
    await notion().queryDataSource(SOURCE, { page_size: 1 });
    const [, init] = fetch.mock.calls[0];
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: "application/json", authorization: "Bearer token-1", "content-type": "application/json",
      "notion-version": "2025-09-03",
    });
    expect(init.body).toBe(JSON.stringify({ page_size: 1 }));
  });

  it("sends a token request as JSON with the client's credentials", async () => {
    const fetch = answering(Response.json(grant));
    await exchange();
    const [, init] = fetch.mock.calls[0];
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: "application/json", authorization: `Basic ${btoa("client:secret")}`,
      "content-type": "application/json", "notion-version": "2022-06-28",
    });
    expect(init.body).toBe(JSON.stringify({
      grant_type: "authorization_code", code: "code", redirect_uri: "https://gadgets.example/oauth",
    }));
  });

  it("gives every request, a token's included, 30 seconds for each attempt", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answering(Response.json(page), Response.json(noResults), Response.json(grant));
    await notion().retrievePage(PAGE);
    await notion().search({ query: "plan" });
    await refresh();
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
  });

  it("follows no redirect, and fails on one", async () => {
    const fetch = answering(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    await expect(notion().retrievePage(PAGE)).rejects.toMatchObject({ name: "NotionApiError", status: 302 });
    await expect(refresh()).rejects.toMatchObject({ name: "NotionApiError", status: 302 });
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(["manual", "manual"]);
    expect(counted()).toEqual([["pages.get", "error", "http", 302], ["token.refresh", "error", "http", 302]]);
  });
});

describe("which requests are sent again", () => {
  it.each([
    ["a rate limit", 429, ["refused", "rate", 429]],
    ["a bad gateway", 502, ["error", "http", 502]],
    ["an outage", 503, ["error", "http", 503]],
    ["a gateway timeout", 504, ["error", "http", 504]],
  ])("sends a read three times when Notion keeps answering %s, and throws the last answer", async (_name, status, outcome) => {
    const fetch = answering(failing(status, { code: "unavailable", message: "Try again." }));
    await expect(notion().retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status, code: "unavailable", message: "Try again.",
    });
    expect(sent(fetch)).toEqual(Array.from({ length: 3 }, () => ["GET", `${API}/pages/${PAGE}`]));
    expect(counted()).toEqual(Array.from({ length: 3 }, () => ["pages.get", ...outcome]));
  });

  it("answers a read with what Notion says once it recovers", async () => {
    const fetch = answering(failing(503), Response.json(page));
    await expect(notion().retrievePage(PAGE)).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["pages.get", "error", "http", 503], ["pages.get", "success", "", 200]]);
  });

  it("sends a read three times when the network fails, and throws what fetch threw", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const failure = new TypeError("fetch failed");
    const fetch = answering(failure);
    await expect(notion().retrievePage(PAGE)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual(Array.from({ length: 3 }, () => ["pages.get", "error", "network", 0]));
  });

  it("sends a read once when Notion answers a status that is not transient", async () => {
    const fetch = answering(failing(500), failing(404, { code: "object_not_found", message: "Not found" }));
    await expect(notion().retrievePage(PAGE)).rejects.toMatchObject({ status: 500 });
    await expect(notion().retrievePage(PAGE)).rejects.toMatchObject({ status: 404, code: "object_not_found" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["pages.get", "error", "http", 500], ["pages.get", "error", "http", 404]]);
  });

  it.each<[string, (api: NotionApi) => Promise<unknown>]>([
    ["search", api => api.search({ query: "plan" })],
    ["data_sources.query", api => api.queryDataSource(SOURCE, {})],
    ["pages.create", api => api.createPage({ parent: { page_id: PAGE } })],
    ["pages.patch", api => api.updatePage(PAGE, { archived: true })],
    ["children.patch", api => api.appendBlockChildren(PAGE, [])],
    ["blocks.delete", api => api.deleteBlock(BLOCK)],
    ["comments.create", api => api.createComment(comment)],
  ])("sends %s once, whether Notion answers an outage or the network fails", async (name, call) => {
    const unavailable = answering(failing(503));
    await expect(call(notion())).rejects.toMatchObject({ name: "NotionApiError", status: 503 });
    const failure = new TypeError("fetch failed");
    const lost = answering(failure);
    await expect(call(notion())).rejects.toBe(failure);
    expect([unavailable, lost].map(fetch => fetch.mock.calls.length)).toEqual([1, 1]);
    expect(counted()).toEqual([[name, "error", "http", 503], [name, "error", "network", 0]]);
  });

  it.each(TOKEN_REQUESTS)("sends %s once, whether Notion answers an outage or the network fails", async (name, call) => {
    const unavailable = answering(failing(503));
    await expect(call()).rejects.toMatchObject({ name: "NotionApiError", status: 503 });
    const failure = new TypeError("fetch failed");
    const lost = answering(failure);
    await expect(call()).rejects.toBe(failure);
    expect([unavailable, lost].map(fetch => fetch.mock.calls.length)).toEqual([1, 1]);
    expect(counted()).toEqual([[name, "error", "http", 503], [name, "error", "network", 0]]);
  });
});

// A global fetch whose first answer is a 401 and whose second is a success whose body fails as
// its attempt's timeout fires. `later` answers every send after those.
function cutOffAfterRefresh(later: () => Response) {
  const attempts: AbortController[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const attempt = new AbortController();
    attempts.push(attempt);
    return attempt.signal;
  });
  const stalled = () => new Response(new ReadableStream({
    pull(controller) {
      const reason = new DOMException("The operation timed out.", "TimeoutError");
      attempts.at(-1)?.abort(reason);
      controller.error(reason);
    },
  }));
  const fetch = vi.fn(async (..._sent: Sent) => {
    if (fetch.mock.calls.length === 1) return unauthorized();
    return fetch.mock.calls.length === 2 ? stalled() : later();
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, stalled };
}

// A global fetch whose first answer is a 401 with a body that gives its first bytes when it is
// read and never ends, and whose later answers are `later`'s. `pulls` is how many times the body
// was asked for bytes, and `cancelled` is called when the body is let go.
function unauthorizedWithOpenBody(later: () => Response) {
  let pulled = 0;
  const cancelled = vi.fn();
  const open = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0) controller.enqueue(new TextEncoder().encode('{"code":"unauthorized","message":"'));
    },
    cancel: () => void cancelled(),
  }, { highWaterMark: 0 }), { status: 401 });
  const fetch = vi.fn(async (..._sent: Sent) => fetch.mock.calls.length === 1 ? open() : later());
  vi.stubGlobal("fetch", fetch);
  return { fetch, pulls: () => pulled, cancelled };
}

// A turn of the event loop, as a request that crosses the network takes at least.
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// A global fetch whose first answer is a 401 whose body can be read until `expire` is called and
// fails from then on, as the runtime fails what is read of an answer, a copy of it included, once
// the timeout of its attempt has fired. Its later answers are `later`'s.
function unauthorizedUntilExpired(later: () => Promise<Response>) {
  let expired = false;
  const first = () => {
    const chunks = [new TextEncoder().encode('{"code":"unauthorized","message":"API token is invalid."}')];
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (expired) return controller.error(new DOMException("The operation timed out.", "TimeoutError"));
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }, { highWaterMark: 0 }), { status: 401 });
  };
  const fetch = vi.fn(async (..._sent: Sent) => fetch.mock.calls.length === 1 ? first() : later());
  vi.stubGlobal("fetch", fetch);
  return { fetch, expire: () => { expired = true; } };
}

describe("a request Notion answers 401", () => {
  it("is sent again once with a refreshed token, each send counted", async () => {
    const fetch = answering(unauthorized(), Response.json(page));
    const refreshed = vi.fn(async () => "token-2");
    await expect(notion(refreshed).retrievePage(PAGE)).resolves.toEqual(page);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(headerOf(fetch, "Authorization")).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([["pages.get", "error", "http", 401], ["pages.get", "success", "", 200]]);
  });

  it("is sent again where it is a write, with the same body", async () => {
    const fetch = answering(unauthorized(), Response.json(page));
    await expect(notion(async () => "token-2").updatePage(PAGE, { archived: true })).resolves.toEqual(page);
    expect(sent(fetch)).toEqual([["PATCH", `${API}/pages/${PAGE}`], ["PATCH", `${API}/pages/${PAGE}`]]);
    expect(fetch.mock.calls.map(([, init]) => init.body)).toEqual(Array.from({ length: 2 }, () => '{"archived":true}'));
  });

  it("throws the second 401 without refreshing again", async () => {
    const fetch = answering(unauthorized());
    const refreshed = vi.fn(async () => "token-2");
    await expect(notion(refreshed).retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", isAuthError: true,
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws the 401 where the refresh fails, and sends nothing more", async () => {
    const fetch = answering(unauthorized());
    await expect(notion(failingRefresh).retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 401, message: "API token is invalid.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws the 401 where the send with the fresh token gets no answer", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = answering(unauthorized(), new TypeError("fetch failed"));
    await expect(notion(async () => "token-2").updatePage(PAGE, { archived: true })).rejects.toMatchObject({
      name: "NotionApiError", status: 401, message: "API token is invalid.",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["pages.patch", "error", "http", 401], ["pages.patch", "error", "network", 0]]);
  });

  it("throws the failed reading of an answer to the fresh token, not the 401", async () => {
    answering(unauthorized(), new Response("<html>", { status: 200 }));
    await expect(notion(async () => "token-2").retrievePage(PAGE)).rejects.toBeInstanceOf(SyntaxError);
    expect(counted()).toEqual([["pages.get", "error", "http", 401], ["pages.get", "error", "parse", 200]]);
  });

  it("throws the 401 where no send of a read with the fresh token gets an answer", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = answering(unauthorized(), new TypeError("fetch failed"));
    const refreshed = vi.fn(async () => "token-2");
    await expect(notion(refreshed).retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", message: "API token is invalid.", isAuthError: true,
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(headerOf(fetch, "Authorization")).toEqual(["Bearer token-1", ...Array.from({ length: 3 }, () => "Bearer token-2")]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 401],
      ...Array.from({ length: 3 }, () => ["pages.get", "error", "network", 0]),
    ]);
  });

  it("throws the 401 where Notion answered a send with the first token alone, and none with the fresh one", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = answering(failing(503), unauthorized(), new TypeError("fetch failed"));
    await expect(notion(async () => "token-2").retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", message: "API token is invalid.",
    });
    expect(headerOf(fetch, "Authorization")).toEqual([
      "Bearer token-1", "Bearer token-1", "Bearer token-2", "Bearer token-2",
    ]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 503], ["pages.get", "error", "http", 401],
      ["pages.get", "error", "network", 0], ["pages.get", "error", "network", 0],
    ]);
  });

  it.each([
    ["an outage", 503, ["error", "http", 503]],
    ["a rate limit", 429, ["refused", "rate", 429]],
  ])("throws the network's failure, not the 401, where the fresh token is answered %s and the sends after it get no answer", async (_name, status, outcome) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const failure = new TypeError("fetch failed");
    const fetch = answering(unauthorized(), failing(status), failure);
    const refreshed = vi.fn(async () => "token-2");
    await expect(notion(refreshed).retrievePage(PAGE)).rejects.toBe(failure);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(headerOf(fetch, "Authorization")).toEqual(["Bearer token-1", ...Array.from({ length: 3 }, () => "Bearer token-2")]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 401], ["pages.get", ...outcome],
      ["pages.get", "error", "network", 0], ["pages.get", "error", "network", 0],
    ]);
  });

  it("throws the network's failure, not the 401, where an answer to the fresh token is cut off and the sends after it get none", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const failure = new TypeError("fetch failed");
    const { fetch } = cutOffAfterRefresh(() => { throw failure; });
    await expect(notion(async () => "token-2").retrievePage(PAGE)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 401], ["pages.get", "error", "timeout", 200],
      ["pages.get", "error", "network", 0], ["pages.get", "error", "network", 0],
    ]);
  });

  it("throws the cut-off reading of an answer to the fresh token where every attempt ends so", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const cut = cutOffAfterRefresh(() => cut.stalled());
    await expect(notion(async () => "token-2").retrievePage(PAGE)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cut.fetch).toHaveBeenCalledTimes(4);
  });

  it("throws the answer to the fresh token where that is another failure", async () => {
    answering(unauthorized(), Response.json({ code: "restricted_resource", message: "Not allowed." }, { status: 403 }));
    await expect(notion(async () => "token-2").retrievePage(PAGE)).rejects.toMatchObject({
      status: 403, code: "restricted_resource", isAuthError: false,
    });
  });

  it("is thrown at once by a client that has no refresh", async () => {
    const fetch = answering(unauthorized());
    await expect(notion().retrievePage(PAGE)).rejects.toMatchObject({ status: 401, isAuthError: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (api: NotionApi) => Promise<unknown>, string, string, string | undefined]>([
    ["a read", api => api.retrievePage(PAGE), "pages.get", "GET", undefined],
    ["a write", api => api.updatePage(PAGE, { archived: true }), "pages.patch", "PATCH", '{"archived":true}'],
  ])("refreshes the token and sends %s again while the body of the 401 stays open", async (_kind, call, name, method, body) => {
    const { fetch, cancelled } = unauthorizedWithOpenBody(() => Response.json(page));
    const refreshed = vi.fn(async () => "token-2");
    await expect(call(notion(refreshed))).resolves.toEqual(page);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(sent(fetch)).toEqual(Array.from({ length: 2 }, () => [method, `${API}/pages/${PAGE}`]));
    expect(fetch.mock.calls.map(([, init]) => init.body)).toEqual([body, body]);
    expect(headerOf(fetch, "Authorization")).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([[name, "error", "http", 401], [name, "success", "", 200]]);
    // Nothing waits for the rest of the body, and nothing holds it open.
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  });

  it("asks for the fresh token before it reads anything of the 401", async () => {
    const { pulls } = unauthorizedWithOpenBody(() => Response.json(page));
    const pullsAtRefresh: number[] = [];
    await notion(async () => {
      pullsAtRefresh.push(pulls());
      return "token-2";
    }).retrievePage(PAGE);
    expect(pullsAtRefresh).toEqual([0]);
  });

  it("reads the body of the 401 where the refresh fails, and throws what it says", async () => {
    const refused = unauthorized();
    const fetch = vi.fn(async (..._sent: Sent) => refused);
    vi.stubGlobal("fetch", fetch);
    const refreshed = vi.fn(failingRefresh);
    await expect(notion(refreshed).updatePage(PAGE, { archived: true })).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", message: "API token is invalid.",
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["pages.patch", "error", "http", 401]]);
    // The error was read from a copy: the answer's own body, which nothing reads, is let go.
    expect(refused.bodyUsed).toBe(true);
  });

  it("throws what the 401 said where the send with the fresh token times out after the 401's own attempt has", async () => {
    const expiring = unauthorizedUntilExpired(async () => {
      await turn();
      expiring.expire();
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(notion(async () => "token-2").updatePage(PAGE, { archived: true })).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", message: "API token is invalid.", isAuthError: true,
    });
    expect(headerOf(expiring.fetch, "Authorization")).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([["pages.patch", "error", "http", 401], ["pages.patch", "error", "network", 0]]);
  });

  it("throws what the 401 said where the refresh fails after the 401's own attempt has timed out", async () => {
    const expiring = unauthorizedUntilExpired(async () => Response.json(page));
    const refreshed = vi.fn(async (): Promise<string> => {
      await turn();
      expiring.expire();
      throw new Error("no refresh token");
    });
    await expect(notion(refreshed).retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", message: "API token is invalid.", isAuthError: true,
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(expiring.fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["pages.get", "error", "http", 401]]);
  });

  it("gives the sends before the 401 and after it the three attempts of one read", async () => {
    const fetch = answering(failing(503), unauthorized(), failing(503, { code: "unavailable", message: "Try again." }));
    const refreshed = vi.fn(async () => "token-2");
    await expect(notion(refreshed).retrievePage(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 503, code: "unavailable",
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(headerOf(fetch, "Authorization")).toEqual([
      "Bearer token-1", "Bearer token-1", "Bearer token-2", "Bearer token-2",
    ]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 503], ["pages.get", "error", "http", 401],
      ["pages.get", "error", "http", 503], ["pages.get", "error", "http", 503],
    ]);
  });
});

// The bytes of each piece a streamed body gives when it is read.
const PIECE = 1024;

// A global fetch whose first answer is a 401 whose body is `bytes` bytes of JSON that holds
// Notion's code and message, given a piece at a time as it is read, and whose later answers are
// `later`'s. `declared` has the answer name its length. `pulled` is how many bytes the body gave,
// and `cancelled` is called when the body is let go.
function unauthorizedWithBodyOf(bytes: number, later: () => Promise<Response>, declared = false) {
  const head = new TextEncoder().encode('{"code":"unauthorized","message":"API token is invalid.","padding":"');
  const tail = new TextEncoder().encode('"}');
  function* pieces() {
    yield head;
    for (let left = bytes - head.byteLength - tail.byteLength; left > 0; left -= PIECE) {
      yield new Uint8Array(Math.min(left, PIECE)).fill(0x61);
    }
    yield tail;
  }
  let pulled = 0;
  const cancelled = vi.fn();
  const first = () => {
    const body = pieces();
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = body.next();
        if (next.done) return controller.close();
        pulled += next.value.byteLength;
        controller.enqueue(next.value);
      },
      cancel: () => void cancelled(),
    }, { highWaterMark: 0 }), {
      status: 401, statusText: "Unauthorized", headers: declared ? { "Content-Length": String(bytes) } : {},
    });
  };
  const fetch = vi.fn(async (..._sent: Sent) => fetch.mock.calls.length === 1 ? first() : later());
  vi.stubGlobal("fetch", fetch);
  return { fetch, pulled: () => pulled, cancelled };
}

// A refresh and an answer that each take a turn of the event loop, in which a body that is read
// without a bound is read whole.
const slowRefresh = async () => {
  await turn();
  return "token-2";
};
const slowPage = async () => {
  await turn();
  return Response.json(page);
};
// A send that gets no answer.
const noAnswer = async (): Promise<Response> => { throw new TypeError("fetch failed"); };

describe("the body of a 401 that is kept for its error", () => {
  const MIB = 1024 * 1024;
  // The error of a 401 by its status alone.
  const statusOnly = {
    name: "NotionApiError", status: 401, message: "401 Unauthorized", code: undefined, isAuthError: true,
  };

  it.each([
    // The cap, the piece that crosses it and the one a copied body reads ahead.
    ["declares no length", false, MAX_HELD_ERROR_BYTES + 2 * PIECE],
    // The piece a copied body reads ahead.
    ["declares its length", true, PIECE],
  ])("reads no more than the cap of an 8 MiB 401 that %s, and returns the answer to the fresh token", async (_kind, declared, most) => {
    const large = unauthorizedWithBodyOf(8 * MIB, slowPage, declared);
    const refreshed = vi.fn(slowRefresh);
    await expect(notion(refreshed).retrievePage(PAGE)).resolves.toEqual(page);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(headerOf(large.fetch, "Authorization")).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([["pages.get", "error", "http", 401], ["pages.get", "success", "", 200]]);
    expect(large.pulled()).toBeLessThanOrEqual(most);
    // Neither the answer nor its copy holds the body open.
    await vi.waitFor(() => expect(large.cancelled).toHaveBeenCalledTimes(1));
    expect(large.pulled()).toBeLessThanOrEqual(most);
  });

  it("throws the 401 by its status alone where its body is over the cap and the send with the fresh token gets no answer", async () => {
    const large = unauthorizedWithBodyOf(MAX_HELD_ERROR_BYTES + 1, noAnswer);
    await expect(notion(slowRefresh).updatePage(PAGE, { archived: true })).rejects.toMatchObject(statusOnly);
    expect(large.fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["pages.patch", "error", "http", 401], ["pages.patch", "error", "network", 0]]);
    // The body ended with the byte that passed the cap: all of it was there to be read.
    expect(large.pulled()).toBe(MAX_HELD_ERROR_BYTES + 1);
  });

  it.each([
    // The cap, the piece that crosses it and the one a copied body reads ahead.
    ["declares no length", false, MAX_HELD_ERROR_BYTES + 2 * PIECE],
    // The piece a copied body reads ahead.
    ["declares its length", true, PIECE],
  ])("lets go of an 8 MiB 401 that %s where the send with the fresh token gets no answer", async (_kind, declared, most) => {
    const large = unauthorizedWithBodyOf(8 * MIB, noAnswer, declared);
    await expect(notion(slowRefresh).updatePage(PAGE, { archived: true })).rejects.toMatchObject(statusOnly);
    expect(large.fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["pages.patch", "error", "http", 401], ["pages.patch", "error", "network", 0]]);
    // The reading that the cap stopped let go of the copy, so that nothing holds the body open.
    await vi.waitFor(() => expect(large.cancelled).toHaveBeenCalledTimes(1));
    expect(large.pulled()).toBeLessThanOrEqual(most);
  });

  it("throws the 401 by its status alone where its body is over the cap and the refresh fails", async () => {
    const large = unauthorizedWithBodyOf(8 * MIB, slowPage);
    const refreshed = vi.fn(async (): Promise<string> => {
      await turn();
      throw new Error("no refresh token");
    });
    await expect(notion(refreshed).retrievePage(PAGE)).rejects.toMatchObject(statusOnly);
    expect(large.fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["pages.get", "error", "http", 401]]);
    expect(large.pulled()).toBeLessThanOrEqual(MAX_HELD_ERROR_BYTES + 2 * PIECE);
    await vi.waitFor(() => expect(large.cancelled).toHaveBeenCalledTimes(1));
  });

  it("throws what a 401 of the cap's size said where the send with the fresh token gets no answer", async () => {
    const small = unauthorizedWithBodyOf(MAX_HELD_ERROR_BYTES, noAnswer);
    await expect(notion(slowRefresh).updatePage(PAGE, { archived: true })).rejects.toMatchObject({
      name: "NotionApiError", status: 401, code: "unauthorized", message: "API token is invalid.", isAuthError: true,
    });
    expect(small.pulled()).toBe(MAX_HELD_ERROR_BYTES);
    expect(counted()).toEqual([["pages.patch", "error", "http", 401], ["pages.patch", "error", "network", 0]]);
  });
});

describe("how an answer of Notion's API is read and counted", () => {
  it("answers a 204 with nothing", async () => {
    answering(new Response(null, { status: 204 }));
    await expect(notion().deleteBlock(BLOCK)).resolves.toBeUndefined();
    expect(counted()).toEqual([["blocks.delete", "success", "", 204]]);
  });

  it("throws a failure that is no JSON with its status line", async () => {
    answering(new Response("<html>", { status: 500, statusText: "Internal Server Error" }));
    await expect(notion().search({})).rejects.toMatchObject({
      name: "NotionApiError", status: 500, message: "500 Internal Server Error", code: undefined,
    });
    expect(counted()).toEqual([["search", "error", "http", 500]]);
  });

  it("counts a success that is no JSON as an answer that could not be parsed", async () => {
    answering(new Response("<html>", { status: 200 }));
    await expect(notion().search({})).rejects.toBeInstanceOf(SyntaxError);
    expect(counted()).toEqual([["search", "error", "parse", 200]]);
  });

  it.each<[string, (api: NotionApi) => Promise<unknown>, () => Response, string, string]>([
    ["the bot user that holds nothing", api => api.getBotUser(), () => Response.json(null), "users.me",
      "Cannot read properties of null (reading 'id')"],
    ["a user that holds nothing", api => api.retrieveUser(USER), () => Response.json(null), "users.get",
      "Cannot read properties of null (reading 'id')"],
    ["a user answered no content", api => api.retrieveUser(USER), () => new Response(null, { status: 204 }), "users.get",
      "Cannot read properties of undefined (reading 'id')"],
    ["appended blocks that are no list", api => api.appendBlockChildren(PAGE, []), () => Response.json({}), "children.patch",
      "Cannot read properties of undefined (reading 'map')"],
    ["an appended block that is none", api => api.appendBlockChildren(PAGE, []), () => Response.json({ results: [null] }),
      "children.patch", "Cannot read properties of null (reading 'id')"],
    ["a page of a block tree that holds nothing", api => api.fetchBlockTree(PAGE), () => Response.json(null), "children.list",
      "Cannot read properties of null (reading 'results')"],
  ])("counts %s as an error of the API, sent once and failing as its reading does", async (_what, call, answer, name, message) => {
    const fetch = answering(answer());

    const thrown: unknown = await call(notion(async () => "token-2")).catch((error: unknown) => error);

    expect(Object.getPrototypeOf(thrown)).toBe(TypeError.prototype);
    expect(thrown).toMatchObject({ message });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([[name, "error", "api", answer().status]]);
  });

  it.each<[string, unknown, string]>([
    ["a page of a block tree that holds no list", {}, "Notion answered a listing with no list."],
    ["a page of a block tree that promises more and names no cursor",
      { results: [block("b1")], has_more: true, next_cursor: null }, "Notion answered a page that names no cursor for the page after it."],
  ])("counts %s as an error of the API, sent once", async (_what, body, message) => {
    const fetch = answering(Response.json(body));
    const thrown: unknown = await notion().fetchBlockTree(PAGE).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotionApiError);
    expect(thrown).toMatchObject({ status: 502, message });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["children.list", "error", "api", 200]]);
  });

  it("counts a listing that promises more and names no cursor as an error of the API, and a last page with none as a page", async () => {
    answering(Response.json({ results: [], has_more: true, next_cursor: null }));
    await expect(notion().listBlockChildren(PAGE)).rejects.toMatchObject({
      message: "Notion answered a page that names no cursor for the page after it.",
    });
    answering(Response.json({ results: [], has_more: false, next_cursor: null }));
    await expect(notion().listBlockChildren(PAGE)).resolves.toMatchObject({ results: [] });
    expect(counted()).toEqual([["children.list", "error", "api", 200], ["children.list", "success", "", 200]]);
  });

  it("reads the children of the blocks before one that cannot be read, then fails on that one, its page counted as an error of the API", async () => {
    const fetch = answeringByPath({
      [`/v1/blocks/${PAGE}/children`]: () => ({ results: [block("b1", true), null, block("b2", true)], has_more: true, next_cursor: "c1" }),
      "/v1/blocks/b1/children": () => ({ results: [block("b3")], has_more: false, next_cursor: null }),
    });

    const thrown: unknown = await notion().fetchBlockTree(PAGE).catch((error: unknown) => error);

    expect(Object.getPrototypeOf(thrown)).toBe(TypeError.prototype);
    expect(thrown).toMatchObject({ message: "Cannot read properties of null (reading 'type')" });
    expect(sent(fetch)).toEqual([["GET", `${API}/blocks/${PAGE}/children`], ["GET", `${API}/blocks/b1/children`]]);
    expect(counted().toSorted()).toEqual([["children.list", "error", "api", 200], ["children.list", "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([1, 1]);
  });

  it("counts a listing that holds no list as an error of the API, and refuses it within the request", async () => {
    answering(Response.json({}));
    await expect(notion().listBlockChildren(PAGE)).rejects.toMatchObject({
      name: "NotionApiError", status: 502, message: "Notion answered a listing with no list.",
    });
    expect(counted()).toEqual([["children.list", "error", "api", 200]]);
  });

  it("counts a listing that is empty as a page", async () => {
    answering(Response.json({ results: [], has_more: false }));
    await expect(notion().listBlockChildren(PAGE)).resolves.toEqual({ results: [], has_more: false });
    expect(counted()).toEqual([["children.list", "success", "", 200]]);
  });

  it("writes nothing an answer, a path or a token holds", async () => {
    answering(Response.json({ code: "restricted_resource", message: "Secret refusal about the plan" }, { status: 403 }));
    await expect(new NotionApi(async () => "secret-token").retrievePage(PAGE)).rejects.toBeInstanceOf(NotionApiError);
    expect(points).toHaveLength(1);
    const written = JSON.stringify(points);
    for (const secret of [PAGE, "secret", "Secret", "restricted", "api.notion.com"]) expect(written).not.toContain(secret);
  });
});

describe("how a token request is counted", () => {
  it("counts an OAuth error inside a 200 as an error of the API, and throws it", async () => {
    const fetch = answering(Response.json({ error: "invalid_grant", error_description: "revoked" }));
    await expect(refresh()).rejects.toMatchObject({
      name: "NotionApiError", status: 200, message: "invalid_grant: revoked", code: "invalid_grant",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.refresh", "error", "api", 200]]);
  });

  it("counts a 200 with no access token as an error of the API", async () => {
    answering(Response.json({ bot_id: "bot" }, { statusText: "OK" }));
    await expect(exchange()).rejects.toMatchObject({
      name: "NotionApiError", status: 200, message: "Notion OAuth token request failed: 200 OK",
    });
    expect(counted()).toEqual([["token.exchange", "error", "api", 200]]);
  });

  it("counts a 200 that is no JSON as an answer that could not be parsed", async () => {
    answering(new Response("<html>", { status: 200, statusText: "OK" }));
    await expect(refresh()).rejects.toMatchObject({
      name: "NotionApiError", status: 200, message: "Notion OAuth token request failed: 200 OK",
    });
    expect(counted()).toEqual([["token.refresh", "error", "parse", 200]]);
  });

  it.each([
    [400, { name: "NotionApiError", status: 400, message: "invalid_grant", code: "invalid_grant", isAuthError: false }],
    [401, { name: "NotionApiError", status: 401, message: "invalid_grant", code: "invalid_grant", isAuthError: true }],
  ])("counts a grant refused with a %i by its status, and sends it once", async (status, thrown) => {
    const fetch = answering(Response.json({ error: "invalid_grant" }, { status }));
    await expect(refresh()).rejects.toMatchObject(thrown);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.refresh", "error", "http", status]]);
  });

  it("writes nothing a token request or its answer holds", async () => {
    answering(Response.json({ error: "invalid_client", error_description: "Secret words" }, { status: 401 }));
    await expect(exchangeAuthCode("secret-code", "client-id", "client-secret", "https://gadgets.example/oauth"))
      .rejects.toBeInstanceOf(NotionApiError);
    expect(points).toHaveLength(1);
    const written = JSON.stringify(points);
    for (const secret of ["secret", "Secret", "client-id", "invalid_client", "api.notion.com", "gadgets.example"]) {
      expect(written).not.toContain(secret);
    }
  });
});

describe("the operations whose calls are summed", () => {
  it("writes one point for a block tree read in several pages and levels", async () => {
    const fetch = answeringByPath({
      [`/v1/blocks/${PAGE}/children`]: url => url.searchParams.has("start_cursor")
        ? { results: [block("b3")], has_more: false, next_cursor: null }
        : { results: [block("b1", true), block("b2")], has_more: true, next_cursor: "c1" },
      "/v1/blocks/b1/children": () => ({ results: [block("b4")], has_more: false, next_cursor: null }),
    });
    const tree = await notion().fetchBlockTree(PAGE);
    expect(tree.map(node => [node.block.id, node.children?.map(child => child.block.id)]))
      .toEqual([["b1", ["b4"]], ["b2", undefined], ["b3", undefined]]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual([["children.list", "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([3]);
  });

  it("writes one point for the blocks the revert of an append deletes", async () => {
    const fetch = answering(Response.json({ object: "block" }));
    const store = new NotionStore(memoryKv() as never, notion());
    store.putAction({
      id: 1, action: { type: "appendContent", pageId: PAGE, markdown: "Hello" }, state: "applied",
      submittedAt: 1, appendedBlockIds: ["b1", "b2", "b3"],
    });
    await revertStoredAction(store, 1);
    expect(sent(fetch)).toEqual(["b1", "b2", "b3"].map(id => ["DELETE", `${API}/blocks/${id}`]));
    expect(store.getAction(1)).toMatchObject({ state: "reverted" });
    expect(counted()).toEqual([["blocks.delete", "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([3]);
  });

  it("writes one point per kind of answer for an account's check of several items", async () => {
    const other = "fedcba98-7654-3210-fedc-ba9876543210";
    // A subresource names its item by the ID without dashes, and so does the request for it.
    const fetch = answeringByPath({
      [`/v1/databases/${DATABASE.replaceAll("-", "")}`]: () => database,
      [`/v1/pages/${PAGE.replaceAll("-", "")}`]: () => page,
    });
    const kv = memoryKv();
    kv.put("accessToken", "token-1");
    kv.put("accountInfo", { workspaceId: WORKSPACE });
    const ctx = { storage: { kv, deleteAll: () => {}, deleteAlarm: () => {} }, id: { toString: () => "account" }, exports: {} };
    const account = new UserAccount(ctx as never, { CLIENT_ID: "client", CLIENT_SECRET: "secret" } as never);
    await expect(account.checkSubresourceAccess([DATABASE, PAGE, other].map(id => itemSubresourceId(WORKSPACE, id))))
      .resolves.toEqual([true, true, false]);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(counted().map((point, at) => [...point, columnOf(SUBSERVICE_V1_SLOTS.calls)[at]]).toSorted()).toEqual([
      ["databases.get", "error", "http", 404, 2],
      ["databases.get", "success", "", 200, 1],
      ["pages.get", "error", "http", 404, 1],
      ["pages.get", "success", "", 200, 1],
    ]);
  });
});
