// Who may hold an account of the admin gatekeeper (UserDurableObject's #offersVendor()), and what
// each mode of an auto-provisioning vendor offers, provisions and lists: over real user objects
// and the two vendors the pool binds (FakeAdminVendor and FakeAmbientVendor in test-worker.ts).
//
// "Has the account" means what shows it: its `add` on the connected-accounts feed, and
// getGatekeeperClassFor() answering for its resource. The account declares no singleton and no
// UI, so listProvidedAccounts() lists it for nobody; a stored record that declares both (seed())
// is what shows that the rule holds for those too.

import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AmbientGatekeeperMode, ConnectedAccountsFilter,
} from "@gadgets/workshop-shared/api";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import type { AccountDescription, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import { adminWorkspace } from "./admin-agent-helpers.js";
import { FAKE_ADMIN_RESOURCE, type FakeAdminVendor } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    GATEKEEPER_ADMIN: Service<FakeAdminVendor>;
  }
}

const ADMIN_VENDOR = ADMIN_GATEKEEPER_VENDOR_ID;
// The pool's second vendor that auto-provisions its account, which any user may hold.
const OTHER_VENDOR = "ambientfixture";
const RESOURCE_URL = FAKE_ADMIN_RESOURCE.urlPattern;
const ADMINS_ONLY = "Only deployment admins can add this gatekeeper.";
const FORCED: ConnectedAccountsFilter = { includeForcedAutoProvisionedAccounts: true };

// The stored collections behind the public methods, as a test reads and seeds them.
type UserInternals = UserDurableObject & {
  storage: {
    created: { put(created: boolean): void };
    profile: { get(): { id: string } };
    nextAccountId: { get(): number; put(id: number): void };
    connectedAccounts: {
      get(id: number): { id: number; vendorId: string } | undefined;
      put(record: unknown): void;
    };
  };
};

type Added = { id: number; vendorId: string; resources: string[] };

/** One user of a deployment(), by the calls a suite makes inside its Durable Object. */
type TestUser = {
  id: string;
  /** Runs `f` inside the user's object. A refusal is to be caught inside `f`: the pool reports
   * one that leaves the object as unhandled. */
  run<T>(f: (user: UserInternals) => Promise<T> | T): Promise<T>;
  /** What a new subscription to the connected-accounts feed is sent before it is ready. */
  feed(filter?: ConnectedAccountsFilter): Promise<Added[]>;
  /** The vendors offered on the Connectors page. */
  addable(): Promise<string[]>;
  /** The vendors whose resources the connection picker lists, with those resources. */
  vendors(): Promise<{ id: string; supportedResources: SupportedResource[] }[]>;
  /** The message provisionAmbientAccount() refuses with, or undefined once it has added. */
  provision(vendorId: string): Promise<string | undefined>;
  /** What getGatekeeperClassFor() answers for the admin resource of `accountId`, or its
   * refusal's message. */
  classFor(accountId: number): Promise<{ vendorId: string; typeUrlPattern: string } | string>;
  /** The ids of every stored account, offered or not. */
  stored(): Promise<number[]>;
};

const refusal = (attempt: Promise<unknown>): Promise<string | undefined> =>
    attempt.then(() => undefined, error => (error as Error).message);

/**
 * A deployment as its users read it: `admins` is its ADMINS binding and `modes` its stored
 * ambientGatekeeperModes, both read on every call, so a test changes either between two calls.
 * `admin` is a deployment admin and `member` is not; both have signed in. `unsigned` is the
 * object of a user who never has.
 */
async function deployment() {
  const tag = crypto.randomUUID();
  const adminId = `admin-${tag}@example.test`;
  const shared = {
    ...env,
    ADMINS: [adminId],
    BLUEPRINTS: {
      get: async (key: string) => key === ADMIN_CONFIG_KEY
          ? JSON.stringify({ ambientGatekeeperModes: modes }) : null,
    },
  };
  const modes: Record<string, AmbientGatekeeperMode> = {};

  function userObject(id: string): TestUser {
    const stub = env.TEST_USER.getByName(id);
    const run: TestUser["run"] = f => runInDurableObject(stub, (instance: UserDurableObject) => {
      Object.assign(instance, { env: shared });
      return f(instance as UserInternals);
    });
    return {
      id, run,
      feed: filter => run(async user => {
        const added: Added[] = [];
        const ready = Promise.withResolvers<void>();
        class Subscriber extends RpcTarget {
          add(accountId: number, _account: unknown, _vendor: unknown,
              resources: SupportedResource[], _valid: boolean, vendorId: string) {
            added.push({ id: accountId, vendorId, resources: resources.map(r => r.urlPattern) });
          }
          remove() {}
          ready() { ready.resolve(); }
        }
        using subscriber = new RpcStub(new Subscriber());
        using _subscription = await user.subscribeConnectedAccounts(
            subscriber as unknown as Parameters<UserDurableObject["subscribeConnectedAccounts"]>[0],
            filter);
        await ready.promise;
        return added;
      }),
      addable: () => run(async user =>
          (await user.listAddableGatekeepers()).map(vendor => vendor.id).toSorted()),
      vendors: () => run(async user => (await user.listGatekeeperVendors())
          .map(vendor => ({ id: vendor.id, supportedResources: vendor.supportedResources }))),
      provision: vendorId => run(user => refusal(user.provisionAmbientAccount(vendorId))),
      classFor: accountId => run(async user => {
        try {
          const { vendorId, typeUrlPattern } =
              await user.getGatekeeperClassFor(accountId, RESOURCE_URL);
          return { vendorId, typeUrlPattern };
        } catch (error) {
          return (error as Error).message;
        }
      }),
      stored: () => run(user => {
        const ids: number[] = [];
        for (let accountId = 0; accountId < user.storage.nextAccountId.get(); accountId++) {
          if (user.storage.connectedAccounts.get(accountId)) ids.push(accountId);
        }
        return ids;
      }),
    };
  }

  async function signIn(id: string): Promise<TestUser> {
    const user = userObject(id);
    await user.run(object => object.authenticateFromCfAccess(id, true));
    return user;
  }

  return {
    shared, modes,
    admin: await signIn(adminId),
    member: await signIn(`member-${tag}@example.test`),
    unsigned: userObject(`unsigned-${tag}@example.test`),
  };
}

/**
 * Stores a record of the admin vendor as account 0 of `user`, which no public method does for a
 * user the vendor is not offered to. `declares` is added to what the account says of itself.
 */
const seed = (user: TestUser, declares: Partial<AccountDescription> = {}) =>
    user.run(async object => {
      const account = await env.GATEKEEPER_ADMIN.createAccount();
      object.storage.connectedAccounts.put({
        id: 0, account, description: { ...await account.describe(), ...declares },
        vendorId: ADMIN_VENDOR, autoProvisioned: true,
      });
      object.storage.nextAccountId.put(1);
    });

const ofVendor = (added: Added[], vendorId: string) =>
    added.filter(account => account.vendorId === vendorId);
// The admin vendor as the connection picker lists it: with its one resource.
const LISTED = [{ id: ADMIN_VENDOR, supportedResources: [FAKE_ADMIN_RESOURCE] }];
const CLASS = { vendorId: ADMIN_VENDOR, typeUrlPattern: RESOURCE_URL };

describe("the admin gatekeeper's account, while its mode is optional", () => {
  it("is offered to, added by and listed for a deployment admin", async () => {
    const { modes, admin } = await deployment();
    modes[ADMIN_VENDOR] = "optional";

    expect(await admin.addable()).toEqual([OTHER_VENDOR, ADMIN_VENDOR].toSorted());
    expect(await admin.vendors()).toEqual(LISTED);
    expect(await admin.feed()).toEqual([]);

    expect(await admin.provision(ADMIN_VENDOR)).toBeUndefined();
    const [account] = await admin.feed();
    expect(await admin.feed())
        .toEqual([{ id: account!.id, vendorId: ADMIN_VENDOR, resources: [RESOURCE_URL] }]);
    expect(await admin.classFor(account!.id)).toEqual(CLASS);
    expect(await admin.run(user => user.getVerifier(account!.id, ADMIN_VENDOR))).not.toBeNull();
    expect(await admin.addable()).toEqual([OTHER_VENDOR]);
    expect(await admin.vendors()).toEqual(LISTED);
    // It declares no singleton and no UI: nothing provides it to a workspace or to the nav.
    expect(await admin.run(user => user.listProvidedAccounts())).toEqual([]);

    // Adding it again adds nothing, and its user removes it as any optional account.
    expect(await admin.provision(ADMIN_VENDOR)).toBeUndefined();
    expect(await admin.stored()).toEqual([account!.id]);
    await admin.run(user => user.disconnectAccount(account!.id));
    expect(await admin.feed()).toEqual([]);
    expect(await admin.addable()).toEqual([OTHER_VENDOR, ADMIN_VENDOR].toSorted());
  });

  it("is not offered to, and cannot be added by, a user who is not an admin", async () => {
    const { modes, member } = await deployment();
    modes[ADMIN_VENDOR] = "optional";

    expect(await member.addable()).toEqual([OTHER_VENDOR]);
    expect(await member.vendors()).toEqual([]);
    expect(await member.provision(ADMIN_VENDOR)).toBe(ADMINS_ONLY);
    expect(await member.provision(ADMIN_VENDOR.toUpperCase())).toBe(ADMINS_ONLY);
    expect(await member.run(user => refusal(user.connectAccount(ADMIN_VENDOR)))).toBe(ADMINS_ONLY);
    expect(await member.stored()).toEqual([]);
    expect(await member.feed(FORCED)).toEqual([]);
    expect(await member.run(user => user.holdsGatekeeperAccount(ADMIN_VENDOR))).toBe(false);
  });
});

describe("the admin gatekeeper's account, while its mode is enabled", () => {
  it("is provisioned for an admin whose subscription asks for forced accounts", async () => {
    const { modes, admin } = await deployment();
    modes[ADMIN_VENDOR] = "enabled";

    // A forced account is not in the Connectors list, and nothing there provisions it.
    expect(await admin.feed()).toEqual([]);
    expect(await admin.stored()).toEqual([]);
    expect(await admin.addable()).toEqual([OTHER_VENDOR]);

    const forced = await admin.feed(FORCED);
    expect(forced).toEqual([{ id: forced[0]!.id, vendorId: ADMIN_VENDOR, resources: [RESOURCE_URL] }]);
    expect(await admin.feed()).toEqual([]);
    expect(await admin.classFor(forced[0]!.id)).toEqual(CLASS);
    expect(await admin.vendors()).toEqual(LISTED);
    expect(await admin.run(user => user.listProvidedAccounts())).toEqual([]);
    expect(await admin.run(user => refusal(user.disconnectAccount(forced[0]!.id))))
        .toBe("This account is provided automatically and can't be disconnected.");
  });

  // The chooser can offer to connect it before the feed answers: whichever asks first, the two
  // add one account between them.
  it("is added once when the admin asks for it while forced provisioning runs", async () => {
    const { modes, admin } = await deployment();
    modes[ADMIN_VENDOR] = "enabled";

    const [forced, refused] = await Promise.all([admin.feed(FORCED), admin.provision(ADMIN_VENDOR)]);
    expect(refused).toBeUndefined();
    expect(await admin.stored()).toHaveLength(1);
    expect(forced.map(account => account.id)).toEqual(await admin.stored());
  });

  it("is provisioned for nobody else", async () => {
    const { modes, member } = await deployment();
    modes[ADMIN_VENDOR] = "enabled";

    expect(await member.feed(FORCED)).toEqual([]);
    expect(await member.run(user => user.listProvidedAccounts())).toEqual([]);
    expect(await member.stored()).toEqual([]);
    expect(await member.vendors()).toEqual([]);
    expect(await member.addable()).toEqual([OTHER_VENDOR]);
    expect(await member.provision(ADMIN_VENDOR)).toBe(ADMINS_ONLY);
  });
});

describe("the admin gatekeeper's account, while its mode is disabled", () => {
  it("is offered to nobody until an admin sets a mode", async () => {
    const { modes, admin, member } = await deployment();

    for (const user of [admin, member]) {
      expect(await user.addable()).toEqual([OTHER_VENDOR]);
      expect(await user.vendors()).toEqual([]);
      expect(await user.feed(FORCED)).toEqual([]);
      expect(await user.stored()).toEqual([]);
    }
    expect(await admin.provision(ADMIN_VENDOR))
        .toBe(`The "${ADMIN_VENDOR}" gatekeeper is disabled on this deployment.`);
    expect(await member.provision(ADMIN_VENDOR)).toBe(ADMINS_ONLY);

    // Storing the mode it starts with changes nothing.
    modes[ADMIN_VENDOR] = "disabled";
    expect(await admin.addable()).toEqual([OTHER_VENDOR]);
    expect(await admin.vendors()).toEqual([]);
  });

  it("hides an account added earlier, which is back once the mode allows it", async () => {
    const { modes, admin } = await deployment();
    modes[ADMIN_VENDOR] = "optional";
    expect(await admin.provision(ADMIN_VENDOR)).toBeUndefined();
    const [account] = await admin.feed();

    delete modes[ADMIN_VENDOR];
    expect(await admin.feed()).toEqual([]);
    expect(await admin.feed(FORCED)).toEqual([]);
    expect(await admin.vendors()).toEqual([]);
    expect(await admin.classFor(account!.id)).toBe(
        `The "${ADMIN_VENDOR}" gatekeeper is disabled on this deployment by an administrator.`);
    expect(await admin.stored()).toEqual([account!.id]);

    modes[ADMIN_VENDOR] = "optional";
    expect(await admin.feed()).toEqual([account]);
    expect(await admin.classFor(account!.id)).toEqual(CLASS);
  });
});

describe("an account of the admin gatekeeper whose user is not an admin", () => {
  it("opens nothing for a user who was never one, whatever their storage holds", async () => {
    const { modes, member } = await deployment();
    modes[ADMIN_VENDOR] = "optional";
    // A record of the vendor in the account of a user it was never offered to.
    await seed(member);

    expect(await member.classFor(0)).toBe(ADMINS_ONLY);
    expect(await member.run(user => user.getVerifier(0, ADMIN_VENDOR))).toBeNull();
    expect(await member.run(user => user.selectableGatekeeperUsers(ADMIN_VENDOR))).toEqual([]);
    expect(await member.run(user => user.holdsGatekeeperAccount(ADMIN_VENDOR))).toBe(false);
    expect(await member.feed()).toEqual([]);
    expect(await member.feed(FORCED)).toEqual([]);
    expect(await member.vendors()).toEqual([]);
    expect(await member.addable()).toEqual([OTHER_VENDOR]);
    expect(await member.run(user => user.listProvidedAccounts())).toEqual([]);
  });

  it("opens nothing for a user who never signed in, though ADMINS names their profile",
      async () => {
    const { shared, modes, unsigned } = await deployment();
    modes[ADMIN_VENDOR] = "optional";
    // The object has only the profile every user object starts with, which is nobody's: here
    // the deployment's ADMINS names it, and the object's storage holds a record of the vendor.
    shared.ADMINS = [await unsigned.run(user => user.storage.profile.get().id)];
    await seed(unsigned);

    expect(await unsigned.run(user => user.whoamiIfExists())).toBeNull();
    expect(await unsigned.run(user => user.holdsGatekeeperAccount(ADMIN_VENDOR))).toBe(false);
    expect(await unsigned.feed()).toEqual([]);
    expect(await unsigned.feed(FORCED)).toEqual([]);
    expect(await unsigned.provision(ADMIN_VENDOR)).toBe(ADMINS_ONLY);
    expect(await unsigned.classFor(0)).toBe(ADMINS_ONLY);
    expect(await unsigned.run(user => user.getVerifier(0, ADMIN_VENDOR))).toBeNull();
    expect(await unsigned.vendors()).toEqual([]);
    expect(await unsigned.addable()).toEqual([OTHER_VENDOR]);
    expect(await unsigned.stored()).toEqual([0]);

    // Being created is all that was missing: the same object, as a first sign-in marks it.
    await unsigned.run(user => user.storage.created.put(true));
    expect(await unsigned.run(user => user.holdsGatekeeperAccount(ADMIN_VENDOR))).toBe(true);
    expect(await unsigned.feed())
        .toEqual([{ id: 0, vendorId: ADMIN_VENDOR, resources: [RESOURCE_URL] }]);
    expect(await unsigned.classFor(0)).toEqual(CLASS);
  });

  it("is hidden from an admin who is demoted, and back, the same, once they are restored",
      async () => {
    const { shared, modes, admin } = await deployment();
    modes[ADMIN_VENDOR] = "optional";
    expect(await admin.provision(ADMIN_VENDOR)).toBeUndefined();
    const [account] = await admin.feed();
    expect(await admin.run(user => user.selectableGatekeeperUsers(ADMIN_VENDOR))).toHaveLength(1);

    shared.ADMINS = [];
    expect(await admin.feed()).toEqual([]);
    expect(await admin.feed(FORCED)).toEqual([]);
    expect(await admin.classFor(account!.id)).toBe(ADMINS_ONLY);
    expect(await admin.run(user => user.getVerifier(account!.id, ADMIN_VENDOR))).toBeNull();
    expect(await admin.run(user => user.selectableGatekeeperUsers(ADMIN_VENDOR))).toEqual([]);
    expect(await admin.vendors()).toEqual([]);
    expect(await admin.addable()).toEqual([OTHER_VENDOR]);
    expect(await admin.provision(ADMIN_VENDOR)).toBe(ADMINS_ONLY);
    // The account is kept, not deleted.
    expect(await admin.stored()).toEqual([account!.id]);

    // A forced account is hidden the same way.
    modes[ADMIN_VENDOR] = "enabled";
    expect(await admin.feed(FORCED)).toEqual([]);

    modes[ADMIN_VENDOR] = "optional";
    shared.ADMINS = [admin.id.toUpperCase()];
    expect(await admin.feed()).toEqual([account]);
    expect(await admin.classFor(account!.id)).toEqual(CLASS);
    expect(await admin.run(user => user.getVerifier(account!.id, ADMIN_VENDOR))).not.toBeNull();
    expect(await admin.stored()).toEqual([account!.id]);
  });
});

// What a stored record of the admin vendor is seeded with to declare a singleton and a UI, and
// the three questions that then reach account 0 as a provided account.
const PROVIDES: Partial<AccountDescription> = {
  singleton: { tsType: "DeploymentAdmin" }, providesUi: { title: "Deployment admin" },
};
const provided = (user: TestUser) => user.run(async object =>
    (await object.listProvidedAccounts()).map(({ accountId, vendorId }) => ({ accountId, vendorId })));
const singletonClass = (user: TestUser) =>
    user.run(object => refusal(object.getSingletonGatekeeperClass(0)));
// Selecting oneself answers null once the app is found, so only a missing app refuses.
const selection = (user: TestUser) =>
    user.run(object => refusal(object.createGatekeeperUserSelection(0, user.id)));

describe("a stored account of the admin gatekeeper that declares a singleton and a UI", () => {
  it("is provided to its user only while they are an admin", async () => {
    const { shared, modes, admin, member } = await deployment();
    modes[ADMIN_VENDOR] = "optional";
    await seed(admin, PROVIDES);
    await seed(member, PROVIDES);

    expect(await provided(admin)).toEqual([{ accountId: 0, vendorId: ADMIN_VENDOR }]);
    expect(await selection(admin)).toBeUndefined();
    expect(await singletonClass(admin)).toBeUndefined();

    shared.ADMINS = [];
    for (const user of [admin, member]) {
      expect(await provided(user)).toEqual([]);
      expect(await singletonClass(user)).toBe(ADMINS_ONLY);
      expect(await selection(user)).toBe("No such app.");
    }

    shared.ADMINS = [admin.id];
    expect(await provided(admin)).toEqual([{ accountId: 0, vendorId: ADMIN_VENDOR }]);
    expect(await provided(member)).toEqual([]);
    expect(await singletonClass(member)).toBe(ADMINS_ONLY);
    expect(await selection(member)).toBe("No such app.");
  });
});

describe("another vendor that auto-provisions its account", () => {
  it("is offered to every user in each mode of the admin gatekeeper, and never in the picker",
      async () => {
    const { modes, admin, member } = await deployment();
    for (const mode of [undefined, "disabled", "optional", "enabled"] as const) {
      if (mode === undefined) delete modes[ADMIN_VENDOR]; else modes[ADMIN_VENDOR] = mode;
      for (const user of [admin, member]) {
        expect(await user.addable()).toContain(OTHER_VENDOR);
        // It offers no resource to connect, so no picker lists it.
        expect((await user.vendors()).map(vendor => vendor.id)).not.toContain(OTHER_VENDOR);
      }
    }

    for (const user of [admin, member]) {
      expect(await user.provision(OTHER_VENDOR)).toBeUndefined();
      expect(ofVendor(await user.feed(), OTHER_VENDOR)).toHaveLength(1);
      expect(await user.addable()).not.toContain(OTHER_VENDOR);
      expect((await user.vendors()).map(vendor => vendor.id)).not.toContain(OTHER_VENDOR);
    }

    // Its own mode decides for it, for an admin and anyone else alike.
    modes[OTHER_VENDOR] = "disabled";
    for (const user of [admin, member]) {
      expect(await user.addable()).not.toContain(OTHER_VENDOR);
      expect(ofVendor(await user.feed(FORCED), OTHER_VENDOR)).toEqual([]);
    }
    modes[OTHER_VENDOR] = "enabled";
    for (const user of [admin, member]) {
      expect(ofVendor(await user.feed(), OTHER_VENDOR)).toEqual([]);
      expect(ofVendor(await user.feed(FORCED), OTHER_VENDOR)).toHaveLength(1);
    }
  });
});

describe("a workspace of an admin who holds the account", () => {
  it.each<AmbientGatekeeperMode>(["optional", "enabled"])(
      "is given no connection by being opened, in mode %s", mode => adminWorkspace(async ws => {
    expect(await ws.ownerDo.holdsGatekeeperAccount(ADMIN_VENDOR)).toBe(true);
    await ws.impl.ensureAmbientCapsules();
    expect([...ws.impl.storage.gatekeepers.list()]).toEqual([]);
  }, { mode, connection: false }));
});
