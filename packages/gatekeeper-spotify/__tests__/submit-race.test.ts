// An auto-approved action can be applied while submitActionForApproval is still awaiting the
// overseer's reply. These drive the real gatekeeper class with an approval queue that applies
// before it returns, as the overseer's auto-approval drain may.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", async importOriginal => ({
  // The shared stub's `env`, which the metrics read their bindings from.
  ...await importOriginal<typeof import("cloudflare:workers")>(),
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/spotify-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/account-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/playlist-configurator-ui.txt", () => ({ default: "" }));

const { SpotifyGatekeeperImpl } = await import("../src/spotify");

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

// A queue whose submitAction applies the action before replying, then replies or loses the reply.
function applyingQueue(gk: InstanceType<typeof SpotifyGatekeeperImpl>, reply: "ok" | "lost") {
  return {
    submitAction: async (id: number) => {
      await gk.applyAction(id).catch(() => {});
      if (reply === "lost") throw new Error("Network connection lost.");
    },
  } as never;
}

const pause = (gk: InstanceType<typeof SpotifyGatekeeperImpl>) => gk.preparePlayer({ op: "pause" });
const presentation = { title: "Pause playback", implementsRevert: false };

afterEach(() => vi.unstubAllGlobals());

describe("submitActionForApproval when the action is applied before the reply", () => {
  it("leaves an applied action retired instead of reviving it as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await gk.submitActionForApproval(applyingQueue(gk, "ok"), action, presentation);
    expect(kv.has(`action:${action.approvalId}`)).toBe(false);
    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
  });

  it("keeps an apply failure as failed, not pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await gk.submitActionForApproval(applyingQueue(gk, "ok"), action, presentation);
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed" });
  });

  it("reports success when the reply is lost after the action applied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await expect(gk.submitActionForApproval(applyingQueue(gk, "lost"), action, presentation)).resolves.toBeUndefined();
    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
  });

  it("reports success, without calling Spotify again, when an apply that ran is delivered again", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const { gk } = gatekeeper();
    const action = pause(gk);
    await gk.submitActionForApproval(applyingQueue(gk, "ok"), action, presentation);
    const calls = fetch.mock.calls.length;
    await expect(gk.applyAction(action.approvalId)).resolves.toBeUndefined();
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("keeps a failed apply for a retry when the reply is lost", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await expect(gk.submitActionForApproval(applyingQueue(gk, "lost"), action, presentation)).resolves.toBeUndefined();
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed" });
  });

  it("keeps an action whose apply is still under way when the reply is lost", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>(resolve => {
      release = () => resolve(new Response(null, { status: 204 }));
    }));
    vi.stubGlobal("fetch", fetch);
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    let applying: Promise<void> | undefined;
    const queue = { submitAction: async (id: number) => {
      applying = gk.applyAction(id);
      throw new Error("Network connection lost.");
    } } as never;
    await expect(gk.submitActionForApproval(queue, action, presentation)).resolves.toBeUndefined();
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "pending" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    release!();
    await applying;
    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
  });

  it("still drops the record and fails when the submit fails without applying", async () => {
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    const queue = { submitAction: async () => { throw new Error("queue gone"); } } as never;
    await expect(gk.submitActionForApproval(queue, action, presentation)).rejects.toThrow("queue gone");
    expect(kv.has(`action:${action.approvalId}`)).toBe(false);
  });
});

// The requests that create a playlist, of those a stubbed fetch was handed.
const creations = (fetch: { mock: { calls: unknown[][] } }) =>
  fetch.mock.calls.filter(([url, init]) =>
    String(url) === "https://api.spotify.com/v1/me/playlists" && (init as RequestInit).method === "POST");

describe("applying a playlist's creation that Spotify answers without naming the playlist", () => {
  const UNKNOWN = "Spotify answered this playlist's creation without naming the playlist, so the playlist may or " +
    "may not have been created. This action is not sent again, which could create a second one: " +
    "check Spotify, then discard this action.";
  const waiting = { submitAction: async () => {} } as never;
  const creation = { title: "Create playlist", implementsRevert: true };

  it.each<[string, () => Response]>([
    ["a body cut short", () => new Response('{"id":', { status: 201, headers: { "Content-Type": "application/json" } })],
    ["a body whose stream fails", () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection reset")); },
    }), { status: 201, headers: { "Content-Type": "application/json" } })],
  ])("fails the action with an unknown outcome where its success holds %s, and never sends the creation again", async (_what, answer) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => answer());
    vi.stubGlobal("fetch", fetch);
    const { gk, kv } = gatekeeper();
    const action = gk.preparePlaylistCreate("Mix");
    await gk.submitActionForApproval(waiting, action, creation);

    await expect(gk.applyAction(action.approvalId)).rejects.toThrow(UNKNOWN);
    await expect(gk.applyAction(action.approvalId)).rejects.toThrow(UNKNOWN);
    expect(creations(fetch)).toHaveLength(1);
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed", outcomeUnknown: UNKNOWN });
  });

  it.each([["no id", {}], ["an empty id", { id: "" }]])(
    "fails the action with an unknown outcome where the answer holds %s, and never sends the creation again", async (_what, body) => {
      const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body));
      vi.stubGlobal("fetch", fetch);
      const { gk, kv } = gatekeeper();
      const action = gk.preparePlaylistCreate("Mix");
      await gk.submitActionForApproval(waiting, action, creation);

      await expect(gk.applyAction(action.approvalId)).rejects.toThrow(UNKNOWN);
      expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed", outcomeUnknown: UNKNOWN });
      // No playlist is bound to the provisional id: none was named.
      expect(kv.has(`provisional:${action.provisionalId}`)).toBe(false);
      expect(creations(fetch)).toHaveLength(1);

      // A failed apply is retried by applying it again, which sends nothing for this one.
      await expect(gk.applyAction(action.approvalId)).rejects.toThrow(UNKNOWN);
      await expect(gk.applyAction(action.approvalId)).rejects.toThrow(UNKNOWN);
      expect(creations(fetch)).toHaveLength(1);
      expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed", outcomeUnknown: UNKNOWN });

      // Discarding it is the way out.
      await expect(gk.rejectAction(action.approvalId)).resolves.toEqual({ restart: true });
      expect(kv.has(`action:${action.approvalId}`)).toBe(false);
      expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "rejected" });
      expect(creations(fetch)).toHaveLength(1);
    });

  it("refuses an action on the playlist once its creation's outcome is unknown, and submits nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const { gk, kv } = gatekeeper();
    const create = gk.preparePlaylistCreate("Mix");
    await gk.submitActionForApproval(waiting, create, creation);
    await expect(gk.applyAction(create.approvalId)).rejects.toThrow(UNKNOWN);
    const submitted: number[] = [];
    const queue = { submitAction: async (id: number) => void submitted.push(id) } as never;

    for (const action of [
      gk.preparePlaylistAdd(create.provisionalId, ["spotify:track:1"]),
      gk.preparePlaylistFollow(create.provisionalId),
      gk.preparePlaylistUnfollow(create.provisionalId),
    ]) {
      await expect(gk.submitActionForApproval(queue, action, { title: "On it", implementsRevert: true }))
        .rejects.toThrow("whether it exists is unknown");
      expect(kv.has(`action:${action.approvalId}`)).toBe(false);
    }
    expect(submitted).toEqual([]);
    // The creation's record is kept for its discard.
    expect(kv.get(`action:${create.approvalId}`)).toMatchObject({ state: "failed", outcomeUnknown: UNKNOWN });
  });

  it("binds the playlist Spotify names, and records it for the undo", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: "p1" }));
    vi.stubGlobal("fetch", fetch);
    const { gk, kv } = gatekeeper();
    const action = gk.preparePlaylistCreate("Mix");
    await gk.submitActionForApproval(waiting, action, creation);

    await expect(gk.applyAction(action.approvalId)).resolves.toBeUndefined();
    expect(kv.get(`provisional:${action.provisionalId}`)).toEqual({ realId: "p1" });
    expect(kv.get(`retiredAction:${action.approvalId}`))
      .toMatchObject({ state: "approved", revert: { kind: "playlistCreate", realId: "p1" } });
    expect(creations(fetch)).toHaveLength(1);
  });

  it("keeps a creation that Spotify refused retryable: a refusal creates nothing", async () => {
    let down = true;
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      down ? new Response("down", { status: 503 }) : Response.json({ id: "p1" }));
    vi.stubGlobal("fetch", fetch);
    const { gk, kv } = gatekeeper();
    const action = gk.preparePlaylistCreate("Mix");
    await gk.submitActionForApproval(waiting, action, creation);

    await expect(gk.applyAction(action.approvalId)).rejects.toThrow("down");
    const failed = kv.get(`action:${action.approvalId}`);
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed).not.toHaveProperty("outcomeUnknown");

    down = false;
    await expect(gk.applyAction(action.approvalId)).resolves.toBeUndefined();
    expect(creations(fetch)).toHaveLength(2);
  });
});
