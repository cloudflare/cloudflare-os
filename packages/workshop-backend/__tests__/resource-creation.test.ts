import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  getResourceTypeId, type Gatekeeper, type SupportedResource, type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer";
import { UserDurableObject } from "../src/user";
import { AdminSettings } from "../src/admin-settings";
import type { AdminSettingActor } from "../src/admin-access";
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
  connectable: false, creatable: true, creationConfigurator: true,
  creationConfigurationDescription: "an environment's URL",
};
const ACTOR: AdminSettingActor =
    { admin: "admin", sessionId: "session", via: "cli", method: "setResourceEnabled" };
let counter = 0;

function fixture(resources: SupportedResource[] = [CREATION], config: Partial<AdminConfig> = {}) {
  const description: VendorDescription = {
    displayName: "Example", url: "https://example.com",
  };
  const createResource = vi.fn(async (pattern: string, _title: string) => ({
    class: {} as DurableObjectClass<Gatekeeper<unknown>>,
    resource: resources.find(r => getResourceTypeId(r) === pattern)!,
    action: { title: "Create environment", description: "Create a fresh environment" },
  }));
  const vendor = { describe: async () => description, getSupportedResources: vi.fn(async () => resources),
    connectAccount: vi.fn(async () => ({ url: "https://example.com/connect" })), createResource };
  const vars = { ...env, GATEKEEPER_EXAMPLE: vendor,
    BLUEPRINTS: { get: async () => JSON.stringify(config), put: async () => {} },
  } as unknown as Cloudflare.Env;
  const stub = env.TEST_USER.getByName(`resource-creation-${++counter}`);
  const inUser = <T>(f: (user: UserDurableObject) => Promise<T>) =>
    runInDurableObject(stub, (_host, state) => f(new UserDurableObject(state, vars)));
  const inAdmin = <T>(f: (admin: AdminSettings) => Promise<T>) =>
    runInDurableObject(stub, (_host, state) => f(new AdminSettings(state, vars)));
  return { description, createResource, inUser, inAdmin, vendor };
}

describe("independent creation and connection discovery", () => {
  it("starts an unfiltered account connection without depending on the resource catalog", async () => {
    const { inUser, vendor } = fixture();
    vendor.getSupportedResources.mockRejectedValue(new Error("Catalog unavailable"));
    expect(await inUser(user => user.connectAccount("example")))
      .toMatchObject({ url: "https://example.com/connect" });
    expect(vendor.getSupportedResources).not.toHaveBeenCalled();
    expect(vendor.connectAccount).toHaveBeenCalledOnce();
  });

  it("keeps creation-only vendors visible without advertising an existing-resource picker", async () => {
    const { inUser } = fixture();
    expect(await inUser(user => user.listGatekeeperVendors())).toMatchObject([{
      id: "example", supportedResources: [CREATION],
    }]);
  });

  it("hides a vendor advertising neither connections nor creations", async () => {
    for (const resources of [[], [{ ...CREATION, creatable: false }]]) {
      const { inUser } = fixture(resources);
      expect(await inUser(user => user.listGatekeeperVendors())).toEqual([]);
    }
  });

  it("filters disabled creations without hiding independently available connections", async () => {
    const { inUser } = fixture([EXISTING, CREATION], {
      disabledResources: { example: [CREATION.urlPattern] },
    });
    expect(await inUser(user => user.listGatekeeperVendors())).toMatchObject([{
      supportedResources: [EXISTING],
    }]);
  });

  it("hides creation-only vendors when their creation type or vendor is disabled", async () => {
    for (const config of [
      { disabledResources: { example: [CREATION.urlPattern] } },
      { disabledGatekeepers: ["example"] },
    ]) {
      const { inUser } = fixture([CREATION], config);
      expect(await inUser(user => user.listGatekeeperVendors())).toEqual([]);
    }
  });

  it("allows advertised creation without any connectable types", async () => {
    const { inUser, createResource } = fixture();
    expect(await inUser(user => user.createResourceGatekeeper("example", CREATION.urlPattern, "Build")))
      .toMatchObject({ typeUrlPattern: CREATION.urlPattern, action: { title: "Create environment" } });
    expect(createResource).toHaveBeenCalledOnce();
  });

  // Only a type that says what its configuration is takes a suggested one, so nothing else is let
  // pretend to.
  it.each([
    { name: "for a type whose approver chooses nothing", resource: { ...CREATION, creationConfigurator: false },
      configuration: "example://environment/eu", error: "takes no configuration" },
    { name: "for a type that does not describe one",
      resource: { ...CREATION, creationConfigurationDescription: undefined },
      configuration: "example://environment/eu", error: "takes no configuration" },
    { name: "that is not a URL", resource: CREATION, configuration: "eu-west",
      error: `must be ${CREATION.creationConfigurationDescription}` },
  ])("refuses a configuration $name before minting anything", async ({ resource, configuration, error }) => {
    const { inUser, createResource } = fixture([resource]);
    await expect(inUser(user => user.createResourceGatekeeper("example", CREATION.urlPattern, "Build",
      undefined, configuration)))
      .rejects.toThrow(error);
    expect(createResource).not.toHaveBeenCalled();
  });

  it("does not infer creation support from an existing resource type", async () => {
    const { inUser, createResource } = fixture([EXISTING]);
    await expect(inUser(user => user.createResourceGatekeeper("example", EXISTING.urlPattern, "Doc")))
      .rejects.toThrow("does not advertise creation");
    expect(createResource).not.toHaveBeenCalled();
  });

  it("checks admin policy before asking the gatekeeper to mint a creation", async () => {
    const { inUser, createResource } = fixture([CREATION], {
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

  it("shows creation-only and dual-purpose types in the single admin resource list", async () => {
    const { inAdmin } = fixture([{ ...EXISTING, creatable: true }, CREATION]);
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
  async function withDiscovery(resources: SupportedResource[], run: (impl: any) => Promise<void>) {
    const stub = env.TEST_OVERSEER.getByName(`resource-discovery-${++counter}`);
    await runInDurableObject(stub, async instance => {
      const impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = "owner";
      impl.users = { idFromString: (id: string) => id, get: () => ({
        listGatekeeperVendors: async () => [{ id: "example", supportedResources: resources,
          description: { displayName: "Example" } }],
      }) };
      await run(impl);
    });
  }

  it("offers creation without telling the agent to request an unusable existing connection", async () => {
    await withDiscovery([CREATION], async impl => {
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
    await withDiscovery([EXISTING, CREATION], async impl => {
      const text = await impl.listConnectableResources("example");
      expect(text).toContain("Existing resources (requestConnection)");
      expect(text).toContain(EXISTING.urlPattern);
      expect(text).toContain("New resources (createExternalResource)");
      expect(text).toContain(CREATION.urlPattern);
      expect(text.split("New resources")[0]).not.toContain(CREATION.urlPattern);
    });
  });

  it("offers both flows for a type marked connectable and creatable", async () => {
    await withDiscovery([{ ...EXISTING, connectable: true, creatable: true }], async impl => {
      const text = await impl.listConnectableResources("example");
      const [existing, creation] = text.split("New resources (createExternalResource):");
      expect(existing).toContain(EXISTING.urlPattern);
      expect(creation).toContain(EXISTING.urlPattern);
    });
  });

  // The listing tells the agent which types take a suggested configuration, and what it is.
  it("lists a creatable type with its configuration's description", async () => {
    await withDiscovery([CREATION, { ...EXISTING, creatable: true }], async impl => {
      const creation = (await impl.listConnectableResources("example")).split("New resources")[1];
      expect(creation).toContain(
        `${CREATION.urlPattern} (configuration: ${CREATION.creationConfigurationDescription})`);
      expect(creation).not.toContain(`${EXISTING.urlPattern} (configuration:`);
    });
  });

  it.each([
    { resource: CREATION, url: undefined },
    { resource: CREATION, url: "example://environment/test" },
    { resource: { ...CREATION, urlPattern: "https://*" }, url: "https://example.com" },
  ])("excludes non-connectable types from URL and fallback selection: $url", async ({ resource, url }) => {
    await withDiscovery([resource], async impl => {
      expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "ENVIRONMENT",
        reason: "Run tests", resourceUrl: url })).toMatchObject({ requested: false });
      expect(impl.consumeCapturedDecisionRequests(1)).toEqual([]);
    });
  });

  it("ignores creation-only types when choosing the sole existing connection", async () => {
    await withDiscovery([CREATION, EXISTING], async impl => {
      expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "DOCUMENT",
        reason: "Read a document" })).toMatchObject({ requested: true });
      expect(impl.consumeCapturedDecisionRequests(1)).toMatchObject([{
        type: "connectionRequest", resourceUrlPattern: EXISTING.urlPattern,
      }]);
    });
  });

  const repository = { ...EXISTING, id: "repository", urlPattern: "https://git.example/:owner/:repo" };
  const issue = { ...EXISTING, id: "issue", urlPattern: "https://git.example/:owner/:repo/issues/:issue" };

  it("rejects a URL belonging to another explicitly selected connection type", async () => {
    await withDiscovery([repository, issue], async impl => {
      expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "REPOSITORY",
        reason: "Read code", resourceTypeId: "repository",
        resourceUrl: "https://git.example/cloudflare/cloudflare-os/issues/1" })).toMatchObject({
        requested: false, message: expect.stringContaining("does not match"),
      });
      expect(impl.consumeCapturedDecisionRequests(1)).toEqual([]);
    });
  });

  it.each([undefined, "https://git.example/cloudflare/cloudflare-os/"])(
    "accepts an explicit connection type with an optional matching URL %s", async resourceUrl => {
      await withDiscovery([repository, issue], async impl => {
        expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "REPOSITORY",
          reason: "Read code", resourceTypeId: "repository", resourceUrl })).toMatchObject({ requested: true });
        expect(impl.consumeCapturedDecisionRequests(1)).toMatchObject([{
          type: "connectionRequest", resourceTypeId: "repository", resourceUrl,
        }]);
      });
    },
  );

  it("preserves HTTP instance URLs for the whole-instance catch-all type", async () => {
    await withDiscovery([{ ...EXISTING, id: "instance", urlPattern: "https://*" }], async impl => {
      expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "INSTANCE",
        reason: "Read instance state", resourceTypeId: "instance",
        resourceUrl: "http://homeassistant.local:8123" })).toMatchObject({ requested: true });
      expect(impl.consumeCapturedDecisionRequests(1)).toMatchObject([{
        type: "connectionRequest", resourceTypeId: "instance", resourceUrl: "http://homeassistant.local:8123",
      }]);
    });
  });

  it("accepts an insecure MCP server URL with a path", async () => {
    await withDiscovery([{ ...EXISTING, id: "http-server", urlPattern: "http://*" }], async impl => {
      expect(await impl.requestConnection(1, { vendorId: "example", bindingName: "MCP",
        reason: "Use local MCP", resourceTypeId: "http-server", resourceUrl: "http://host/mcp" }))
        .toMatchObject({ requested: true });
    });
  });
});


describe("stable resource type IDs", () => {
  it("keeps older providers' persisted references as patterns until they advertise IDs", async () => {
    const { inUser, inAdmin } = fixture();
    const minted = await inUser(user => user.createResourceGatekeeper("example", CREATION.urlPattern, "Build"));
    expect(minted.resourceTypeId).toBeUndefined();
    expect(minted.typeUrlPattern).toBe(CREATION.urlPattern);
    await inAdmin(admin => admin.setResourceEnabled("example", CREATION.urlPattern, false, ACTOR));
    const config = await inAdmin(async admin => admin.getAdminConfig());
    expect(config.disabledResources).toEqual({ example: [CREATION.urlPattern] });
    expect(config.disabledResourceTypeIds).toEqual({});
  });

  it("mints by ID rather than the current pattern and records that identity", async () => {
    const modern = { ...CREATION, id: "environment" };
    const { inUser, createResource } = fixture([modern]);
    expect(await inUser(user => user.createResourceGatekeeper("example", "environment", "Build")))
      .toMatchObject({ resourceTypeId: "environment", typeUrlPattern: modern.urlPattern });
    expect(createResource).toHaveBeenCalledWith("environment", "Build");
    await expect(inUser(user => user.createResourceGatekeeper(
      "example", "unknown", "Build", modern.urlPattern))).rejects.toThrow("does not advertise");
  });

  it("retains an unmatched legacy restriction until an admin explicitly clears it", async () => {
    const modern = { ...CREATION, id: "environment" };
    const retired = "https://example.com/old-environment/*";
    const { inAdmin } = fixture([modern]);
    await inAdmin(admin => admin.updateAdminConfig({ disabledResources: { example: [retired] } }, ACTOR));
    const before = await inAdmin(admin => admin.getSettings("admin"));
    expect(before.resourceVendors).toMatchObject([{
      resources: [{ resourceTypeId: "environment", enabled: false }, { urlPattern: retired, enabled: false }],
    }]);
    await inAdmin(admin => admin.setResourceEnabled("example", "environment", true, ACTOR));
    expect((await inAdmin(admin => admin.getSettings("admin"))).resourceVendors)
      .toMatchObject([{ resources: [{ resourceTypeId: "environment", enabled: false },
        { urlPattern: retired, enabled: false }] }]);
    await inAdmin(admin => admin.setResourceEnabled("example", retired, true, ACTOR));
    expect((await inAdmin(admin => admin.getSettings("admin"))).resourceVendors)
      .toMatchObject([{ resources: [{ resourceTypeId: "environment", enabled: true }] }]);
  });
});
