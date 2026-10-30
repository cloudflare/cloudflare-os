// An auto-approved action can be applied while submitActionForApproval is still awaiting the
// overseer's reply. These drive the real gatekeeper class with an approval queue that applies
// before it returns, as the overseer's auto-approval drain may.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
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

  it("still drops the record and fails when the submit fails without applying", async () => {
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    const queue = { submitAction: async () => { throw new Error("queue gone"); } } as never;
    await expect(gk.submitActionForApproval(queue, action, presentation)).rejects.toThrow("queue gone");
    expect(kv.has(`action:${action.approvalId}`)).toBe(false);
  });
});
