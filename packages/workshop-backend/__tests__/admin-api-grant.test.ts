import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { RpcTarget } from "cloudflare:workers";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode, type AdminApi,
} from "@gadgets/workshop-shared/api";
import type {
  AdminApiGrant, GatekeeperConnectCallback, GatekeeperConnectOptions, SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AdminSettings } from "../src/admin-settings";
import type { AdminSettingActor } from "../src/admin-access";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "../src/auth/config";
import { UserDurableObject } from "../src/user";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// The deployment admin vitest.config.ts lists in ADMINS, in another spelling: names match
// whatever the case of their ASCII letters.
const ADMIN = "Deployment-Admin@example.test";
const MEMBER = "member@example.test";

const RESOURCE: SupportedResource = {
  id: "thing", urlPattern: "https://example.com/thing/:id", title: "Thing", description: "A thing",
};
const DESCRIPTION: VendorDescription = { displayName: "Example", url: "https://example.com" };

/** The grant as the Workshop implements it: over the Admin API. */
type Grant = Fetcher<AdminApiGrant<AdminApi & RpcTarget>>;

/** A grant minted as UserDurableObject.connectAccount() mints one. */
type Exports = {
  AdminApiGrantImpl(options: { props: { userId: string } }): Grant;
};

let counter = 0;

/** A user's Durable Object beside two vendors: the admin gatekeeper and another. */
function fixture(userId: string, overrides: Record<string, unknown> = {}) {
  const vendor = () => ({
    describe: async () => DESCRIPTION,
    getSupportedResources: vi.fn(async (_options?: { isAdmin?: boolean }) => [RESOURCE]),
    connectAccount: vi.fn(async (
        _callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions) =>
      ({ url: "https://example.com/connect" })),
  });
  const admin = vendor();
  const other = vendor();
  const vars = {
    ...env, GATEKEEPER_ADMIN: admin, GATEKEEPER_EXAMPLE: other,
    BLUEPRINTS: { get: async () => "{}", put: async () => {} },
    ...overrides,
  } as unknown as Cloudflare.Env;
  const stub = env.TEST_USER.getByName(`admin-api-grant-${++counter}`);
  const inUser = <T>(f: (user: UserDurableObject, exports: Exports) => Promise<T>) =>
    runInDurableObject(stub, async (_host, state) => {
      const user = new UserDurableObject(state, vars);
      await user.authenticateFromCfAccess(userId, true);
      return f(user, state.exports as unknown as Exports);
    });
  const inSettings = <T>(f: (settings: AdminSettings) => Promise<T>) =>
    runInDurableObject(stub, (_host, state) => f(new AdminSettings(state, vars)));
  return { admin, other, inUser, inSettings };
}

/** What the vendor's connectAccount() was handed as its options. */
const connectOptions = (vendor: ReturnType<typeof fixture>["admin"]) =>
  vendor.connectAccount.mock.calls[0]![1]!;

async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject.");
}

describe("the Admin API a connect flow hands the admin gatekeeper", () => {
  it("is handed over when a deployment admin connects the admin gatekeeper", async () => {
    const { admin, inUser } = fixture(ADMIN);
    await inUser(async user => {
      await user.connectAccount(ADMIN_GATEKEEPER_VENDOR_ID);

      const { adminApi, ...rest } = connectOptions(admin);
      expect(rest).toEqual({ resourceUrlPatterns: undefined });
      if (adminApi === undefined) throw new Error("The connect flow carried no grant");
      const grant = adminApi as Grant;
      expect(await grant.isAdmin()).toBe(true);
      // The capability is the Admin API itself, as the admin who connected.
      using api = await grant.open();
      expect(await api.getSettings()).toMatchObject({ signupsEnabled: true });
    });
  });

  it("is withheld from a user who is no deployment admin", async () => {
    const { admin, inUser } = fixture(MEMBER);
    await inUser(user => user.connectAccount(ADMIN_GATEKEEPER_VENDOR_ID));
    expect(connectOptions(admin)).toEqual({ resourceUrlPatterns: undefined });
    expect("adminApi" in connectOptions(admin)).toBe(false);
  });

  it("is handed to no other vendor, whoever connects it", async () => {
    const { admin, other, inUser } = fixture(ADMIN);
    await inUser(user => user.connectAccount("example", ["thing"]));
    expect(connectOptions(other)).toEqual({ resourceTypeIds: ["thing"] });
    expect(admin.connectAccount).not.toHaveBeenCalled();
  });
});

describe("AdminApiGrantImpl", () => {
  it("answers for the user it was minted for, as the deployment's admins stand when it is asked",
      async () => {
    const { inUser } = fixture(MEMBER);
    await inUser(async (_user, exports) => {
      const grant = exports.AdminApiGrantImpl({ props: { userId: MEMBER } });
      expect(await grant.isAdmin()).toBe(false);
      expect(getAdminAccessErrorCode(await rejection(grant.open())))
          .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    });
  });
});

describe("the hint a vendor's resources are asked for with", () => {
  const ACTOR = (admin: string): AdminSettingActor =>
      ({ admin, sessionId: "session", via: "api", method: "setResourceEnabled" });

  it("says whether the user is a deployment admin, wherever the user's own object asks", async () => {
    for (const [userId, isAdmin] of [[ADMIN, true], [MEMBER, false]] as const) {
      const { admin, inUser } = fixture(userId);
      await inUser(async user => {
        await user.listGatekeeperVendors();
        await user.connectAccount(ADMIN_GATEKEEPER_VENDOR_ID, ["thing"]);
        await user.createResourceGatekeeper(ADMIN_GATEKEEPER_VENDOR_ID, "thing", "A thing")
            .catch(() => {});
      });
      expect(admin.getSupportedResources.mock.calls)
          .toEqual([[{ userId, isAdmin }], [{ userId, isAdmin }], [{ userId, isAdmin }]]);
    }
  });

  it("says so when the vendors are filtered by a resource's URL", async () => {
    for (const [userId, isAdmin] of [[ADMIN, true], [MEMBER, false]] as const) {
      const { admin, inUser } = fixture(userId);
      // A vendor that offers its resource to deployment admins alone, as the admin gatekeeper does.
      admin.getSupportedResources.mockImplementation(
          async (options?: { isAdmin?: boolean }) => options?.isAdmin ? [RESOURCE] : []);
      const found = await inUser(user =>
        user.listGatekeeperVendors({ resourceUrl: "https://example.com/thing/7" }));
      expect(found.map(vendor => vendor.id)).toEqual(isAdmin ? ["admin", "example"] : ["example"]);
      for (const [hint] of admin.getSupportedResources.mock.calls) {
        expect(hint).toEqual({ userId, isAdmin });
      }
    }
  });

  it("tells no other vendor whether the user is a deployment admin", async () => {
    const { other, inUser } = fixture(ADMIN);
    await inUser(async user => {
      await user.listGatekeeperVendors();
      await user.listGatekeeperVendors({ resourceUrl: "https://example.com/thing/7" });
      await user.connectAccount("example", ["thing"]);
      await user.createResourceGatekeeper("example", "thing", "A thing").catch(() => {});
    });
    // Five asks: the listing, the filtered listing's filter and its list, the connect, the creation.
    expect(other.getSupportedResources.mock.calls)
        .toEqual(Array.from({ length: 5 }, () => [{ userId: ADMIN }]));
  });

  it("marks only the admin gatekeeper unavailable while ADMINS cannot be read", async () => {
    const { inUser } = fixture(MEMBER, { ADMINS: "not a list" });
    const found = await inUser(user => user.listGatekeeperVendors());
    expect(found.map(vendor => [vendor.id, vendor.unavailable === true]).toSorted())
        .toEqual([["admin", true], ["example", false]]);
  });

  it("says so for the admin whose settings page or setting change asks", async () => {
    const { admin, inSettings } = fixture(ADMIN);
    await inSettings(async settings => {
      await settings.getSettings(ADMIN);
      await settings.setResourceEnabled(ADMIN_GATEKEEPER_VENDOR_ID, "thing", false, ACTOR(ADMIN));
    });
    expect(admin.getSupportedResources.mock.calls)
        .toEqual([[{ userId: ADMIN, isAdmin: true }], [{ userId: ADMIN, isAdmin: true }]]);
  });

  it("tells no other vendor on the settings page or a setting change", async () => {
    const { other, inSettings } = fixture(ADMIN);
    await inSettings(async settings => {
      await settings.getSettings(ADMIN);
      await settings.setResourceEnabled("example", "thing", false, ACTOR(ADMIN));
    });
    expect(other.getSupportedResources.mock.calls).toEqual([[{ userId: ADMIN }], [{ userId: ADMIN }]]);
  });
});
