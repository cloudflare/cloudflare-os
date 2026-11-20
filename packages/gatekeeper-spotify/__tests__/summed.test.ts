// An operation of the gatekeeper that pages or writes in chunks counts its requests summed: one
// point per kind of request, whatever the size of the playlist. These drive the real gatekeeper
// class against a stubbed fetch and read the points it writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";

vi.mock("cloudflare:workers", async importOriginal => {
  // What the gatekeeper's classes extend: a Durable Object holds its context and bindings.
  class Base { constructor(public ctx: unknown, public env: unknown) {} }
  return {
    // The shared stub's `env`, which the metrics read their bindings from.
    ...await importOriginal<typeof import("cloudflare:workers")>(),
    DurableObject: Base,
    RpcTarget: Base,
    WorkerEntrypoint: Base,
  };
});
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/spotify-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/account-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/playlist-configurator-ui.txt", () => ({ default: "" }));

const { env } = await import("cloudflare:workers");
const { SpotifyGatekeeperImpl } = await import("../src/spotify");

const API = "https://api.spotify.com/v1";

function gatekeeper() {
  const kv = new Map<string, unknown>();
  const ctx = {
    props: { userObjectId: "user", resourceKind: "account" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => ({ getAccessToken: async () => "token" }) } },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
  };
  return { gk: new SpotifyGatekeeperImpl(ctx as never, {} as never), kv };
}

// A queue whose submitAction applies the action before it replies.
function applyingQueue(gk: InstanceType<typeof SpotifyGatekeeperImpl>) {
  return { submitAction: async (id: number) => { await gk.applyAction(id); } } as never;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Point = { blobs?: unknown[]; doubles?: unknown[] };

// A written point's value in one column.
function column(point: Point, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

describe("the points of an operation that pages and writes in chunks", () => {
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
    vi.unstubAllGlobals();
  });

  it("sums the pages read of a playlist and the chunks of tracks added to it", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      sent.push(`${init.method} ${url.href}`);
      if (init.method === "POST") return json(201, { snapshot_id: "s2" });
      if (url.pathname.endsWith("/items")) {
        const offset = Number(url.searchParams.get("offset"));
        const items = Array.from({ length: Math.min(50, 120 - offset) }, (_, at) => ({
          item: { id: `t${offset + at}`, name: "Track", uri: `spotify:track:t${offset + at}`, duration_ms: 1, explicit: false, artists: [], album: { id: "a", name: "Album", uri: "spotify:album:a" } },
        }));
        return json(200, { items, total: 120 });
      }
      return json(200, {
        id: "p1", name: "Mix", uri: "spotify:playlist:p1", snapshot_id: "s1",
        owner: { id: "user", uri: "spotify:user:user" }, items: { total: 120 },
      });
    }));
    const { gk, kv } = gatekeeper();
    const action = gk.preparePlaylistAdd("p1", Array.from({ length: 250 }, (_, at) => `spotify:track:n${at}`));
    await gk.submitActionForApproval(applyingQueue(gk), action, { title: "Add tracks", implementsRevert: true });

    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
    expect(sent).toEqual([
      `GET ${API}/playlists/p1`,
      `GET ${API}/playlists/p1/items?limit=50&offset=0`,
      `GET ${API}/playlists/p1/items?limit=50&offset=50`,
      `GET ${API}/playlists/p1/items?limit=50&offset=100`,
      `POST ${API}/playlists/p1/items`,
      `POST ${API}/playlists/p1/items`,
      `POST ${API}/playlists/p1/items`,
    ]);
    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
    ].map(slot => column(point, slot)))).toEqual([
      ["playlists.get", "success", 200, 1],
      ["items.list", "success", 200, 3],
      ["items.create", "success", 201, 3],
    ]);
  });

  it("sums the track lookups of every pending create that a listing of playlists shows", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const { pathname } = new URL(String(input));
      sent.push(`${init.method} ${pathname}`);
      if (pathname === "/v1/me/playlists") return json(200, { items: [], total: 0 });
      if (pathname === "/v1/me") return json(200, { id: "user", uri: "spotify:user:user" });
      const id = pathname.slice("/v1/tracks/".length);
      if (id.startsWith("unknown")) return json(404, { error: { status: 404, message: "Not found." } });
      return json(200, {
        id, name: "Track", uri: `spotify:track:${id}`, duration_ms: 1, explicit: false, artists: [],
        album: { id: "a", name: "Album", uri: "spotify:album:a" },
      });
    }));
    const { gk } = gatekeeper();
    // A queue that holds every action unapproved.
    const holding = { submitAction: async () => {} } as never;
    const creates = 4;
    for (let created = 0; created < creates; created++) {
      const create = gk.preparePlaylistCreate(`Mix ${created}`);
      await gk.submitActionForApproval(holding, create, { title: "Create playlist", implementsRevert: true });
      const add = gk.preparePlaylistAdd(
        create.provisionalId, [`spotify:track:known${created}`, `spotify:track:unknown${created}`]);
      await gk.submitActionForApproval(holding, add, { title: "Add tracks", implementsRevert: true });
    }
    expect(sent).toEqual([]);

    expect(await gk.listPlaylists()).toHaveLength(creates);

    expect(sent.toSorted()).toEqual([
      "GET /v1/me",
      "GET /v1/me/playlists",
      ...Array.from({ length: creates }, (_, created) => `GET /v1/tracks/known${created}`),
      ...Array.from({ length: creates }, (_, created) => `GET /v1/tracks/unknown${created}`),
    ]);
    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
    ].map(slot => column(point, slot)))).toEqual([
      ["playlists.list", "success", 200, 1],
      ["me.get", "success", 200, 1],
      ["tracks.get", "success", 200, creates],
      ["tracks.get", "error", 404, creates],
    ]);
  });
});
