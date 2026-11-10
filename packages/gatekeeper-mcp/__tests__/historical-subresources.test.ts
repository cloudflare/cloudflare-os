import { describe, expect, it, vi } from "vitest";

// `cloudflare:workers` exists only inside workerd; the base classes are enough to construct the
// facet with a fake `ctx`.
vi.mock("cloudflare:workers", () => {
  class Base { constructor(readonly ctx: unknown, readonly env: unknown) {} }
  return { DurableObject: Base, WorkerEntrypoint: Base, RpcTarget: class {}, RpcStub: class {} };
});
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (value: unknown) => value,
  skipRpcValidation: () => (value: unknown) => value,
}));

import { McpGatekeeperImpl } from "../src/mcp.js";

// The legacy addObserver refused everyone, so history must carry a requirement that keeps
// refusing: the binding's own server ID, which verifyObserverAccess accepts and denies.
describe("getHistoricalSubresources", () => {
  it("exports the binding's server ID, which admits no observer", async () => {
    const storage = { kv: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() } };
    const facet = new McpGatekeeperImpl(
      { props: { serverId: "linear", endpoint: "https://mcp.linear.app/mcp" }, storage } as never,
      {} as never);

    const exported = await facet.getHistoricalSubresources();
    expect(exported).toEqual(["server/linear"]);
    await expect(facet.verifyObserverAccess([{ id: "someone", verifier: {} as never }], exported))
      .resolves.toEqual({ allowedObserverIds: [] });
    expect(storage.kv.put).not.toHaveBeenCalled();
  });
});
