// The requests this gatekeeper makes to Spotify and the name each is counted under, and what the
// gatekeeper decides about a call that the client cannot know: an error inside a success, which
// requests are sent again, and which run summed. These drive the real API client against a stubbed
// fetch and read the points it writes.

import { env } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import {
  SpotifyApi, SpotifyApiError, SpotifyUnnamedCreationError, exchangeAuthCode, isRefreshToken,
  refreshAccessToken,
} from "../src/spotify-api";
import {
  SINGLETON_OPERATIONS, SPOTIFY_ROUTES, TOKEN_OPERATIONS, spotifyUpstream,
} from "../src/spotify-upstream";

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"];

/** Every kind of request the gatekeeper makes under the Web API's root, with the name it is counted under. */
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${API}/me`, "me.get"],
  ["GET", `${API}/tracks/11dFghVXANMlKmJXsNCbNl`, "tracks.get"],
  ["GET", `${API}/albums/4aawyAB9vmqN3uQ7FjRGTy`, "albums.get"],
  ["GET", `${API}/search?q=remaster&type=track%2Calbum&limit=10`, "search"],
  ["GET", `${API}/me/tracks?limit=20&offset=0`, "tracks.list"],
  ["GET", `${API}/me/albums?limit=20&offset=0`, "albums.list"],
  ["GET", `${API}/me/top/tracks?time_range=medium_term&limit=20`, "top.tracks"],
  ["GET", `${API}/me/top/artists?time_range=medium_term&limit=20`, "top.artists"],
  ["PUT", `${API}/me/library?uris=spotify%3Atrack%3A1`, "library.update"],
  ["DELETE", `${API}/me/library?uris=spotify%3Atrack%3A1`, "library.delete"],
  ["GET", `${API}/me/library/contains?uris=spotify%3Atrack%3A1`, "library.contains"],
  ["GET", `${API}/me/playlists?limit=20&offset=0`, "playlists.list"],
  ["POST", `${API}/me/playlists`, "playlists.create"],
  ["GET", `${API}/playlists/37i9dQZF1DXcBWIGoYBM5M`, "playlists.get"],
  ["PUT", `${API}/playlists/37i9dQZF1DXcBWIGoYBM5M`, "playlists.update"],
  ["GET", `${API}/playlists/37i9dQZF1DXcBWIGoYBM5M/items?limit=50&offset=0`, "items.list"],
  ["POST", `${API}/playlists/37i9dQZF1DXcBWIGoYBM5M/items`, "items.create"],
  ["PUT", `${API}/playlists/37i9dQZF1DXcBWIGoYBM5M/items`, "items.update"],
  ["DELETE", `${API}/playlists/37i9dQZF1DXcBWIGoYBM5M/items`, "items.delete"],
  ["GET", `${API}/me/player`, "player.get"],
  ["PUT", `${API}/me/player`, "player.update"],
  ["GET", `${API}/me/player/devices`, "devices.list"],
  ["GET", `${API}/me/player/queue`, "queue.list"],
  ["POST", `${API}/me/player/queue?uri=spotify%3Atrack%3A1`, "queue.create"],
  ["GET", `${API}/me/player/recently-played?limit=20`, "recently-played.list"],
  ["PUT", `${API}/me/player/play?device_id=d1`, "player.play"],
  ["PUT", `${API}/me/player/pause`, "player.pause"],
  ["PUT", `${API}/me/player/seek?position_ms=1000`, "player.seek"],
  ["PUT", `${API}/me/player/volume?volume_percent=40`, "player.volume"],
  ["PUT", `${API}/me/player/shuffle?state=true`, "player.shuffle"],
  ["PUT", `${API}/me/player/repeat?state=off`, "player.repeat"],
  ["POST", `${API}/me/player/next`, "player.next"],
  ["POST", `${API}/me/player/previous`, "player.previous"],
];

// One request the stubbed fetch was handed.
type Sent = { method: string; url: string; init: RequestInit };

// What a stubbed fetch answers a request with: a response, or an error to throw.
type Answer = Response | Error;

// A JSON answer.
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });
}

// A global fetch that answers each request with what `answerOf` gives for it, and the requests
// it was handed.
function answering(answerOf: (sent: Sent, sends: number) => Answer): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = { method: init.method ?? "GET", url: String(input), init };
    sent.push(request);
    const answer = answerOf(request, sent.length);
    if (answer instanceof Error) throw answer;
    return answer;
  }));
  return sent;
}

// The Web API's answer to a request that nothing in a test turns on: an answer for each URI of a
// check of the library's membership, a playlist named by its id for the creation of one, an
// empty object otherwise.
// The paths a page of a listing is answered at.
const PAGED = ["/me/tracks", "/me/albums", "/top/tracks", "/top/artists", "/me/playlists", "/items", "/recently-played"];

function plainAnswer({ method, url }: Sent): Response {
  const asked = new URL(url);
  if (asked.pathname.endsWith("/contains")) {
    return json(200, (asked.searchParams.get("uris") ?? "").split(",").map(() => false));
  }
  if (method === "POST" && asked.pathname === "/v1/me/playlists") return json(200, { id: "p1" });
  // A page of a listing holds a list of items, which may be empty.
  return json(200, method === "GET" && PAGED.some(path => asked.pathname.endsWith(path)) ? { items: [] } : {});
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const api = (getToken: () => Promise<string> = async () => "access-token") => new SpotifyApi(getToken);

// Calls every method of the API client once.
async function callEveryMethod(client: SpotifyApi): Promise<void> {
  await client.getCurrentUser();
  await client.getTrack("t1");
  await client.getAlbum("a1");
  await client.getTracks(["t1", "t2"]);
  await client.getAlbums(["a1", "a2"]);
  await client.search("remaster", ["track", "album"], 10);
  await client.listSavedTracks(20, 0);
  await client.listSavedAlbums(20, 0);
  await client.getTopTracks("medium_term", 20);
  await client.getTopArtists("medium_term", 20);
  await client.saveToLibrary(["spotify:track:1"]);
  await client.removeFromLibrary(["spotify:track:1"]);
  await client.libraryContains(["spotify:track:1"]);
  await client.listMyPlaylists(20, 0);
  await client.getPlaylist("p1");
  await client.listPlaylistItems("p1", 50, 0);
  await client.createPlaylist({ name: "Mix" });
  await client.addPlaylistItems("p1", ["spotify:track:1"]);
  await client.removePlaylistItems("p1", ["spotify:track:1"]);
  await client.replacePlaylistItems("p1", ["spotify:track:1"]);
  await client.reorderPlaylistItems("p1", 0, 2, 1);
  await client.changePlaylistDetails("p1", { name: "Mix 2" });
  await client.getPlaybackState();
  await client.getDevices();
  await client.getQueue();
  await client.getRecentlyPlayed(20);
  await client.play("d1", {});
  await client.pause();
  await client.next();
  await client.previous();
  await client.seek(1000);
  await client.setVolume(40);
  await client.setShuffle(true);
  await client.setRepeat("off");
  await client.transfer("d1", true);
  await client.addToQueue("spotify:track:1");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the names of Spotify's requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(spotifyUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(SPOTIFY_ROUTES)).toHaveLength(21);
    expect(unreachedRouteEnds(SPOTIFY_ROUTES, REQUESTS)).toEqual([]);
  });

  it("names a path the tree does not hold, another host and the token endpoint by the method alone", () => {
    expect(spotifyUpstream.operationOf("GET", `${API}/artists/0TnOYISbd1XYRBk9myaseg`)).toBe("GET");
    expect(spotifyUpstream.operationOf("DELETE", `${API}/me/following?type=artist`)).toBe("DELETE");
    expect(spotifyUpstream.operationOf("GET", "https://api.spotify.example/v1/me")).toBe("GET");
    expect(spotifyUpstream.operationOf("POST", TOKEN_URL)).toBe("POST");
  });

  it("builds no name from what a path holds in place of an ID", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    expect(words.has(spotifyUpstream.operationOf("GET", `${API}/tracks/Secret_Track`))).toBe(true);
    expect(words.has(spotifyUpstream.operationOf("POST", `${API}/playlists/secret-list/items`))).toBe(true);
    expect(spotifyUpstream.operationOf("GET", `${API}/me/Secret_Track`)).toBe("GET");
  });

  it("names the read of a singleton, and nothing else, by the singleton's literal", () => {
    const names = REQUESTS.map(([, , name]) => name);
    for (const literal of SINGLETON_OPERATIONS) expect(names).toContain(literal);
    expect(spotifyUpstream.operationOf("GET", `${API}/me/`)).toBe("me.get");
    expect(spotifyUpstream.operationOf("GET", `${API}/me/player?market=ES`)).toBe("player.get");
    expect(spotifyUpstream.operationOf("PUT", `${API}/me/player`)).toBe("player.update");
  });

  it("holds a row for every request the API client's methods send, and no other", async () => {
    const sent = answering(plainAnswer);
    await callEveryMethod(api());
    const names = new Set(sent.map(({ method, url }) => spotifyUpstream.operationOf(method, url)));
    expect([...names].filter(name => HTTP_METHODS.includes(name))).toEqual([]);
    expect([...names].toSorted()).toEqual([...new Set(REQUESTS.map(([, , name]) => name))].toSorted());
    const kinds = new Set(sent.map(({ method, url }) => `${method} ${spotifyUpstream.operationOf(method, url)}`));
    expect([...kinds].toSorted()).toEqual(REQUESTS.map(([method, , name]) => `${method} ${name}`).toSorted());
  });
});

type Point = { blobs?: unknown[]; doubles?: unknown[] };

// A written point's value in one column.
function column(point: Point, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

describe("the points of Spotify's requests", () => {
  const ambient = env as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
  let points: Point[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void points.push(point) };
    ambient.SUBSERVICE_METRICS = "true";
    // No wait between the sends of a request: a backoff is a random share of its ceiling.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  // Each point written, as its operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
      SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  it("counts a read and a write under the vendor's source and service, by their routes", async () => {
    answering(plainAnswer);
    await api().listPlaylistItems("p1", 50, 0);
    await api().createPlaylist({ name: "Mix" });
    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
      COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)))).toEqual([
      ["gatekeeper.spotify.api", "spotify", "items.list", "success", "", 200],
      ["gatekeeper.spotify.api", "spotify", "playlists.create", "success", "", 200],
    ]);
  });

  it("counts every request the API client's methods send under a name of the table", async () => {
    answering(plainAnswer);
    await callEveryMethod(api());
    const operations = new Set(points.map(point => column(point, SUBSERVICE_V1_SLOTS.operation)));
    expect([...operations].toSorted()).toEqual([...new Set(REQUESTS.map(([, , name]) => name))].toSorted());
  });

  it("sends a request with its bearer token, its JSON body, a 30 second timeout and no redirect followed", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const sent = answering(plainAnswer);
    await api().addPlaylistItems("p 1", ["spotify:track:1"], 3);
    expect(sent).toHaveLength(1);
    const [{ method, url, init }] = sent;
    expect([method, url]).toEqual(["POST", `${API}/playlists/p%201/items`]);
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      authorization: "Bearer access-token", "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ uris: ["spotify:track:1"], position: 3 }));
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeouts.mock.calls).toEqual([[30_000]]);
  });

  it("counts a code's exchange and a token's refresh under their literals, each sent once as a form", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const sent = answering(() => json(200, {
      access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800, scope: "a b",
    }));
    expect(await exchangeAuthCode("the-code", "client", "secret", "https://gk.example/oauth")).toEqual({
      accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 1800, scopes: ["a", "b"],
    });
    await refreshAccessToken("old-refresh", "client", "secret");
    expect(sent.map(({ method, url, init }) => [method, url, init.body, init.redirect])).toEqual([
      ["POST", TOKEN_URL, "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fgk.example%2Foauth", "manual"],
      ["POST", TOKEN_URL, "grant_type=refresh_token&refresh_token=old-refresh", "manual"],
    ]);
    expect(Object.fromEntries(new Headers(sent[0].init.headers))).toEqual({
      accept: "application/json",
      authorization: `Basic ${btoa("client:secret")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(timeouts.mock.calls).toEqual([[30_000], [30_000]]);
    expect(calls()).toEqual([
      ["token.exchange", "success", "", 200],
      ["token.refresh", "success", "", 200],
    ]);
    expect(calls().map(([operation]) => operation)).toEqual([...TOKEN_OPERATIONS]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.service))).toEqual(["spotify", "spotify"]);
  });

  it("counts a token success that holds no access token as an error of the call", async () => {
    answering(() => json(200, { error: "server_error" }));
    const error = await failure(refreshAccessToken("old-refresh", "client", "secret"));
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error).toMatchObject({
      status: 400, message: "Spotify token exchange did not return an access token.",
      details: { error: "server_error" }, isAuthError: false,
    });
    expect(calls()).toEqual([["token.refresh", "error", "api", 200]]);
  });

  it.each([
    ["no refresh token", { access_token: "new-access", expires_in: 1800 }],
    ["an empty refresh token", { access_token: "new-access", refresh_token: "", expires_in: 1800 }],
  ])("counts a code's exchange answered 200 with %s as an error of the call, and such a refresh as a success", async (_, body) => {
    const sent = answering(() => json(200, body));
    const grant = await exchangeAuthCode("the-code", "client", "secret", "https://gk.example/oauth");
    expect(grant).toMatchObject({ accessToken: "new-access", expiresIn: 1800, scopes: [] });
    expect(isRefreshToken(grant.refreshToken)).toBe(false);
    expect(isRefreshToken("new-refresh")).toBe(true);
    expect(await refreshAccessToken("old-refresh", "client", "secret")).toMatchObject({ accessToken: "new-access" });
    expect(sent.map(({ method, url }) => [method, url])).toEqual([["POST", TOKEN_URL], ["POST", TOKEN_URL]]);
    expect(calls()).toEqual([["token.exchange", "error", "api", 200], ["token.refresh", "success", "", 200]]);
  });

  it("counts a token request Spotify rejected by its status, and raises Spotify's own words", async () => {
    answering(() => json(400, { error: "invalid_grant", error_description: "Refresh token revoked" }));
    const error = await failure(refreshAccessToken("old-refresh", "client", "secret"));
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error).toMatchObject({ status: 400, message: "invalid_grant: Refresh token revoked" });
    expect(calls()).toEqual([["token.refresh", "error", "http", 400]]);
  });

  it("sends a read again after a 503, a 429 and a network failure, with a token asked for each send", async () => {
    const getToken = vi.fn(async () => `token-${getToken.mock.calls.length}`);
    const sent = answering((_, sends) => [
      new Response("down", { status: 503 }),
      json(429, { error: { status: 429, message: "API rate limit exceeded" } }),
      json(200, { id: "p1" }),
    ][sends - 1]);
    expect(await api(getToken).getPlaylist("p1")).toEqual({ id: "p1" });
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(Array(3).fill(`GET ${API}/playlists/p1`));
    expect(sent.map(({ init }) => new Headers(init.headers).get("Authorization")))
      .toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
    expect(calls()).toEqual([
      ["playlists.get", "error", "http", 503],
      ["playlists.get", "refused", "rate", 429],
      ["playlists.get", "success", "", 200],
    ]);

    points.length = 0;
    const lost = answering((_, sends) => sends === 1 ? new TypeError("network connection lost") : json(200, {}));
    await api().getCurrentUser();
    expect(lost).toHaveLength(2);
    expect(calls()).toEqual([["me.get", "error", "network", 0], ["me.get", "success", "", 200]]);
  });

  it("raises Spotify's error for a read that failed three sends running", async () => {
    const sent = answering(() => json(503, { error: { status: 503, message: "Service unavailable" } }));
    const error = await failure(api().getDevices());
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error).toMatchObject({ status: 503, message: "Service unavailable" });
    expect(sent).toHaveLength(3);
    expect(calls()).toEqual(Array.from({ length: 3 }, () => ["devices.list", "error", "http", 503]));
  });

  it("sends a write and a token request once, whatever fails", async () => {
    const down = answering(() => new Response("down", { status: 503 }));
    expect(await failure(api().pause())).toMatchObject({ status: 503, message: "down" });
    expect(await failure(api().removeFromLibrary(["spotify:track:1"]))).toMatchObject({ status: 503 });
    expect(await failure(api().addToQueue("spotify:track:1"))).toMatchObject({ status: 503 });
    expect(await failure(refreshAccessToken("old-refresh", "client", "secret"))).toMatchObject({ status: 503 });
    expect(down.map(({ method }) => method)).toEqual(["PUT", "DELETE", "POST", "POST"]);

    const limited = answering(() => json(429, { error: { status: 429, message: "API rate limit exceeded" } }));
    expect(await failure(api().createPlaylist({ name: "Mix" }))).toMatchObject({ status: 429 });
    expect(limited).toHaveLength(1);

    const lost = answering(() => new TypeError("network connection lost"));
    expect(await failure(api().saveToLibrary(["spotify:track:1"]))).toBeInstanceOf(TypeError);
    expect(await failure(exchangeAuthCode("the-code", "client", "secret", "https://gk.example/oauth")))
      .toBeInstanceOf(TypeError);
    expect(lost).toHaveLength(2);
    expect(calls()).toEqual([
      ["player.pause", "error", "http", 503],
      ["library.delete", "error", "http", 503],
      ["queue.create", "error", "http", 503],
      ["token.refresh", "error", "http", 503],
      ["playlists.create", "refused", "rate", 429],
      ["library.update", "error", "network", 0],
      ["token.exchange", "error", "network", 0],
    ]);
  });

  it("counts a redirect, which is not followed, as an error the caller sees", async () => {
    const sent = answering(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    const error = await failure(api().getCurrentUser());
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error).toMatchObject({ status: 302, isAuthError: false });
    expect(await failure(refreshAccessToken("old-refresh", "client", "secret"))).toMatchObject({ status: 302 });
    expect(sent.map(({ url, init }) => [url, init.redirect])).toEqual([[`${API}/me`, "manual"], [TOKEN_URL, "manual"]]);
    expect(calls()).toEqual([["me.get", "error", "http", 302], ["token.refresh", "error", "http", 302]]);
  });

  it("counts an expired token's 401 by its status and raises an auth error", async () => {
    answering(() => json(401, { error: { status: 401, message: "The access token expired" } }));
    const error = await failure(api().getQueue());
    expect(error).toMatchObject({ status: 401, message: "The access token expired", isAuthError: true });
    expect(calls()).toEqual([["queue.list", "error", "http", 401]]);
  });

  it("counts an empty 204 as a success, and a success that is not the JSON it claims as a parse error", async () => {
    answering(() => new Response(null, { status: 204 }));
    expect(await api().getPlaybackState()).toBeUndefined();
    answering(() => new Response("<html>", { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await failure(api().search("remaster", ["track"], 10))).toBeInstanceOf(SyntaxError);
    expect(calls()).toEqual([["player.get", "success", "", 204], ["search", "error", "parse", 200]]);
  });

  it.each<[string, () => Response]>([
    ["an object", () => json(200, {})],
    ["a list that holds what is no boolean", () => json(200, [true, "false"])],
    ["JSON that holds nothing", () => json(200, null)],
    ["text", () => new Response("true", { status: 200, headers: { "Content-Type": "text/plain" } })],
    ["an empty list", () => json(200, [])],
    ["an empty body", () => new Response("", { status: 200 })],
    ["fewer answers than it asked about", () => json(200, [true])],
    ["more answers than it asked about", () => json(200, [true, false, true])],
  ])("counts a membership check answered 200 with %s as an error of the API, sent once", async (_what, answer) => {
    const sent = answering(answer);
    const error = await failure(api().libraryContains(["spotify:track:1", "spotify:track:2"]));
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error).toMatchObject({
      status: 502, message: "Spotify answered a membership check with no answer for each item.", isAuthError: false,
    });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["library.contains", "error", "api", 200]]);
  });

  it("counts a membership check answered no content as an error of the API, with its status", async () => {
    answering(() => new Response(null, { status: 204 }));
    expect(await failure(api().libraryContains(["spotify:track:1"]))).toBeInstanceOf(SpotifyApiError);
    expect(calls()).toEqual([["library.contains", "error", "api", 204]]);
  });

  it("counts a membership check answered a boolean for each URI as a success", async () => {
    const sent = answering(() => json(200, [true, false]));
    expect(await api().libraryContains(["spotify:track:1", "spotify:track:2"])).toEqual([true, false]);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["library.contains", "success", "", 200]]);
  });

  it.each<[string, () => Response]>([
    ["an object that holds no id", () => json(200, {})],
    ["an empty id", () => json(200, { id: "" })],
    ["an id that is no string", () => json(200, { id: 7 })],
    ["null for its id", () => json(201, { id: null, name: "Mix" })],
    ["a list", () => json(200, [{ id: "p1" }])],
    ["a body of null", () => json(200, null)],
    ["no content", () => new Response(null, { status: 204 })],
  ])("counts a playlist's creation answered a success with %s as an error of the API, sent once", async (_what, answer) => {
    const sent = answering(answer);
    const error = await failure(api().createPlaylist({ name: "Mix" }));
    expect(error).toBeInstanceOf(SpotifyUnnamedCreationError);
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error).toMatchObject({
      name: "SpotifyApiError", status: 502, message: "Spotify did not name the playlist it created.", isAuthError: false,
    });
    expect(sent.map(({ method, url }) => [method, url])).toEqual([["POST", `${API}/me/playlists`]]);
    expect(calls()).toEqual([["playlists.create", "error", "api", answer().status]]);
  });

  it.each([200, 201])("counts a playlist's creation answered %i with the playlist's id as a success, and answers the playlist", async status => {
    const sent = answering(() => json(status, { id: "p1", name: "Mix" }));
    expect(await api().createPlaylist({ name: "Mix" })).toEqual({ id: "p1", name: "Mix" });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["playlists.create", "success", "", status]]);
  });

  it("raises Spotify's own refusal of a playlist's creation, which names nothing created", async () => {
    const sent = answering(() => json(403, { error: { status: 403, message: "Forbidden" } }));
    const error = await failure(api().createPlaylist({ name: "Mix" }));
    expect(error).not.toBeInstanceOf(SpotifyUnnamedCreationError);
    expect(error).toMatchObject({ status: 403, message: "Forbidden" });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["playlists.create", "error", "http", 403]]);
  });

  // A chunk answered short would have every later answer read for the wrong URI.
  it("refuses a chunk that answers fewer URIs than it asked about, and asks for no chunk after it", async () => {
    const uris = Array.from({ length: 21 }, (_, at) => `spotify:track:${at}`);
    const sent = answering(() => json(200, Array(19).fill(false)));
    expect(await failure(api().libraryContains(uris))).toBeInstanceOf(SpotifyApiError);
    expect(sent).toHaveLength(1);
  });

  it.each<[string, string, (client: SpotifyApi) => Promise<unknown>]>([
    ["items.list", "a playlist's page", client => client.listPlaylistItems("p1", 50, 0)],
    ["playlists.list", "a page of playlists", client => client.listMyPlaylists(50, 0)],
    ["tracks.list", "a page of saved tracks", client => client.listSavedTracks(50, 0)],
  ])("counts %s answered 200 with no list of items as an error of the API, sent once", async (name, _what, call) => {
    for (const body of [{ total: 1 }, { items: {} }, null]) {
      points.length = 0;
      const sent = answering(() => json(200, body));
      const error = await failure(call(api()));
      expect(error).toBeInstanceOf(SpotifyApiError);
      expect(error).toMatchObject({ status: 502, message: "Spotify answered a listing with no list of items." });
      expect(sent).toHaveLength(1);
      expect(calls()).toEqual([[name, "error", "api", 200]]);
    }
  });

  it("counts a playlist's page that holds no items as a success", async () => {
    answering(() => json(200, { items: [], total: 0 }));
    expect(await api().listPlaylistItems("p1", 50, 0)).toEqual({ items: [], total: 0 });
    expect(calls()).toEqual([["items.list", "success", "", 200]]);
  });

  it("sums the requests of an operation that chunks into one point per kind", async () => {
    const uris = Array.from({ length: 45 }, (_, at) => `spotify:track:${at}`);
    const sent = answering(({ url }) =>
      json(200, (new URL(url).searchParams.get("uris") ?? "").split(",").map(() => true)));
    expect(await api().libraryContains(uris)).toEqual(Array(45).fill(true));
    await api().saveToLibrary(uris);
    await api().removeFromLibrary(uris);
    expect(sent.map(({ method }) => method)).toEqual([..."GGGPPPDDD"].map(letter =>
      ({ G: "GET", P: "PUT", D: "DELETE" })[letter]));
    expect(points.map(point => [
      column(point, SUBSERVICE_V1_SLOTS.operation), column(point, SUBSERVICE_V1_SLOTS.calls),
    ])).toEqual([["library.contains", 3], ["library.update", 3], ["library.delete", 3]]);
  });

  it("sums the requests of a batch of tracks and albums, a failed one included", async () => {
    const sent = answering(({ url }) => url.endsWith("/missing")
      ? json(404, { error: { status: 404, message: "Resource not found" } }) : json(200, { id: "found" }));
    expect(await api().getTracks(["t1", "missing", "t2"])).toEqual([{ id: "found" }, null, { id: "found" }]);
    expect(await api().getAlbums(["a1", "a2"])).toEqual([{ id: "found" }, { id: "found" }]);
    expect(sent).toHaveLength(5);
    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
    ].map(slot => column(point, slot))).toSorted()).toEqual([
      ["albums.get", "success", 200, 2],
      ["tracks.get", "error", 404, 1],
      ["tracks.get", "success", 200, 2],
    ]);
  });

  it("writes nothing an answer, a path, a query or a token holds", async () => {
    answering(() => json(403, { error: { status: 403, message: "Secret refusal about Some_Playlist" } }));
    await failure(api(async () => "secret-token").listPlaylistItems("Some_Playlist", 50, 0));
    await failure(api(async () => "secret-token").search("secret words", ["track"], 10));
    await failure(refreshAccessToken("secret-refresh", "secret-client", "secret-value"));
    const written = JSON.stringify(points);
    expect(points).toHaveLength(3);
    for (const secret of ["Some_Playlist", "secret", "Secret", "spotify.com", "words", "playlists"]) {
      expect(written).not.toContain(secret);
    }
  });
});
