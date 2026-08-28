// Authorization and observer verification run only at open(), so widening what a collaborator must
// be verified against would otherwise leave their live session holding access nobody checked. Each
// widening restarts the workspace (scheduleAccessRestart), forcing every client to re-open and
// re-verify against the new scope -- and a workspace with no collaborators is never disturbed,
// since the owner is never an observer.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-coverage-scrub.test.ts). scheduleAccessRestart is replaced with a recorder: a real
// ctx.abort() would kill the test DO.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

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

  it("a failed re-verification severs the collaborator's other sessions",
      () => withImpl(async (impl, restarts) => {
    addCollaborator(impl);
    seedGatekeeper(impl, 1);
    // Alice's previous open left coverage that her still-live sessions rest on.
    impl.storage.observers.put(
        { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });
    impl.getGatekeeperFacet = () => ({
      addObserver: async () => { throw new Error("access revoked upstream"); },
      removeObserver: async () => {},
    });
    let fakeClientUser =
        { getVerifier: async () => ({}), describeConnectedAccount: async () => null } as any;
    // Answers every prompt with the same account, so each attempt fails the same way.
    let configureCb = { configure: async (needs: { gatekeeperId: number }[]) =>
        needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 10 })) } as any;

    await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
        .rejects.toThrow(/could not confirm/);
    await settle();

    // The scrub only rewrites what the record claims; the restart is what reaches the sessions.
    expect(1 in impl.storage.observers.get("alice").accountChoices).toBe(false);
    expect(restarts).toHaveLength(1);

    // A second identical failure finds the entry already scrubbed, so nothing shrank and nothing
    // restarts: the trigger cannot loop against a collaborator who simply keeps failing.
    await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
        .rejects.toThrow(/could not confirm/);
    await settle();
    expect(restarts).toHaveLength(1);
  }));
});
