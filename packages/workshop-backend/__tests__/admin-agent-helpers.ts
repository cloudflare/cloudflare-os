// What the admin gatekeeper suites share: adminWorkspace(), the ONE way a test gets a workspace
// that has the admin connection. It gives the owner the vendor's account, adds the connection and
// sets the vendor's mode, so that every condition of the lend is met here once and not in every
// suite.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AdminAccessRecord, AiChatAuthorInfo, AmbientGatekeeperMode,
} from "@gadgets/workshop-shared/api";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import type { FakeAdminCall, FakeAdminOutcome } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

/** The pool's deployment admin (vitest.config.ts), who owns an adminWorkspace() by default. */
export const ADMIN: AiChatAuthorInfo =
    { type: "user", id: "deployment-admin@example.test", name: "Admin" };

/** A second deployment admin of an adminWorkspace()'s environment, who owns nothing. */
export const OTHER_ADMIN: AiChatAuthorInfo =
    { type: "user", id: "other-admin@example.test", name: "Other admin" };

/** A user who is not a deployment admin. */
export const NOT_ADMIN: AiChatAuthorInfo =
    { type: "user", id: "member@example.test", name: "Member" };

const OWNER_USER_ID = "owner-user-do";
const RESOURCE_URL = "https://workshop.example/admin";

/** A session of the fake admin gatekeeper (FakeAdminGatekeeper in test-worker.ts), as a suite
 * drives it. Disposing it releases its queue. */
export type FakeAdminSessionStub = Disposable & {
  read(call: FakeAdminCall, keep?: { api?: string; result?: string }, then?: FakeAdminCall)
      : Promise<FakeAdminOutcome>;
  submit(action: number, description: object): Promise<void>;
  observe(description: object): Promise<void>;
};

/** The fake admin gatekeeper's facet, as a suite drives it once a session is gone. */
export type FakeAdminFacet = {
  plan(action: number, calls: FakeAdminCall[]): Promise<void>;
  outcomes(action: number): Promise<FakeAdminOutcome[] | undefined>;
  onKept(name: string, call: FakeAdminCall, keepAs?: string): Promise<FakeAdminOutcome>;
  kept(): Promise<string[]>;
};

/** A workspace that has the admin connection, inside its Durable Object. */
export type AdminWorkspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  /** The workspace's id, as an AdminAgentOrigin names it. */
  id: string;
  owner: AiChatAuthorInfo;
  /** The owner's account: a real user object, which reads `env` and `config` as the workspace
   * does, and which the workspace asks whether its owner holds the vendor's account. */
  ownerDo: DurableObjectStub<UserDurableObject>;
  /** The admin connection's id. */
  gatekeeperId: number;
  /** The facet behind the connection: the fake admin gatekeeper. */
  facet: FakeAdminFacet;
  /** The environment the workspace reads, which a test may change: `ADMINS` to demote someone. */
  env: Record<string, unknown> & { ADMINS: string[] };
  /** The deployment's stored settings, as the fake KV serves them on every read. */
  config: {
    ambientGatekeeperModes: Record<string, AmbientGatekeeperMode>;
    disabledGatekeepers: string[];
    [setting: string]: unknown;
  };
  /** A session of the connection for `caller`: the owner's own direct session by default. `holder`
   * is the collaborator the session is minted into, as openGatekeeperSession() is given one. */
  session(caller?: GatekeeperCaller, holder?: { kind: "build"; profileId: string })
      : Promise<FakeAdminSessionStub>;
  /** The deployment-wide audit log's records for this workspace, oldest first. */
  records(): Promise<AdminAccessRecord[]>;
};

/**
 * Runs `run` inside a fresh workspace that has the admin connection, added as
 * Overseer.newGatekeeper() adds one (a "gatekeeper" record of ADMIN_GATEKEEPER_VENDOR_ID) over
 * the fake admin gatekeeper, with the vendor's mode set explicitly ("optional" unless `mode`
 * says otherwise). Its owner is `owner` (ADMIN by default) and its deployment admins are ADMIN
 * and OTHER_ADMIN, or `admins`. An owner who is one of those admins has provisioned the vendor's
 * account (FakeAdminVendor in test-worker.ts), as an admin adds it from Connectors, before the
 * mode is set; `account: false` leaves them without it. The workspace and its owner's account
 * read their environment and the admin config from `ws.env` and `ws.config`, so a test changes
 * either between two calls. `connection: false` leaves the connection out.
 */
export async function adminWorkspace(
    run: (ws: AdminWorkspace) => Promise<void>,
    options: {
      owner?: AiChatAuthorInfo;
      admins?: string[];
      mode?: AmbientGatekeeperMode;
      connection?: boolean;
      account?: boolean;
    } = {}): Promise<void> {
  let owner = options.owner ?? ADMIN;
  let config: AdminWorkspace["config"] = {
    ambientGatekeeperModes: { [ADMIN_GATEKEEPER_VENDOR_ID]: "optional" },
    disabledGatekeepers: [],
  };
  let workspaceEnv = {
    ...env,
    ADMINS: options.admins ?? [ADMIN.id, OTHER_ADMIN.id],
    BLUEPRINTS: {
      get: async (key: string) => key === ADMIN_CONFIG_KEY ? JSON.stringify(config) : null,
    },
  };

  let ownerName = `admin-agent-owner-${crypto.randomUUID()}`;
  await runInDurableObject(env.TEST_USER.getByName(ownerName), async (user: UserDurableObject) => {
    Object.assign(user, { env: workspaceEnv });
    // The account as a first sign-in leaves it, written here so that the deployment's user
    // directory, which the suites list, is not told of it.
    let { storage } = user as unknown as { storage: {
      created: { put(created: boolean): void }; profile: { put(profile: AiChatAuthorInfo): void };
    } };
    storage.created.put(true);
    storage.profile.put(owner);
    if ((options.account ?? true) && workspaceEnv.ADMINS.includes(owner.id)) {
      await user.provisionAmbientAccount(ADMIN_GATEKEEPER_VENDOR_ID);
    }
  });
  config.ambientGatekeeperModes[ADMIN_GATEKEEPER_VENDOR_ID] = options.mode ?? "optional";

  let stub = env.TEST_OVERSEER.getByName(`admin-agent-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    // A stub made here, inside the workspace, which is where it is called from.
    let ownerDo = env.TEST_USER.getByName(ownerName);
    // The lend reads the environment through the impl, a hook's start through the object.
    impl.env = workspaceEnv;
    Object.assign(instance, { env: workspaceEnv });

    impl.directories = {
      getByName: () => ({ syncWorkspace: async () => {}, removeWorkspace: async () => {} }),
    };
    impl.users = {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        id, whoami: async () => owner, getGadget: async () => null,
        getChatContext: async () => ({ profile: owner }),
        liveAccountAdminGrant: async () => null,
        holdsGatekeeperAccount: (vendorId: string) => ownerDo.holdsGatekeeperAccount(vendorId),
        listProvidedAccounts: () => ownerDo.listProvidedAccounts(),
        messageArrived: async () => {}, setWorkspaceLastActive: async () => {},
        getWorkspace: async () => null, syncWorkspaceOutputs: async () => {},
      }),
      // An admin's write names its admin by the profile it reads here.
      getByName: (name: string) =>
          ({ whoamiIfExists: async () => name === owner.id ? owner : null }),
    };
    impl.ownerId = OWNER_USER_ID;
    impl.ownerProfileId = owner.id;
    impl.storage.ownerId.put(OWNER_USER_ID);
    impl.storage.title.put("Triage");

    let gatekeeperId = -1;
    if (options.connection ?? true) {
      let client = await impl.addGatekeeper(
          impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
          {
            type: "gatekeeper", vendorId: ADMIN_GATEKEEPER_VENDOR_ID, resourceUrl: RESOURCE_URL,
            typeUrlPattern: RESOURCE_URL,
          },
          OWNER_USER_ID, undefined, undefined, owner);
      gatekeeperId = await client.getId();
    }

    await run({
      impl, instance, state, id: state.id.toString(), owner, ownerDo, gatekeeperId,
      facet: gatekeeperId < 0 ? undefined : await impl.getGatekeeperFacet(gatekeeperId),
      env: workspaceEnv as unknown as AdminWorkspace["env"],
      config,
      session: async (caller = { from: "user" }, holder) => impl.openGatekeeperSession(
          gatekeeperId, await impl.getGatekeeperFacet(gatekeeperId), caller, undefined, holder),
      records: async () => {
        let page = await env.TEST_ADMIN_AUDIT.getByName("")
            .list({ workspace: state.id.toString(), limit: 200 }, 90);
        return (page.records as AdminAccessRecord[]).toReversed();
      },
    });
  });
}
