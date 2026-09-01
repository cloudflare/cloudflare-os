// Authorization and observer verification run only at open(), so widening what a collaborator must
// be verified against would otherwise leave their live session holding access nobody checked. Each
// widening restarts the workspace (scheduleAccessRestart), forcing every client to re-open and
// re-verify against the new scope -- and a workspace where no collaborator is actually connected is
// never disturbed, since severing sessions is all a restart does and the owner is never an
// observer.
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

let doCounter = 0;

async function withImpl(
    fn: (impl: any, restarts: string[], instance: OverseerDurableObject) => Promise<void>)
    : Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`observer-scope-restart-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    // Seed the cached owner profile id so the sharing manager needs no User DO round trip.
    impl.ownerProfileId = OWNER;
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    await fn(impl, restarts, instance);
  });
}

// Open a collaborator session of the given role, which is what the restart gate counts (an entry in
// the sharing table is not: a collaborator who isn't connected has no session to sever).
function joinSession(impl: any, role: "build" | "use" = "build"): () => void {
  return impl.joinSession(role);
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
  it("adding a connection restarts a connected build collaborator",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl);
    stubFacets(impl);

    // A new account-requiring connection is immediately in every "build" collaborator's scope,
    // and this live session was never verified against it.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);

    expect(restarts).toHaveLength(1);
  }));

  it("a connection under construction is unreachable until the restart is scheduled",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl);
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

    // The DO's input gate is open across describe(), so a live build session gets a turn here --
    // before the restart has severed it. Nothing is published for it to find.
    expect(impl.storage.gatekeepers.get(id)).toBeUndefined();
    await expect(client.getGatekeeperById(id)).rejects.toThrow(/No such gatekeeper id/);
    expect(restarts).toEqual([]);

    releaseDescribe();
    await added;

    expect(impl.storage.gatekeepers.get(id).resourceTitle).toBe("Test");
    expect(restarts).toHaveLength(1);
  }));

  it("the added connection stays blocked until the scheduled reset lands",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl);
    stubFacets(impl);
    // A "build" client interface whose blocked-connection check is the real impl's.
    let client = await openFakeOverseer(
        { gatekeepers: impl.storage.gatekeepers },
        { impl: { assertGatekeeperUsable: (id: number) => impl.assertGatekeeperUsable(id) } });

    let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    let id = await added.getId();
    expect(restarts).toHaveLength(1);

    // The record had to be published before the reset (or the connection would be lost with the
    // restart), but the sessions the reset is about to sever stay live for its response-delivery
    // delay. Until the reset lands -- destroying this object, in-memory mark and all -- every
    // route to the new connection is refused: the mint a stale client can pipeline on...
    await expect(client.getGatekeeperById(id)).rejects.toThrow(/restarting/);
    // ...and the session chokepoint itself, which binding loopbacks also pass through.
    await expect(added.openSession()).rejects.toThrow(/restarting/);
  }));

  it("with nobody to sever, the added connection is immediately usable",
      () => withImpl(async (impl, restarts) => {
    stubFacets(impl);

    // No restart is scheduled, so nothing will ever clear a mark: the connection must not be
    // blocked, or an unshared workspace would brick every new connection.
    let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toEqual([]);
    expect(() => impl.assertGatekeeperUsable(added.id)).not.toThrow();
  }));

  it("adding a connection with no collaborator connected disturbs nobody",
      () => withImpl(async (impl, restarts) => {
    stubFacets(impl);

    // Severing sessions is all a restart does, and the owner is never an observer, so with no
    // collaborator session live there is nothing to sever.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);

    expect(restarts).toEqual([]);
  }));

  it("adding a vendorless connection widens nothing", () => withImpl(async (impl, restarts) => {
    joinSession(impl);
    stubFacets(impl);

    // #inScopeGatekeepers skips a spec with no vendorId, so no collaborator is ever verified
    // against an AI model binding and adding one cannot leave anyone under-verified.
    await impl.addGatekeeper({} as any, {
      type: "aiModel", modelId: "m", provider: "anthropic", modelName: "claude",
    });

    expect(restarts).toEqual([]);
  }));

  it("binding a connection into a gadget restarts a connected use collaborator",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // A permanent edge puts the connection into "use" scope: the gadget UI the collaborator drives
    // can now invoke it.
    impl.bindWorkpiece(100, "DB", 1);

    expect(restarts).toHaveLength(1);
  }));

  it("a pending bind is invisible to collaborators, so it restarts nothing",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // An edge provisional to a chat isn't in #gadgetBoundGatekeeperIds until it's promoted, which
    // is what restarts (see the merge case below).
    impl.bindWorkpiece(100, "DB", 1, 7);

    expect(restarts).toEqual([]);
  }));

  it("promoting a pending bind at merge restarts a connected use collaborator",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
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
    expect(restarts).toEqual([]);

    expect(await impl.mergeChanges(1, USER_META, "owner-user-do"))
        .toEqual({ outcome: "merged" });

    // Accepting the change is the moment the edge becomes visible to "use" collaborators.
    expect(impl.storage.gadgets.get(100).bindings.DB.pending).toBeUndefined();
    expect(restarts).toHaveLength(1);
  }));

  it("a merge that promotes only a vendorless edge restarts nothing",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
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

    // The edge is promoted, but a vendorless connection is in nobody's verification scope, so the
    // effective scope is unchanged and no collaborator's session is interrupted. (The trigger
    // compares scopes rather than restarting on any promotion, which most merges are.)
    expect(impl.storage.gadgets.get(100).bindings.MODEL.pending).toBeUndefined();
    expect(restarts).toEqual([]);
  }));

  it("a session of the unaffected role is left alone", () => withImpl(async (impl, restarts) => {
    joinSession(impl, "build");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // Binding widens "use" scope only. The connection has been in "build" scope since it was
    // created, so this session's verification requirements don't change.
    impl.bindWorkpiece(100, "DB", 1);

    expect(restarts).toEqual([]);
  }));

  it("an open parked in verification counts as a session of its role",
      () => withImpl(async (impl, restarts) => {
    stubFacets(impl);
    impl.getSharingManager = async () => ({ getEffectiveRole: () => "build" });
    // Verification parks on collaborator-controlled awaits (the configuration prompt, verifier
    // RPCs), and the parked open holds no client interface yet -- only the authorization lease
    // counts it.
    let release!: () => void;
    let reached = new Promise<void>(resolve => {
      impl.ensureObserver = () => {
        resolve();
        return new Promise<void>(r => { release = r; });
      };
    });
    let parked = impl.authorizeCollaborator("carol", {} as any, {});
    await reached;

    // A connection added while the open is parked widens the scope it is being verified against,
    // so the restart must fire -- resetting the DO takes the parked open with it and the client
    // retries against the new scope.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);

    release();
    expect(await parked).toBe("build");

    // The lease ended with the call (the caller's interface, not tested here, takes over the
    // count), so a further widening finds nothing to sever.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);
  }));

  it("an external message counts as a live build session while it is processed",
      () => withImpl(async (impl, restarts, instance) => {
    stubFacets(impl);
    // A workspace owned by someone else, so the caller is a collaborator.
    impl.ownerId = "owner-user-id";
    impl.users = {
      getByName: () => ({
        id: { toString: () => "caller-user-id" },
        whoamiIfExists: async () => ({ type: "user", id: "carol", name: "Carol" }),
      }),
    };
    let fail!: (err: Error) => void;
    let reached = new Promise<void>(resolve => {
      impl.authorizeCollaborator = () => {
        resolve();
        return new Promise((_, reject) => { fail = reject; });
      };
    });

    // This path never constructs a counted client interface, so without its own lease a widening
    // mid-call would find no session to sever and the reply would be produced under stale
    // verification.
    let pending = instance.receiveExternalMessage({
      callerEmail: "carol@example.com", externalChatKey: "k", idempotencyKey: "i",
      prompt: "hello", chatGatewayRpcTarget: {} as any, title: "T",
    } as any);
    await reached;

    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);

    fail(new Error("verification failed"));
    expect((await pending).accepted).toBe(false);

    // The lease died with the call.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);
  }));

  it("a retained connection capability holds the gate open after its interface is gone",
      () => withImpl(async (impl, restarts) => {
    stubFacets(impl);

    // A connection capability minted into a collaborator's session (joinAs "build") counts for
    // its own lifetime: the client can dispose the interface that minted it and retain this.
    let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC, "build");
    expect(restarts).toEqual([]);

    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);

    added[Symbol.dispose]();
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);
  }));

  it("a retained gadget capability from a use session holds the gate open",
      () => withImpl(async (impl, restarts) => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    // A real "use" client interface whose session counting is the real impl's.
    let client = await openFakeOverseer(
        { gadgets: impl.storage.gadgets },
        { role: "use", impl: {
            joinSession: (kind: string) => impl.joinSession(kind),
            getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
          } });
    let child = await client.getGadget(100);

    // Disposing the top-level interface leaves the child capability live, and the gadget UI it
    // reaches can invoke whatever the gadget binds -- so it must keep counting.
    (client as any)[Symbol.dispose]();
    impl.bindWorkpiece(100, "DB", 1);
    expect(restarts).toHaveLength(1);

    // Only once it too is gone does a widening find nothing to sever.
    (child as any)[Symbol.dispose]();
    seedGatekeeper(impl, 2);
    impl.bindWorkpiece(100, "DB2", 2);
    expect(restarts).toHaveLength(1);
  }));

  it("a session that has closed no longer holds the gate open",
      () => withImpl(async (impl, restarts) => {
    let leave = joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // The collaborator is still in the sharing graph, but their session is gone: there is nothing
    // left holding access that was admitted at the narrower scope.
    leave();
    impl.bindWorkpiece(100, "DB", 1);

    expect(restarts).toEqual([]);
  }));

  it("a failed re-verification leaves the collaborator's other sessions alone",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl);
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

    // Only this open is denied. Nothing widened, so Alice's other sessions keep the access their
    // own opens verified until they next re-open (lazy revocation), and her record still holds the
    // choice she made -- it records that choice, not a verification result.
    expect(impl.storage.observers.get("alice").accountChoices).toEqual({ 1: 10 });
    expect(restarts).toEqual([]);
  }));
});
