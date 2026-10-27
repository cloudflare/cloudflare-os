import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type {
  Gatekeeper, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer";
import { UserDurableObject } from "../src/user";
import { AdminSettings } from "../src/admin-settings";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const EXISTING: SupportedResource = {
  urlPattern: "https://example.com/doc/:id", title: "Document", description: "An existing document",
};
const CREATION: SupportedResource = {
  urlPattern: "example://environment/*", title: "Environment", description: "Create an environment",
  creationConfigurator: true,
};
let counter = 0;

function fixture(existing: SupportedResource[] = [], creations: SupportedResource[] = [CREATION],
    config: Partial<AdminConfig> = {}) {
  const description: VendorDescription = {
    displayName: "Example", url: "https://example.com", creatableResources: creations,
  };
  const createResource = vi.fn(async (pattern: string, _title: string) => ({
    class: {} as DurableObjectClass<Gatekeeper<unknown>>,
    resource: creations.find(r => r.urlPattern === pattern)!,
    action: { title: "Create environment", description: "Create a fresh environment" },
  }));
  const vendor = { describe: async () => description, getSupportedResources: async () => existing,
    createResource };
  const vars = { ...env, GATEKEEPER_EXAMPLE: vendor,
    BLUEPRINTS: { get: async () => JSON.stringify(config), put: async () => {} },
  } as unknown as Cloudflare.Env;
  const stub = env.TEST_USER.getByName(`resource-creation-${++counter}`);
  const inUser = <T>(f: (user: UserDurableObject) => Promise<T>) =>
    runInDurableObject(stub, (_host, state) => f(new UserDurableObject(state, vars)));
  const inAdmin = <T>(f: (admin: AdminSettings) => Promise<T>) =>
    runInDurableObject(stub, (_host, state) => f(new AdminSettings(state, vars)));
  return { description, createResource, inUser, inAdmin };
}

describe("independent creation and connection discovery", () => {
  it("keeps creation-only vendors visible without advertising an existing-resource picker", async () => {
    const { inUser } = fixture();
    expect(await inUser(user => user.listGatekeeperVendors())).toMatchObject([{
      id: "example", supportedResources: [], description: { creatableResources: [CREATION] },
    }]);
  });

  it("hides a vendor advertising neither connections nor creations", async () => {
    const { inUser } = fixture([], []);
    expect(await inUser(user => user.listGatekeeperVendors())).toEqual([]);
  });

  it("filters disabled creations without hiding independently available connections", async () => {
    const { inUser } = fixture([EXISTING], [CREATION], {
      disabledResources: { example: [CREATION.urlPattern] },
    });
    expect(await inUser(user => user.listGatekeeperVendors())).toMatchObject([{
      supportedResources: [EXISTING], description: { creatableResources: [] },
    }]);
  });

  it("hides creation-only vendors when their creation type or vendor is disabled", async () => {
    for (const config of [
      { disabledResources: { example: [CREATION.urlPattern] } },
      { disabledGatekeepers: ["example"] },
    ]) {
      const { inUser } = fixture([], [CREATION], config);
      expect(await inUser(user => user.listGatekeeperVendors())).toEqual([]);
    }
  });

  it("allows advertised creation without any connectable types", async () => {
    const { inUser, createResource } = fixture();
    expect(await inUser(user => user.createResourceGatekeeper("example", CREATION.urlPattern, "Build")))
      .toMatchObject({ typeUrlPattern: CREATION.urlPattern, action: { title: "Create environment" } });
    expect(createResource).toHaveBeenCalledOnce();
  });

  it("does not infer creation support from an existing resource type", async () => {
    const { inUser, createResource } = fixture([EXISTING]);
    await expect(inUser(user => user.createResourceGatekeeper("example", EXISTING.urlPattern, "Doc")))
      .rejects.toThrow("does not advertise creation");
    expect(createResource).not.toHaveBeenCalled();
  });

  it("checks admin policy before asking the gatekeeper to mint a creation", async () => {
    const { inUser, createResource } = fixture([], [CREATION], {
      disabledResources: { example: [CREATION.urlPattern] },
    });
    await expect(inUser(user => user.createResourceGatekeeper("example", CREATION.urlPattern, "Build")))
      .rejects.toThrow("disabled");
    expect(createResource).not.toHaveBeenCalled();
  });

  it("refuses a creation response for a different resource type", async () => {
    const { inUser, createResource } = fixture();
    createResource.mockResolvedValue({
      class: {} as DurableObjectClass<Gatekeeper<unknown>>, resource: EXISTING,
      action: { title: "Create document", description: "Wrong resource type" },
    });
    await expect(inUser(user => user.createResourceGatekeeper("example", CREATION.urlPattern, "Build")))
      .rejects.toThrow("does not match");
  });

  it("shows creation-only types to admins and deduplicates types offered both ways", async () => {
    const { inAdmin } = fixture([EXISTING], [EXISTING, CREATION]);
    const view = await inAdmin(admin => admin.getSettings("admin"));
    expect(view.resourceVendors).toMatchObject([{
      vendorId: "example", resources: [
        { urlPattern: EXISTING.urlPattern }, { urlPattern: CREATION.urlPattern },
      ],
    }]);
    expect(view.resourceVendors[0]).toHaveProperty("resources.length", 2);
  });
});

describe("agent resource discovery", () => {
  async function withDiscovery(existing: SupportedResource[], creations: SupportedResource[],
      run: (impl: any) => Promise<void>) {
    const stub = env.TEST_OVERSEER.getByName(`resource-discovery-${++counter}`);
    await runInDurableObject(stub, async instance => {
      const impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = "owner";
      impl.users = { idFromString: (id: string) => id, get: () => ({
        listGatekeeperVendors: async () => [{ id: "example", supportedResources: existing,
          description: { displayName: "Example", creatableResources: creations } }],
      }) };
      await run(impl);
    });
  }

  it("offers creation without telling the agent to request an unusable existing connection", async () => {
    await withDiscovery([], [CREATION], async impl => {
      const text = await impl.listConnectableResources("example");
      expect(text).toContain("New resources (createExternalResource)");
      expect(text).toContain(CREATION.urlPattern);
      expect(text).not.toContain("call requestConnection");
      expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "ENVIRONMENT",
        reason: "Run tests" })).toMatchObject({
        requested: false, message: expect.stringContaining("createExternalResource"),
      });
    });
  });

  it("lists connection and creation independently when a vendor supports both", async () => {
    await withDiscovery([EXISTING], [CREATION], async impl => {
      const text = await impl.listConnectableResources("example");
      expect(text).toContain("Existing resources (requestConnection)");
      expect(text).toContain(EXISTING.urlPattern);
      expect(text).toContain("New resources (createExternalResource)");
      expect(text).toContain(CREATION.urlPattern);
    });
  });
});
