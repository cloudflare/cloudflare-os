// Who created a connection (GatekeeperRecord.createdBy): the member whose session made it, or the
// initiator of the agent turn whose tool call created its resource. An ambient capsule, which the
// workspace installs from its owner's singleton accounts, has none. The suite also pins which
// member sessions OverseerImpl.liveSessionCounts() counts, since it holds the one helper that opens
// both an owner's and a collaborator's.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). Gatekeeper facets and the
// users' Durable Objects are fakes: a facet whose describe() resolves is all a creation needs.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, GatekeeperCreationSpec, Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const COLLABORATOR_USER_ID = "collaborator-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
const COLLABORATOR: AiChatAuthorInfo = { type: "user", id: "carol@example.test", name: "Carol" };
// A spawned agent's turn is initiated by the gadget that spawned it.
const GADGET: AiChatAuthorInfo = { type: "gadget", id: OWNER.id, name: "Mailer" };
const PROFILES: Record<string, AiChatAuthorInfo> = {
  [OWNER_USER_ID]: OWNER,
  [COLLABORATOR_USER_ID]: COLLABORATOR,
};

const CHAT_ID = 1;
// Another chat of the workspace, with a turn of its own under way.
const OTHER_CHAT_ID = 2;
const ACCOUNT_ID = 7;
const VENDOR_ID = "TestVendor";
const URL_PATTERN = "https://example.com/*";
const CONNECTION_SPEC = {
  type: "gatekeeper" as const,
  vendorId: VENDOR_ID,
  resourceUrl: "https://example.com/doc",
  typeUrlPattern: URL_PATTERN,
};

// A user's Durable Object, as far as creating a connection calls it.
function fakeUser(userId: string) {
  let profile = PROFILES[userId];
  return {
    id: userId,
    whoami: async () => profile,
    getGatekeeperClassFor: async () => ({
      class: {}, vendorId: VENDOR_ID, typeUrlPattern: URL_PATTERN,
    }),
    getChatContext: async () => ({
      profile,
      aiModel: {
        profile: { type: "agent", id: "some-model", name: "Model" },
        config: { provider: "anthropic", model: "some-model", apiToken: "unused" },
      },
    }),
    createResourceGatekeeper: async () => ({
      class: {}, typeUrlPattern: URL_PATTERN,
      action: { title: "Create", description: "Create", implementsRevert: false },
    }),
    recordSharedWorkspaceOpen: async () => {},
  };
}

// A workspace owned by OWNER_USER_ID, with the facets and the users' Durable Objects faked.
async function withImpl(
    fn: (impl: any, instance: OverseerDurableObject) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`connection-creator-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.users = { idFromString: (id: string) => id, get: fakeUser };
    impl.wrapUserDo = (user: unknown) => user;
    impl.getGatekeeperFacet = () => ({
      describe: async () => ({ title: "Test", url: "https://example.com/doc" }),
    });
    // A real restart would abort the test's Durable Object.
    impl.scheduleAccessRestart = async () => {};
    await fn(impl, instance);
  });
}

// Like withImpl, but also opens the real OverseerClientInterface over the impl, as the owner or as
// a "build" collaborator. The open-time work that is not about the session itself (ambient
// capsules, the deployment directory, the outputs index, observer verification) is stubbed.
async function withClient(
    userId: string, fn: (impl: any, client: Overseer) => Promise<void>): Promise<void> {
  await withImpl(async (impl, instance) => {
    impl.ensureAmbientCapsules = async () => {};
    impl.syncDirectory = () => {};
    impl.markOutputsDirty = () => {};
    impl.syncOutputsTo = async () => {};
    impl.authorizeCollaborator = async () => ({ role: "build" });
    // The pool binds no model gatekeeper class, so its ctx.exports has none to mint a model
    // connection from. The facets are fakes, so the class is stored and never instantiated.
    Object.defineProperty(impl.ctx, "exports", { value: Object.create(impl.ctx.exports, {
      LanguageModelGatekeeper: { value: () => ({}) },
    }) });
    let client = await instance.open(
        userId, PROFILES[userId].id, new NativeRpcStub<() => void>(() => {}));
    await fn(impl, client);
  });
}

// The workspace's one connection.
function onlyRecord(impl: any): GatekeeperRecord {
  let records: GatekeeperRecord[] = [...impl.storage.gatekeepers.list()];
  expect(records).toHaveLength(1);
  return records[0];
}

describe("addGatekeeper", () => {
  it("records the creator it is given", () => withImpl(async impl => {
    await impl.addGatekeeper(
        {} as any, CONNECTION_SPEC, OWNER_USER_ID, undefined, undefined, COLLABORATOR);

    expect(onlyRecord(impl).createdBy).toEqual(COLLABORATOR);
  }));

  it("records no creator when it is given none", () => withImpl(async impl => {
    await impl.addGatekeeper({} as any, CONNECTION_SPEC, OWNER_USER_ID);

    expect(onlyRecord(impl)).not.toHaveProperty("createdBy");
  }));
});

// Each way a session creates a connection, with the creationSpec of the record it stores.
const CLIENT_PATHS: [string, GatekeeperCreationSpec, (client: Overseer) => unknown][] = [
  ["newGatekeeper", CONNECTION_SPEC,
    client => client.newGatekeeper(ACCOUNT_ID, CONNECTION_SPEC.resourceUrl)],
  ["newAiModelGatekeeper",
    { type: "aiModel", modelId: "some-model", provider: "anthropic", modelName: "some-model" },
    client => client.newAiModelGatekeeper("some-model")],
  ["newAgentSpawnerGatekeeper",
    { type: "agentSpawner", config: { displayName: "Helper", modelId: null } },
    client => client.newAgentSpawnerGatekeeper({ displayName: "Helper", env: {}, modelId: null })],
];

describe("a connection made in a member's session", () => {
  it.each(CLIENT_PATHS)("%s records the owner in the owner's session",
      (_method, creationSpec, create) => withClient(OWNER_USER_ID, async (impl, client) => {
    await create(client);

    expect(onlyRecord(impl)).toMatchObject({ creationSpec, createdBy: OWNER });
  }));

  it.each(CLIENT_PATHS)("%s records the collaborator in a collaborator's session",
      (_method, creationSpec, create) => withClient(COLLABORATOR_USER_ID, async (impl, client) => {
    await create(client);

    expect(onlyRecord(impl)).toMatchObject({ creationSpec, createdBy: COLLABORATOR });
  }));
});

describe("a member's session in the live-session counts", () => {
  it("does not count the owner's", () => withClient(OWNER_USER_ID, async impl => {
    expect(impl.liveSessionCounts()).toStrictEqual({ build: 0, use: 0 });
  }));

  it("counts a collaborator's by its role", () =>
      withClient(COLLABORATOR_USER_ID, async impl => {
    expect(impl.liveSessionCounts()).toStrictEqual({ build: 1, use: 0 });
  }));
});

describe("an ambient capsule", () => {
  it("records no creator", () => withImpl(async impl => {
    impl.ownerUserDo = () => ({
      listProvidedAccounts: async () => [{
        vendorId: VENDOR_ID, accountId: ACCOUNT_ID,
        description: { singleton: { tsType: "Library" } },
      }],
      getSingletonGatekeeperClass: async () => ({}),
    });

    await impl.ensureAmbientCapsules();

    let record = onlyRecord(impl);
    expect(record.creationSpec).toEqual(
        { type: "ambient", vendorId: VENDOR_ID, accountId: ACCOUNT_ID });
    expect(record).not.toHaveProperty("createdBy");
  }));
});

const RESOURCE_INPUT = {
  vendorId: VENDOR_ID, resourceUrlPattern: URL_PATTERN, title: "Notes", bindingName: "NOTES",
};

// Like withImpl, for createExternalResource(): the creation queues an action for approval, whose
// trace needs a running agent. A collaborator's turn is under way in another chat, so that only
// the turn of the chat that creates the resource can name its creator.
function withResourceImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  return withImpl(async impl => {
    impl.traceAgentActionApproval = () => {};
    impl.storage.activeAgents.put({
      chatId: OTHER_CHAT_ID, initiatorUserId: COLLABORATOR_USER_ID, modelId: "some-model",
      initiator: COLLABORATOR, callbackInitiated: false,
    });
    await fn(impl);
  });
}

describe("a resource an agent creates", () => {
  it.each([OWNER, GADGET])("records the initiator of its turn, a $type",
      initiator => withResourceImpl(async impl => {
    impl.storage.activeAgents.put({
      chatId: CHAT_ID, initiatorUserId: OWNER_USER_ID, modelId: "some-model", initiator,
      callbackInitiated: initiator.type === "gadget",
    });

    await impl.createExternalResource(CHAT_ID, RESOURCE_INPUT);

    expect(onlyRecord(impl)).toMatchObject({ resourceTitle: "Notes", createdBy: initiator });
  }));

  it("records no creator when its turn has no record", () => withResourceImpl(async impl => {
    await impl.createExternalResource(CHAT_ID, RESOURCE_INPUT);

    let record = onlyRecord(impl);
    expect(record.resourceTitle).toBe("Notes");
    expect(record).not.toHaveProperty("createdBy");
  }));
});
