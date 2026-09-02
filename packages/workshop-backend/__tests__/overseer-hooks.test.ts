import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeOverseer(
    getConfig: () => Promise<string | null>,
    hook: { enabled: boolean; vendorId?: string; callback?: object } | null =
        { enabled: true, vendorId: "email" },
    legacyVendorId?: string,
): OverseerDurableObject {
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {
    env: { BLUEPRINTS: { get: getConfig } },
    impl: {
      // The quarantine gate (see the dedicated pending-restart tests); no connection is blocked
      // in these fixtures.
      assertGatekeeperUsable: () => {},
      storage: {
        boundHooks: { get: () => hook && ({ ...hook, gatekeeperId: 1 }) },
        gatekeepers: {
          get: () => legacyVendorId && {
            creationSpec: {
              type: "gatekeeper",
              vendorId: legacyVendorId,
              resourceUrl: "https://example.com",
              typeUrlPattern: "https://*",
            },
          },
        },
      },
    },
  });
  return overseer;
}

describe("OverseerDurableObject.startHook", () => {
  it.each([
    ["ordinary", DEFAULT_ADMIN_CONFIG, "email"],
    ["ambient", {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "optional" as const },
    }, "scheduler"],
  ])("allows delivery for an enabled %s vendor", async (_kind, config, vendorId) => {
    let deliver = vi.fn(async (payload: string) => `delivered:${payload}`);
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config),
        { enabled: true, vendorId, callback: { deliver } });

    // The returned callback is a per-firing wrapper over the stored persistent stub (see
    // makeHookFiringCallback), never the stored stub itself -- so identity doesn't hold; what
    // matters is that calls forward while the hook lives.
    let { callback } = await overseer.startHook(1);
    await expect((callback as any).deliver("evt")).resolves.toBe("delivered:evt");
    expect(deliver).toHaveBeenCalledWith("evt");
  });

  it("allows delivery for a function-valued callback invoked directly", async () => {
    // The bindHook contract (workshop-shared/gatekeeper.ts) allows the bound callback to be a
    // function type, delivered by calling the firing's callback itself rather than a method on
    // it -- so the per-firing wrapper must be callable too.
    let deliver = vi.fn(async (payload: string) => `delivered:${payload}`);
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        { enabled: true, vendorId: "email", callback: deliver });

    let { callback } = await overseer.startHook(1);
    await expect((callback as any)("evt")).resolves.toBe("delivered:evt");
    expect(deliver).toHaveBeenCalledWith("evt");
  });

  it("rejects delivery for an administratively disabled ordinary vendor", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(async () => serializeAdminConfig(config));

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery for an administratively disabled ambient vendor", async () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "disabled" as const },
    };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true, vendorId: "scheduler" });

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("enforces vendor policy for legacy hooks without a denormalized vendor ID", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true }, "email");

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery when admin-config KV access fails", async () => {
    let overseer = makeOverseer(async () => { throw new Error("KV unavailable"); });

    await expect(overseer.startHook(1)).rejects.toThrow("KV unavailable");
  });

  it("rejects delivery when the hook was disabled", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        { enabled: false, vendorId: "email" });

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  it("rejects delivery when the hook was deleted", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), null);

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  // Await a stub call's rejection with a single handler: expect(...).rejects forks the
  // underlying JsRpcPromise (each .then mints a fresh RPC continuation), and the leftover copy
  // is reported as an unhandled rejection.
  async function expectRejection(call: Promise<unknown>, pattern: RegExp): Promise<void> {
    let caught: unknown;
    let rejected = false;
    try { await call; } catch (err) { rejected = true; caught = err; }
    expect(rejected).toBe(true);
    expect(String(caught)).toMatch(pattern);
  }

  // The capabilities startHook returns are held outside this DO (in other DOs, across resets), so
  // disable/delete can't rely on their disposal: each one revalidates the hook record per call
  // (requireLiveHook), making the record flip an authoritative kill even for firings already
  // handed out.
  it("a firing's callback refuses once the hook is disabled", async () => {
    let deliver = vi.fn();
    let hook = { enabled: true, vendorId: "email", callback: { deliver } };
    let overseer = makeOverseer(async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), hook);
    let { callback } = await overseer.startHook(1);

    hook.enabled = false;

    await expectRejection((callback as any).deliver("evt"), /deleted or disabled/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a firing's callback refuses once the hook is deleted", async () => {
    let deliver = vi.fn();
    let overseer = makeOverseer(async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        { enabled: true, vendorId: "email", callback: { deliver } });
    let { callback } = await overseer.startHook(1);

    // The record is gone: every lookup now finds nothing, as after deleteHook/removeGatekeeper.
    (overseer as any).impl.storage.boundHooks.get = () => undefined;

    await expectRejection((callback as any).deliver("evt"), /deleted or disabled/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a firing's direct invocation refuses once the hook is disabled", async () => {
    let deliver = vi.fn();
    let hook = { enabled: true, vendorId: "email", callback: deliver };
    let overseer = makeOverseer(async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), hook);
    let { callback } = await overseer.startHook(1);

    hook.enabled = false;

    // The apply route revalidates like the method route: a function-valued callback must not be
    // the one shape that escapes the per-firing revocation.
    await expectRejection((callback as any)("evt"), /deleted or disabled/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a firing's approval queue refuses once the hook is disabled", async () => {
    let hook = { enabled: true, vendorId: "email", callback: {} };
    let overseer = makeOverseer(async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), hook);
    let { approvalQueue } = await overseer.startHook(1);

    hook.enabled = false;

    expect(() => approvalQueue.authorizeObservation({ title: "t", description: "d" }))
        .toThrow(/deleted or disabled/);
  });

  it("re-checks the record after the admin-config read", async () => {
    let release!: (config: string) => void;
    let hook = { enabled: true, vendorId: "email", callback: {} };
    let overseer = makeOverseer(
        () => new Promise<string | null>(resolve => { release = resolve; }), hook);

    // The KV read leaves the input gate open; the hook is disabled while it is parked. The firing
    // must not be issued from the stale pre-await record (the enableHookRecord/disableHook idiom).
    let pending = overseer.startHook(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    hook.enabled = false;
    release(serializeAdminConfig(DEFAULT_ADMIN_CONFIG));

    await expect(pending).rejects.toThrow(/deleted or disabled/);
  });
});

async function makeTargetOverseer(gadgetId?: number) {
  let controllerEnable = vi.fn(async (_initiator: object, _target: object) => {});
  let record = {
    id: 4,
    actionId: 12,
    gatekeeperId: 1,
    gadgetId,
    controller: {enable: controllerEnable},
    callback: {},
    description: {title: "Incoming email", description: "Receives email"},
    enabled: false,
  };
  let enableHookRecord = vi.fn();
  let client = await openFakeOverseer({
    boundHooks: {get: () => record, put: vi.fn()},
    actions: {get: () => undefined, put: vi.fn()},
  }, {
    exports: {GatekeeperHookLoopback: ({props}: {props: object}) => props},
    // The record flip (and its scope-widening check) lives in the impl; these tests cover only
    // what the interface passes to the gatekeeper-side enable().
    impl: {enableHookRecord},
  });
  return {client, controllerEnable, enableHookRecord};
}

describe("hook target", () => {

  it("passes the workspace and gadget IDs to enable()", async () => {
    let {client, controllerEnable, enableHookRecord} = await makeTargetOverseer(17);

    await client.enableHook(4);

    expect(controllerEnable).toHaveBeenCalledTimes(1);
    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id", gadgetId: 17});
    // The record flip happens only after the gatekeeper-side enable succeeded.
    expect(enableHookRecord).toHaveBeenCalledTimes(1);
  });

  it("omits the gadget ID for a hook that is not pinned to one", async () => {
    let {client, controllerEnable} = await makeTargetOverseer();

    await client.enableHook(4);

    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id"});
  });

});
