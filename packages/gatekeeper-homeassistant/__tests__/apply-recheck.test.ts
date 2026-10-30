// A device-control call can be queued while a manual action holds the drain, and Home Assistant
// resolves its area target only when it runs. These drive the real gatekeeper class with a stubbed
// Home Assistant registry and transport.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistrySnapshot } from "../src/homeassistant-api";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
for (const name of ["instance", "area", "label", "device", "entity"]) {
  vi.doMock(`../src/generated/${name}-configurator-ui.txt`, () => ({ default: "" }));
}
vi.mock("../src/types.txt", () => ({ default: "" }));

const live = vi.hoisted(() => ({ registry: undefined as unknown as RegistrySnapshot }));
vi.mock("../src/homeassistant-api", async importOriginal => ({
  ...await importOriginal<typeof import("../src/homeassistant-api")>(),
  fetchRegistrySnapshot: async () => live.registry,
}));
const executed = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/approvals", async importOriginal => ({
  ...await importOriginal<typeof import("../src/approvals")>(),
  executeAction: async (action: unknown) => void executed.push(action),
  canRevert: () => false,
}));

const { HomeAssistantGatekeeperImpl } = await import("../src/homeassistant");

function home(extra: Record<string, unknown>[] = []): RegistrySnapshot {
  return {
    floors: [], labels: [], devices: [],
    areas: [{ area_id: "lounge" }],
    entities: [{ entity_id: "switch.plug", area_id: "lounge", platform: "hue" }, ...extra],
    states: new Map(),
  };
}

function gatekeeper() {
  const kv = new Map<string, unknown>();
  const ctx = {
    props: { userObjectId: "user", resourceKind: "instance" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => ({ getCredentials: async () => ({ baseUrl: "https://ha", token: "t" }) }) } },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
  };
  return { gk: new HomeAssistantGatekeeperImpl(ctx as never, {} as never), kv };
}

// A queue that records each submission and replies, optionally applying first or losing the reply.
function queue(onSubmit: (id: number, description: { autoApprovable: boolean }) => Promise<void> = async () => {}) {
  const q = { submitAction: onSubmit, dup: () => q, [Symbol.dispose]: () => {} };
  return q as never;
}

const turnOnLounge = { domain: "switch", service: "turn_on", target: { areaId: "lounge" } };

beforeEach(() => { executed.length = 0; });

describe("applying a queued device-control call", () => {
  it("is refused when a script-backed entity joined its area after it was queued", async () => {
    const { gk } = gatekeeper();
    live.registry = home();
    let id = 0;
    const session = await gk.startSession(queue(async (submitted, description) => {
      id = submitted;
      expect(description.autoApprovable).toBe(true);
    })) as any;
    await session.callService(turnOnLounge.domain, turnOnLounge.service, undefined, turnOnLounge.target);
    live.registry = home([{ entity_id: "switch.scene_runner", area_id: "lounge", platform: "template" }]);
    await expect(gk.applyAction(id)).rejects.toThrow(/no longer only device control/);
    expect(executed).toEqual([]);
  });

  it("runs when what it reaches still qualifies", async () => {
    const { gk } = gatekeeper();
    live.registry = home();
    let id = 0;
    const session = await gk.startSession(queue(async submitted => { id = submitted; })) as any;
    await session.callService(turnOnLounge.domain, turnOnLounge.service, undefined, turnOnLounge.target);
    await gk.applyAction(id);
    expect(executed).toHaveLength(1);
  });

  it("leaves a call a person had to review to that person's approval", async () => {
    const { gk } = gatekeeper();
    live.registry = home([{ entity_id: "switch.scene_runner", area_id: "lounge", platform: "template" }]);
    let id = 0;
    const session = await gk.startSession(queue(async (submitted, description) => {
      id = submitted;
      expect(description.autoApprovable).toBe(false);
    })) as any;
    await session.callService(turnOnLounge.domain, turnOnLounge.service, undefined, turnOnLounge.target);
    await gk.applyAction(id);
    expect(executed).toHaveLength(1);
  });
});

describe("submitting a call that is applied before the reply arrives", () => {
  it("reports success when the reply is lost after it applied", async () => {
    const { gk, kv } = gatekeeper();
    live.registry = home();
    const session = await gk.startSession(queue(async submitted => {
      await gk.applyAction(submitted);
      throw new Error("Network connection lost.");
    })) as any;
    await expect(session.callService(turnOnLounge.domain, turnOnLounge.service, undefined, turnOnLounge.target)).resolves.toBeUndefined();
    expect(executed).toHaveLength(1);
    expect([...kv.keys()].filter(key => key.startsWith("applied:"))).toHaveLength(1);
  });

  it("still fails when the submit fails without applying", async () => {
    const { gk, kv } = gatekeeper();
    live.registry = home();
    const session = await gk.startSession(queue(async () => { throw new Error("queue gone"); })) as any;
    await expect(session.callService(turnOnLounge.domain, turnOnLounge.service, undefined, turnOnLounge.target)).rejects.toThrow("queue gone");
    expect([...kv.keys()].filter(key => key.startsWith("pending:"))).toEqual([]);
  });
});
