import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { OverseerDurableObject } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const originalBindings = {
  OLD_API: {
    type: "gatekeeper" as const,
    title: "Original API",
    gatekeeperName: "original",
    typeUrlPattern: "https://old.example/*",
  },
};

const currentBindings = {
  NEW_API: {
    type: "gatekeeper" as const,
    title: "Current API",
    gatekeeperName: "current",
    typeUrlPattern: "https://new.example/*",
  },
};

async function makeClient(options: { bindingError?: Error } = {}) {
  let record = {
    id: "blueprint-1",
    gadgetId: 7,
    codeVersion: 3,
    metadata: {
      title: "Demo",
      description: "Demo blueprint",
      author: { type: "user" as const, id: "owner", name: "Owner" },
      created: new Date("2026-01-01"),
      lastUpdated: new Date("2026-01-01"),
      version: 1,
      bindings: structuredClone(originalBindings),
    },
  };
  let collectBindingMetadata = vi.fn(() => {
    if (options.bindingError) throw options.bindingError;
    return structuredClone(currentBindings);
  });
  let snapshot = new Uint8Array([1, 2, 3]);
  let snapshotCode = vi.fn(async () => snapshot);
  let propagateBlueprint = vi.fn(async () => {});
  let owner = {
    whoami: async () => ({ type: "user" as const, id: "owner", name: "Owner" }),
  };
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId: "user-id",
      ensureAmbientCapsules: async () => {},
      logger: { error: () => {} },
      users: {
        idFromString: (id: string) => id,
        get: () => owner,
      },
      markOutputsDirty: () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      resolveGadgetId: (id: number) => id,
      collectBindingMetadata,
      snapshotCode,
      propagateBlueprint,
      storage: {
        prohibitAllSharing: { get: () => false },
        blueprints: { get: () => record },
        codeVersion: { get: () => 4 },
      },
    },
  } satisfies Pick<OverseerDurableObject, "open"> & { impl: object };
  let notifyClosed = new NativeRpcStub<() => void>(() => {});
  let client = await overseer.open("user-id", "owner", notifyClosed);
  return {
    client,
    collectBindingMetadata,
    propagateBlueprint,
    record,
    snapshot,
    snapshotCode,
  };
}

describe("Overseer.updateBlueprint", () => {
  it("updates code without reading or changing binding metadata", async () => {
    let bindingError = new Error("invalid current binding annotation");
    let {
      client,
      collectBindingMetadata,
      propagateBlueprint,
      record,
      snapshot,
      snapshotCode,
    } = await makeClient({ bindingError });

    await expect(client.updateBlueprint("blueprint-1", {
      updateCode: true,
    })).resolves.toBeUndefined();

    expect(collectBindingMetadata).not.toHaveBeenCalled();
    expect(record.metadata.bindings).toEqual(originalBindings);
    expect(record.codeVersion).toBe(4);
    expect(record.metadata.version).toBe(2);
    expect(snapshotCode).toHaveBeenCalledWith(7);
    expect(propagateBlueprint).toHaveBeenCalledWith(record, snapshot, undefined);
  });

  it("updates bindings without changing the code snapshot", async () => {
    let {
      client,
      collectBindingMetadata,
      propagateBlueprint,
      record,
      snapshotCode,
    } = await makeClient();

    await client.updateBlueprint("blueprint-1", { updateBindings: true });

    expect(collectBindingMetadata).toHaveBeenCalledWith(7);
    expect(record.metadata.bindings).toEqual(currentBindings);
    expect(record.codeVersion).toBe(3);
    expect(record.metadata.version).toBe(1);
    expect(snapshotCode).not.toHaveBeenCalled();
    expect(propagateBlueprint).toHaveBeenCalledWith(record, undefined, undefined);
  });

  it("updates code and bindings together", async () => {
    let {
      client,
      collectBindingMetadata,
      propagateBlueprint,
      record,
      snapshot,
      snapshotCode,
    } = await makeClient();

    await client.updateBlueprint("blueprint-1", {
      updateCode: true,
      updateBindings: true,
    });

    expect(collectBindingMetadata).toHaveBeenCalledWith(7);
    expect(record.metadata.bindings).toEqual(currentBindings);
    expect(record.codeVersion).toBe(4);
    expect(record.metadata.version).toBe(2);
    expect(snapshotCode).toHaveBeenCalledWith(7);
    expect(propagateBlueprint).toHaveBeenCalledWith(record, snapshot, undefined);
  });
});
