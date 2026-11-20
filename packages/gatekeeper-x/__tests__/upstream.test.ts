// The requests this gatekeeper makes to X and the name each is counted under, and what the
// gatekeeper decides about a call that the client cannot know: an error inside a success, credits
// that are used up, and that nothing is sent twice.

import { env } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XApi, XApiError, XCreditsError, XRateLimitError, XTransportError } from "../src/x-api";
import { X_ROUTES, xUpstream } from "../src/x-upstream";

const API = "https://api.x.com/2";

/** Every kind of request the gatekeeper makes under X's API root, with the name it is counted under. */
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${API}/users/me?user.fields=id`, "users.me"],
  ["GET", `${API}/users/1001?user.fields=connection_status`, "users.get"],
  ["GET", `${API}/users/by/username/alice`, "username.get"],
  ["GET", `${API}/users/1001/tweets?max_results=100`, "tweets.list"],
  ["GET", `${API}/users/1001/mentions`, "mentions.list"],
  ["GET", `${API}/users/1001/liked_tweets`, "liked_tweets.list"],
  ["GET", `${API}/users/1001/followers`, "followers.list"],
  ["GET", `${API}/users/1001/owned_lists?max_results=100`, "owned_lists.list"],
  ["GET", `${API}/users/1001/timelines/reverse_chronological`, "timelines.reverse_chronological"],
  ["GET", `${API}/users/1001/bookmarks`, "bookmarks.list"],
  ["POST", `${API}/users/1001/bookmarks`, "bookmarks.create"],
  ["DELETE", `${API}/users/1001/bookmarks/50`, "bookmarks.delete"],
  ["POST", `${API}/users/1001/likes`, "likes.create"],
  ["DELETE", `${API}/users/1001/likes/50`, "likes.delete"],
  ["POST", `${API}/users/1001/retweets`, "retweets.create"],
  ["DELETE", `${API}/users/1001/retweets/50`, "retweets.delete"],
  ["GET", `${API}/users/1001/following`, "following.list"],
  ["POST", `${API}/users/1001/following`, "following.create"],
  ["DELETE", `${API}/users/1001/following/1002`, "following.delete"],
  ["POST", `${API}/users/1001/muting`, "muting.create"],
  ["DELETE", `${API}/users/1001/muting/1002`, "muting.delete"],
  ["POST", `${API}/tweets`, "tweets.create"],
  ["GET", `${API}/tweets/50?tweet.fields=created_at`, "tweets.get"],
  ["DELETE", `${API}/tweets/50`, "tweets.delete"],
  ["GET", `${API}/tweets/search/recent?query=conversation_id%3A50`, "search.recent"],
  ["GET", `${API}/tweets/50/quote_tweets`, "quote_tweets.list"],
  ["PUT", `${API}/tweets/50/hidden`, "hidden.update"],
  ["POST", `${API}/lists`, "lists.create"],
  ["GET", `${API}/lists/77?list.fields=id`, "lists.get"],
  ["PUT", `${API}/lists/77`, "lists.update"],
  ["DELETE", `${API}/lists/77`, "lists.delete"],
  ["GET", `${API}/lists/77/tweets`, "tweets.list"],
  ["GET", `${API}/lists/77/members`, "members.list"],
  ["POST", `${API}/lists/77/members`, "members.create"],
  ["DELETE", `${API}/lists/77/members/1002`, "members.delete"],
  ["POST", `${API}/media/upload`, "media.upload"],
  ["POST", `${API}/media/metadata`, "metadata.create"],
];

describe("the names of X's requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(xUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(X_ROUTES)).toHaveLength(20);
    expect(unreachedRouteEnds(X_ROUTES, REQUESTS)).toEqual([]);
  });

  it("names a path the tree does not hold, and another host, by the method alone", () => {
    expect(xUpstream.operationOf("GET", `${API}/spaces/1`)).toBe("GET");
    expect(xUpstream.operationOf("DELETE", `${API}/users/1001/blocking/1002`)).toBe("DELETE");
    expect(xUpstream.operationOf("POST", "https://upload.x.example/2/tweets")).toBe("POST");
  });

  it("builds no name from what a path holds in place of an ID", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    expect(words.has(xUpstream.operationOf("GET", `${API}/users/by/username/Some_Handle`))).toBe(true);
    expect(words.has(xUpstream.operationOf("GET", `${API}/lists/secret-list/members`))).toBe(true);
    expect(xUpstream.operationOf("GET", `${API}/users/1001/Some_Handle`)).toBe("GET");
  });
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// A global fetch that answers every request with `status` and `body`, or throws `body`.
function respond(status: number, body?: unknown) {
  const fetch = vi.fn(async () => {
    if (body instanceof Error) throw body;
    return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// A global fetch that answers every request with `status` and a body that cannot be read: one
// whose bytes stop short or, where `declared` is given, one whose headers declare that many bytes.
function respondUnreadable(status: number, declared?: number) {
  const fetch = vi.fn(async () => {
    if (declared !== undefined) return new Response("{}", { status, headers: { "content-length": String(declared) } });
    let pulls = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"type":"https://api.twitter.com/2/problems/cred'));
        else controller.error(new TypeError("reset"));
      },
    }), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

// A method's reading of an envelope: the ID its data names, and a throw for one that names none.
function named(envelope: { data?: { id?: string } }): string {
  if (!envelope.data?.id) throw new RangeError("The answer names no account.");
  return envelope.data.id;
}

describe("the points of X's requests", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
    ambient.SUBSERVICE_METRICS = "true";
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.unstubAllGlobals();
  });

  // Each point written, as its source, service, operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
      COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  it("counts a read and a write under the vendor's source and service, by their routes", async () => {
    respond(200, { data: [{ id: "50" }] });
    await new XApi("t").get("/2/users/1001/tweets", { max_results: 5 });
    await new XApi("t").post("/2/users/1001/likes", { tweet_id: "50" });
    expect(calls()).toEqual([
      ["gatekeeper.x.api", "x", "tweets.list", "success", "", 200],
      ["gatekeeper.x.api", "x", "likes.create", "success", "", 200],
    ]);
  });

  it("counts a success holding errors in place of data as an error of the call", async () => {
    respond(200, { errors: [{ type: "https://api.twitter.com/2/problems/resource-not-found", detail: "No post 50." }] });
    await new XApi("t").get("/2/tweets/50");
    respond(201, { errors: [{ title: "Internal Error", detail: "Something went wrong." }] });
    await new XApi("t").post("/2/tweets", { text: "hi" });
    expect(calls()).toEqual([
      ["gatekeeper.x.api", "x", "tweets.get", "error", "api", 200],
      ["gatekeeper.x.api", "x", "tweets.create", "error", "api", 201],
    ]);
  });

  it.each<[string, string, string]>([
    ["/2/tweets", "post", "tweets.create"],
    ["/2/lists", "List", "lists.create"],
  ])("counts a creation at %s that X accepts without naming what it made as an error of the call", async (path, what, name) => {
    respond(201, { data: {} });
    await expect(new XApi("t").create(path, {}, what)).rejects.toMatchObject({
      status: 502, message: `X accepted the ${what} without returning its ID.`,
    });
    respond(201, { data: { id: "77" } });
    await expect(new XApi("t").create(path, {}, what)).resolves.toBe("77");
    expect(calls()).toEqual([["gatekeeper.x.api", "x", name, "error", "api", 201], ["gatekeeper.x.api", "x", name, "success", "", 201]]);
  });

  it("counts rows with partial errors beside them, and an empty page, as successes", async () => {
    respond(200, { data: [{ id: "50" }], errors: [{ type: "https://api.twitter.com/2/problems/resource-not-found" }] });
    await new XApi("t").get("/2/lists/77/tweets");
    respond(200, { meta: { result_count: 0 } });
    await new XApi("t").get("/2/users/1001/mentions");
    expect(calls().map(([, , operation, outcome, reason]) => [operation, outcome, reason])).toEqual([
      ["tweets.list", "success", ""],
      ["mentions.list", "success", ""],
    ]);
  });

  it("sends a read X refused or failed once, and counts that one send", async () => {
    const limited = respond(429, { title: "Too Many Requests" });
    expect(await failure(new XApi("t").get("/2/users/1001/mentions"))).toBeInstanceOf(XRateLimitError);
    const unavailable = respond(503, "upstream unavailable");
    expect(await failure(new XApi("t").get("/2/users/me"))).toBeInstanceOf(XApiError);
    const lost = respond(0, new TypeError("network connection lost"));
    expect(await failure(new XApi("t").get("/2/tweets/50"))).toBeInstanceOf(XTransportError);
    expect([limited, unavailable, lost].map(fetch => fetch.mock.calls.length)).toEqual([1, 1, 1]);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["mentions.list", "refused", "rate", 429],
      ["users.me", "error", "http", 503],
      ["tweets.get", "error", "network", 0],
    ]);
  });

  it("counts an answer saying the credits are used up as a refusal for capacity, sent once, whatever its status", async () => {
    const unpaid = respond(402, { title: "Payment Required" });
    expect(await failure(new XApi("t").get("/2/users/me"))).toBeInstanceOf(XCreditsError);
    const capped = respond(429, { type: "https://api.twitter.com/2/problems/usage-capped", title: "Usage capped" });
    expect(await failure(new XApi("t").get("/2/users/1001/mentions"))).toBeInstanceOf(XCreditsError);
    const depleted = respond(403, { type: "https://api.twitter.com/2/problems/credits", title: "CreditsDepleted" });
    expect(await failure(new XApi("t").post("/2/tweets", { text: "hi" }))).toBeInstanceOf(XCreditsError);
    const bare = respond(402);
    expect(await failure(new XApi("t").uploadImage(new Uint8Array([1]), "image/png"))).toBeInstanceOf(XCreditsError);
    expect([unpaid, capped, depleted, bare].map(fetch => fetch.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["users.me", "refused", "capacity", 402],
      ["mentions.list", "refused", "capacity", 429],
      ["tweets.create", "refused", "capacity", 403],
      ["media.upload", "refused", "capacity", 402],
    ]);
    const written = JSON.stringify(points);
    for (const held of ["usage-capped", "problems", "CreditsDepleted", "Payment"]) expect(written).not.toContain(held);
  });

  it("counts an answer of any other failing status whose problem names the credits as a refusal for capacity too, sent once", async () => {
    const unavailable = respond(503, { type: "https://api.twitter.com/2/problems/credits", title: "CreditsDepleted" });
    expect(await failure(new XApi("t").get("/2/users/me"))).toMatchObject({ name: "XCreditsError", status: 503 });
    const failed = respond(500, { errors: [{ type: "https://api.twitter.com/2/problems/usage-capped" }] });
    expect(await failure(new XApi("t").post("/2/tweets", { text: "hi" }))).toMatchObject({ name: "XCreditsError", status: 500 });
    const unauthorized = respond(401, { type: "https://api.twitter.com/2/problems/usage-capped", title: "Usage capped" });
    expect(await failure(new XApi("t").get("/2/tweets/50"))).toMatchObject({ name: "XCreditsError", status: 401 });
    const invalid = respond(400, { type: "https://api.twitter.com/2/problems/credits", detail: "No credits are left." });
    expect(await failure(new XApi("t").get("/2/lists/77"))).toMatchObject({ name: "XCreditsError", status: 400 });
    expect([unavailable, failed, unauthorized, invalid].map(fetch => fetch.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["users.me", "refused", "capacity", 503],
      ["tweets.create", "refused", "capacity", 500],
      ["tweets.get", "refused", "capacity", 401],
      ["lists.get", "refused", "capacity", 400],
    ]);
  });

  it("counts an answer about credits whose body cannot be read by its status, sent once: it is read as no XCreditsError", async () => {
    const unreadable = "X's response could not be read; please try again.";
    const cut = respondUnreadable(402);
    expect(await failure(new XApi("t").get("/2/users/me"))).toMatchObject({ name: "XTransportError", message: unreadable });
    const large = respondUnreadable(402, 5 * 1024 * 1024);
    expect(await failure(new XApi("t").post("/2/tweets", { text: "hi" }))).toMatchObject({ name: "XTransportError", message: unreadable });
    const capped = respondUnreadable(429);
    expect(await failure(new XApi("t").get("/2/users/1001/mentions"))).toMatchObject({ name: "XTransportError", message: unreadable });
    expect([cut, large, capped].map(fetch => fetch.mock.calls.length)).toEqual([1, 1, 1]);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["users.me", "error", "http", 402],
      ["tweets.create", "error", "http", 402],
      ["mentions.list", "refused", "rate", 429],
    ]);
  });

  it("counts a refusal that says nothing of credits by its status", async () => {
    respond(429, { type: "https://api.twitter.com/2/problems/too-many-requests", title: "Too Many Requests" });
    expect(await failure(new XApi("t").get("/2/users/1001/mentions"))).toBeInstanceOf(XRateLimitError);
    respond(403, { type: "https://api.twitter.com/2/problems/client-forbidden", detail: "Not allowed." });
    const forbidden = await failure(new XApi("t").post("/2/users/1001/likes", { tweet_id: "50" }));
    expect(forbidden).toBeInstanceOf(XApiError);
    expect(forbidden).not.toBeInstanceOf(XCreditsError);
    respond(400, { detail: "The query is not valid." });
    expect(await failure(new XApi("t").get("/2/tweets/search/recent"))).not.toBeInstanceOf(XCreditsError);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["mentions.list", "refused", "rate", 429],
      ["likes.create", "error", "http", 403],
      ["search.recent", "error", "http", 400],
    ]);
  });

  it("counts a success whose errors name the usage cap, which is answered as an envelope, as an error of the call", async () => {
    respond(200, { errors: [{ type: "https://api.twitter.com/2/problems/usage-capped", title: "Usage capped" }] });
    const envelope = await new XApi("t").get("/2/tweets/50");
    expect(envelope.errors).toHaveLength(1);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["tweets.get", "error", "api", 200],
    ]);
  });

  it("counts a redirect, which is not followed, and a success that is not JSON as errors", async () => {
    respond(302);
    expect(await failure(new XApi("t").get("/2/users/me"))).toMatchObject({ status: 302 });
    respond(200, "<html>");
    expect(await failure(new XApi("t").get("/2/users/me"))).toBeInstanceOf(XTransportError);
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["users.me", "error", "http", 302],
      ["users.me", "error", "parse", 200],
    ]);
  });

  it.each<[string, number, unknown]>([
    ["holds no data", 200, {}],
    ["holds data with no ID", 200, { data: { media_key: "3_1" } }],
    ["holds an empty ID", 201, { data: { id: "" } }],
    ["holds null", 200, null],
    ["holds JSON that is no object", 200, "accepted"],
    ["is empty", 200, undefined],
  ])("counts an image upload an error of the call where a success %s, sent once and failing as the client does", async (_lacking, status, body) => {
    const fetch = respond(status, body === undefined ? undefined : JSON.stringify(body));

    const thrown = await failure(new XApi("t").uploadImage(new Uint8Array([1]), "image/png"));

    expect(Object.getPrototypeOf(thrown)).toBe(XApiError.prototype);
    expect(thrown).toMatchObject({
      status: 502, message: "X accepted the image upload without returning a media ID.", problemType: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["gatekeeper.x.api", "x", "media.upload", "error", "api", status]]);
  });

  it("counts an image upload a success where the answer holds the media's ID, which is returned", async () => {
    const fetch = respond(200, { data: { id: "710511363345354753", media_key: "3_710511363345354753" } });

    expect(await new XApi("t").uploadImage(new Uint8Array([1]), "image/png")).toBe("710511363345354753");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["gatekeeper.x.api", "x", "media.upload", "success", "", 200]]);
  });

  it("counts an image upload X failed by its status, and one whose errors stand in place of data as an error of the call", async () => {
    respond(500, { title: "Internal Error" });
    expect(await failure(new XApi("t").uploadImage(new Uint8Array([1]), "image/png"))).toMatchObject({ status: 500 });
    respond(200, { errors: [{ title: "Invalid media" }] });
    expect(await failure(new XApi("t").uploadImage(new Uint8Array([1]), "image/png"))).toMatchObject({
      status: 502, message: "X accepted the image upload without returning a media ID.",
    });
    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["media.upload", "error", "http", 500],
      ["media.upload", "error", "api", 200],
    ]);
  });

  it("counts a read by what its method makes of the envelope, where the method reads it within the request", async () => {
    const fetch = respond(200, { data: { name: "Alice" } });
    const thrown = await failure(new XApi("t").get("/2/users/me", {}, named));
    expect(Object.getPrototypeOf(thrown)).toBe(RangeError.prototype);
    expect(thrown).toMatchObject({ message: "The answer names no account." });
    expect(fetch).toHaveBeenCalledTimes(1);

    respond(200, { data: { id: "7" } });
    expect(await new XApi("t").get("/2/users/me", {}, named)).toBe("7");

    // An error X answers with is thrown as it is, and is not handed to the method to read.
    respond(404, { title: "Not Found" });
    expect(await failure(new XApi("t").get("/2/users/me", {}, named))).toBeInstanceOf(XApiError);

    expect(calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status])).toEqual([
      ["users.me", "error", "api", 200],
      ["users.me", "success", "", 200],
      ["users.me", "error", "http", 404],
    ]);
  });

  it("writes nothing an answer or a path holds", async () => {
    respond(403, { detail: "Secret refusal about @Some_Handle", type: "https://api.twitter.com/2/problems/secret" });
    await failure(new XApi("secret-token").get("/2/users/by/username/Some_Handle", { query: "secret words" }));
    const written = JSON.stringify(points);
    expect(points).toHaveLength(1);
    for (const secret of ["Some_Handle", "secret", "Secret", "api.x.com", "problems"]) expect(written).not.toContain(secret);
  });
});
