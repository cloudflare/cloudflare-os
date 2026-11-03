// An auto-approved action can be applied while enqueue is still awaiting the overseer's reply.
// These drive the real gatekeeper class with an approval queue that applies before it replies.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: class {},
  RpcStub: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/linear-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/linear-workspace-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-team-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-issue-configurator-ui.txt", () => ({ default: "" }));

const { LinearGatekeeperImpl } = await import("../src/linear");

function gatekeeper() {
  const kv = new Map<string, unknown>();
  const account = { getAccessToken: async () => "token", noteCredentialsExpired: async () => {} };
  const ctx = {
    props: { userObjectId: "user", workspaceUrlKey: "acme" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => account } },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
  };
  return { gk: new LinearGatekeeperImpl(ctx as never, {} as never), kv };
}

const archive = { kind: "archive", issueRef: "issue-1", archived: true, title: "Archive ENG-1" } as const;
const description = { title: "Archive ENG-1", description: "Archive the issue.", implementsRevert: true };

afterEach(() => vi.unstubAllGlobals());

describe("enqueue when the action is applied before the reply", () => {
  it("keeps an action whose apply failed before the reply was lost, for a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 400 })));
    const { gk, kv } = gatekeeper();
    const queue = { submitAction: async (id: number) => {
      await gk.applyAction(id).catch(() => {});
      throw new Error("Network connection lost.");
    } } as never;
    await expect(gk.enqueue(queue, archive as never, description as never)).resolves.toBeUndefined();
    expect(kv.get("action:1")).toMatchObject({ status: "pending", applyStarted: true });
  });

  it("still drops the record and fails when the submit fails without applying", async () => {
    const { gk, kv } = gatekeeper();
    const queue = { submitAction: async () => { throw new Error("queue gone"); } } as never;
    await expect(gk.enqueue(queue, archive as never, description as never)).rejects.toThrow("queue gone");
    expect(kv.has("action:1")).toBe(false);
  });
});
