// Authorization and observer verification run only at open(), so widening what a collaborator must
// be verified against would otherwise leave their live session holding access nobody checked. Each
// widening restarts the workspace (scheduleAccessRestart), forcing every client to re-open and
// re-verify against the new scope -- and a workspace with no collaborators is never disturbed,
// since the owner is never an observer.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). scheduleAccessRestart is
// replaced with a recorder: a real reset would kill the test DO.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "owner";
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER_META = { profile: { type: "user", id: OWNER, name: "Owner" } as AiChatAuthorInfo };

// #restartIfShared is fire-and-forget over an async getSharingManager(), so let its continuation
// run before asserting.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let doCounter = 0;

async function withImpl(fn: (impl: any, restarts: string[]) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`observer-scope-restart-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    // Seed the cached owner profile id so the sharing manager needs no User DO round trip.
    impl.ownerProfileId = OWNER;
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    await fn(impl, restarts);
  });
}

function addCollaborator(impl: any, role: "build" | "use" = "build"): void {
  impl.storage.collaborators.put({
    profile: { type: "user", id: "alice", name: "Alice" },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role }],
  });
}

function seedGatekeeper(impl: any, id: number): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Connection ${id}`,
    class: {} as any,
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

// A vendorless connection (an AI model), which no collaborator is ever verified against.
function seedVendorlessGatekeeper(impl: any, id: number): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Model ${id}`,
    class: {} as any,
    creationSpec: {
      type: "aiModel", modelId: `m${id}`, provider: "anthropic", modelName: "claude",
    },
  });
}

function seedGadget(impl: any, id: number): void {
  impl.storage.gadgets.put(
      { id, title: "G", created: new Date(0), bindingName: "G", bindings: {} });
}

// A facet that lets addGatekeeper's describe() succeed.
function stubFacets(impl: any): void {
  impl.getGatekeeperFacet = () => ({
    describe: async () => ({ title: "Test", url: "https://example.com/new" }),
  });
}

const CONNECTION_SPEC = {
  type: "gatekeeper" as const,
  vendorId: "testvendor",
  resourceUrl: "https://example.com/new",
  typeUrlPattern: "https://*",
};

describe("restarting sessions when verification scope widens", () => {
  it("adding a connection restarts a shared workspace", () => withImpl(async (impl, restarts) => {
    addCollaborator(impl);
    stubFacets(impl);

    // A new account-requiring connection is immediately in every "build" collaborator's scope,
    // and their live session was never verified against it.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    await settle();

    expect(restarts).toHaveLength(1);
  }));

  it("a connection under construction is unreachable until the restart is scheduled",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl);
    let releaseDescribe!: () => void;
    let describing = new Promise<void>(resolve => { releaseDescribe = resolve; });
    impl.getGatekeeperFacet = () => ({
      describe: async () => {
        await describing;
        return { title: "Test", url: "https://example.com/new" };
      },
    });
    // A "build" client interface over this DO's real gatekeeper table, which is all
    // getGatekeeperById consults.
    let client = await openFakeOverseer({ gatekeepers: impl.storage.gatekeepers });

    // Ids are allocated sequentially, so a client can simply guess the next one.
    let id = impl.storage.nextGatekeeperId.get();
    let added = impl.addGatekeeper({} as any, CONNECTION_SPEC);
    await settle();

    // The DO's input gate is open across describe(), so a live build session gets a turn here --
    // before #restartIfShared has severed it. Nothing is published for it to find.
    expect(impl.storage.gatekeepers.get(id)).toBeUndefined();
    await expect(client.getGatekeeperById(id)).rejects.toThrow(/No such gatekeeper id/);
    expect(restarts).toEqual([]);

    releaseDescribe();
    await added;
    await settle();

    expect(impl.storage.gatekeepers.get(id).resourceTitle).toBe("Test");
    expect(restarts).toHaveLength(1);
  }));

  it("adding a connection to a solo workspace disturbs nobody",
      () => withImpl(async (impl, restarts) => {
    stubFacets(impl);

    // The owner is never an observer, so there is nobody to re-verify -- and the one session that
    // exists is the one that asked for the connection.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    await settle();

    expect(restarts).toEqual([]);
  }));

  it("adding a vendorless connection widens nothing", () => withImpl(async (impl, restarts) => {
    addCollaborator(impl);
    stubFacets(impl);

    // #inScopeGatekeepers skips a spec with no vendorId, so no collaborator is ever verified
    // against an AI model binding and adding one cannot leave anyone under-verified.
    await impl.addGatekeeper({} as any, {
      type: "aiModel", modelId: "m", provider: "anthropic", modelName: "claude",
    });
    await settle();

    expect(restarts).toEqual([]);
  }));

  it("binding a connection into a gadget restarts a shared workspace",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // A permanent edge puts the connection into "use" scope: the gadget UI the collaborator drives
    // can now invoke it.
    impl.bindWorkpiece(100, "DB", 1);
    await settle();

    expect(restarts).toHaveLength(1);
  }));

  it("a pending bind is invisible to collaborators, so it restarts nothing",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // An edge provisional to a chat isn't in #gadgetBoundGatekeeperIds until it's promoted, which
    // is what restarts (see the merge case below).
    impl.bindWorkpiece(100, "DB", 1, 7);
    await settle();

    expect(restarts).toEqual([]);
  }));

  it("promoting a pending bind at merge restarts a shared workspace",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });

    impl.bindWorkpiece(100, "DB", 1, 1);
    await impl.commitAgentStep(1, AGENT, [{ type: "message", message: "bound a connection" }], {
      changes: [],
      createdGadgets: [],
      addedBindings: [{ gadgetId: 100, name: "DB", target: 1 }],
    });
    await settle();
    expect(restarts).toEqual([]);

    expect(await impl.mergeChanges(1, USER_META, "owner-user-do"))
        .toEqual({ outcome: "merged" });
    await settle();

    // Accepting the change is the moment the edge becomes visible to "use" collaborators.
    expect(impl.storage.gadgets.get(100).bindings.DB.pending).toBeUndefined();
    expect(restarts).toHaveLength(1);
  }));

  it("a merge that promotes only a vendorless edge restarts nothing",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl, "use");
    seedVendorlessGatekeeper(impl, 1);
    seedGadget(impl, 100);
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });

    impl.bindWorkpiece(100, "MODEL", 1, 1);
    await impl.commitAgentStep(1, AGENT, [{ type: "message", message: "bound a model" }], {
      changes: [],
      createdGadgets: [],
      addedBindings: [{ gadgetId: 100, name: "MODEL", target: 1 }],
    });

    expect(await impl.mergeChanges(1, USER_META, "owner-user-do"))
        .toEqual({ outcome: "merged" });
    await settle();

    // The edge is promoted, but a vendorless connection is in nobody's verification scope, so the
    // effective scope is unchanged and no collaborator's session is interrupted. (The trigger
    // compares scopes rather than restarting on any promotion, which most merges are.)
    expect(impl.storage.gadgets.get(100).bindings.MODEL.pending).toBeUndefined();
    expect(restarts).toEqual([]);
  }));

  it("a failed re-verification leaves the collaborator's other sessions alone",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl);
    seedGatekeeper(impl, 1);
    impl.storage.observers.put(
        { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });
    impl.getGatekeeperFacet = () => ({
      addObserver: async () => { throw new Error("access revoked upstream"); },
      removeObserver: async () => {},
    });
    let fakeClientUser =
        { getVerifier: async () => ({}), describeConnectedAccount: async () => null } as any;
    // Answers every prompt with the same account, so the attempt fails the same way each pass.
    let configureCb = { configure: async (needs: { gatekeeperId: number }[]) =>
        needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 10 })) } as any;

    await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
        .rejects.toThrow(/could not confirm/);
    await settle();

    // Only this open is denied. Nothing widened, so Alice's other sessions keep the access their
    // own opens verified until they next re-open (lazy revocation), and her record still holds the
    // choice she made -- it records that choice, not a verification result.
    expect(impl.storage.observers.get("alice").accountChoices).toEqual({ 1: 10 });
    expect(restarts).toEqual([]);
  }));
});
