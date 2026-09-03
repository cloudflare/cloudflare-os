// Authorization and observer verification run only at open(), so widening what a collaborator must
// be verified against would otherwise leave their live session holding access nobody checked. Each
// widening restarts the workspace (scheduleAccessRestart), forcing every client to re-open and
// re-verify against the new scope -- and a workspace where no collaborator is actually connected is
// never disturbed, since severing sessions is all a restart does and the owner is never an
// observer.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). scheduleAccessRestart is
// replaced with a recorder: a real ctx.abort() would kill the test DO.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
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
      { type: "gadget", id, title: "G", created: new Date(0), bindingName: "G", bindings: {} });
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
    // The severed sessions stay live for the reset's delay, and a gadget facet reload in that
    // window would mint fresh binding loopbacks onto the connection -- so, like a newly added
    // one, it is blocked until the reset lands (loopbacks funnel through openSession, which
    // checks this).
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
  }));

  it("binding with nobody to sever leaves the connection immediately usable",
      () => withImpl(async (impl, restarts) => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // No restart is scheduled, so nothing would ever clear a mark: the connection must not be
    // blocked, or binding in a solo workspace would brick it.
    impl.bindWorkpiece(100, "DB", 1);

    expect(restarts).toEqual([]);
    expect(() => impl.assertGatekeeperUsable(1)).not.toThrow();
  }));

  it("a pending bind is invisible to collaborators, so it restarts nothing",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // An edge provisional to a chat isn't in #useScopeGatekeeperIds until it's promoted, which
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
      createdWorktrees: [],
      worktreeCommits: [],
    });
    expect(restarts).toEqual([]);

    expect(await impl.mergeChanges(1, USER_META, "owner-user-do"))
        .toEqual({ outcome: "merged" });

    // Accepting the change is the moment the edge becomes visible to "use" collaborators.
    expect(impl.storage.gadgets.get(100).bindings.DB.pending).toBeUndefined();
    expect(restarts).toHaveLength(1);
    // And, as with a direct bind, the promoted connection is blocked until the reset lands.
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
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
      createdWorktrees: [],
      worktreeCommits: [],
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

  it("an external message counts as a live build session once its caller is authorized",
      () => withImpl(async (impl, restarts, instance) => {
    stubFacets(impl);
    // A workspace owned by someone else, so the caller is a collaborator. The call parks *after*
    // authorization (on the caller's model lookup), which is when the lease must be held: this
    // path never constructs a counted client interface, so without its own lease a widening
    // mid-call would find no session to sever and the reply would be produced under stale
    // verification.
    impl.ownerId = "owner-user-id";
    let fail!: (err: Error) => void;
    let reached = new Promise<void>(resolve => {
      impl.users = {
        getByName: () => ({
          id: { toString: () => "caller-user-id" },
          whoamiIfExists: async () => ({ type: "user", id: "carol", name: "Carol" }),
          getExternalMessageChatContext: () => {
            resolve();
            return new Promise((_, reject) => { fail = reject; });
          },
        }),
      };
    });
    impl.authorizeCollaborator = async () => "build";

    let pending = instance.receiveExternalMessage({
      callerEmail: "carol@example.com", externalChatKey: "k", idempotencyKey: "i",
      prompt: "hello", chatGatewayRpcTarget: {} as any, title: "T",
    } as any);
    await reached;

    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);

    fail(new Error("model lookup failed"));
    await expect(pending).rejects.toThrow(/model lookup failed/);

    // The lease died with the call.
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);
  }));

  it("an external-message caller who is denied never joins the count",
      () => withImpl(async (impl, restarts, instance) => {
    stubFacets(impl);
    impl.ownerId = "owner-user-id";
    impl.users = {
      getByName: () => ({
        id: { toString: () => "caller-user-id" },
        whoamiIfExists: async () => ({ type: "user", id: "mallory", name: "Mallory" }),
      }),
    };
    // Authorization itself is covered by authorizeCollaborator's own internal lease (which counts
    // nobody until a role is resolved), so this path must not take its lease up front: a stranger
    // parked in authorization racing an addGatekeeper would otherwise cause a needless reset.
    let deny!: () => void;
    let reached = new Promise<void>(resolve => {
      impl.authorizeCollaborator = () => {
        resolve();
        return new Promise(resolveAuth => { deny = () => resolveAuth(null); });
      };
    });

    let pending = instance.receiveExternalMessage({
      callerEmail: "mallory@example.com", externalChatKey: "k", idempotencyKey: "i",
      prompt: "hello", chatGatewayRpcTarget: {} as any, title: "T",
    } as any);
    await reached;

    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toEqual([]);

    deny();
    expect((await pending).accepted).toBe(false);
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

  // A pre-creationSpec record, which observerVendorId() refuses to classify: sharing anything
  // that reaches it requires the owner to reconnect it first.
  function seedLegacyGatekeeper(impl: any, id: number): void {
    impl.storage.gatekeepers.put({ id, resourceTitle: `Legacy ${id}`, class: {} as any });
  }

  it("an unrelated legacy connection does not block a use collaborator",
      () => withImpl(async (impl) => {
    seedLegacyGatekeeper(impl, 1);

    // Nothing binds the legacy record and no hook feeds it, so a "use" collaborator's sessions
    // can't reach it: the scope filter must drop it before the legacy check throws, or one stale
    // record would block every use open in the workspace.
    expect(impl.listObserverRequirements("use")).toEqual([]);
    let fakeClientUser = { listProvidedAccounts: async () => [] } as any;
    await expect(impl.ensureObserver("alice", fakeClientUser, "use")).resolves.toBeUndefined();
  }));

  it("...but a legacy connection still blocks a build collaborator",
      () => withImpl(async (impl) => {
    seedLegacyGatekeeper(impl, 1);

    // "Build" scope is everything, so the record is in scope and the intended fail-closed error
    // still fires: the owner must reconnect it before the workspace can be shared at that level.
    expect(() => impl.listObserverRequirements("build")).toThrow(/reconnected/);
  }));

  it("...and still blocks a use collaborator once a gadget binds it",
      () => withImpl(async (impl) => {
    seedLegacyGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // Bound, the record is genuinely in "use" scope, and verification can't proceed without
    // knowing what to verify against -- same fail-closed refusal as "build".
    impl.bindWorkpiece(100, "DB", 1);
    expect(() => impl.listObserverRequirements("use")).toThrow(/reconnected/);
  }));

  it("binding a legacy connection restarts a connected use collaborator and quarantines it",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedLegacyGatekeeper(impl, 1);
    seedGadget(impl, 100);

    // A legacy record has no vendor, so nobody CAN be verified against it -- but that must make
    // it count on the widening diff, not vanish from both sides of it: binding it is still the
    // moment live use sessions gain a route to it. The restart severs them and the quarantine
    // holds until the reset; fresh use opens then fail closed (/reconnected/, above).
    impl.bindWorkpiece(100, "DB", 1);

    expect(restarts).toHaveLength(1);
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
  }));
});

// An enabled hook is a live write channel into the gadget it wakes, so its connection is in every
// "use" collaborator's verification scope regardless of binding edges -- and enabling one is a
// scope widening like binding one.
describe("hooks widen use scope", () => {
  function seedHook(
      impl: any,
      opts: { enabled?: boolean; controller?: object; gadgetId?: number } = {}): void {
    impl.storage.boundHooks.put({
      id: 5,
      actionId: 999,
      gatekeeperId: 1,
      ...(opts.gadgetId !== undefined ? { gadgetId: opts.gadgetId } : {}),
      vendorId: "testvendor",
      controller: (opts.controller ?? {}) as any,
      callback: {} as any,
      description: { title: "Hook", description: "Delivers events" },
      enabled: opts.enabled ?? false,
    });
  }

  // A gadget still provisional to `chatId`: proposed in that chat, invisible to "use"
  // collaborators until a merge promotes it.
  function seedPendingGadget(impl: any, id: number, chatId: number): void {
    impl.storage.gadgets.put({
      type: "gadget", id, title: "G", created: new Date(0), bindingName: "G", bindings: {},
      pending: { chatId },
    });
  }

  it("enabling a hook on an unbound connection restarts a connected use collaborator",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedHook(impl);

    impl.enableHookRecord(impl.storage.boundHooks.get(5));

    expect(impl.storage.boundHooks.get(5).enabled).toBe(true);
    expect(restarts).toHaveLength(1);
    // And, like any other widening, the connection is blocked until the reset lands.
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
  }));

  it("enabling a hook on an already-bound connection widens nothing",
      () => withImpl(async (impl, restarts) => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    impl.bindWorkpiece(100, "DB", 1);  // nobody connected yet: no restart, no mark
    joinSession(impl, "use");
    seedHook(impl);

    // The binding already put the connection in "use" scope, so the live session was verified
    // against it and the hook adds nothing new.
    impl.enableHookRecord(impl.storage.boundHooks.get(5));

    expect(restarts).toEqual([]);
    expect(() => impl.assertGatekeeperUsable(1)).not.toThrow();
  }));

  it("enabling a hook on a still-provisional gadget widens nothing",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedPendingGadget(impl, 100, 7);
    seedHook(impl, { gadgetId: 100 });

    // The gadget this hook wakes is still a proposal within a chat: "use" collaborators can't
    // open it (getGadget refuses pending gadgets), so the hook's connection isn't reachable
    // from their sessions and enabling it must not sever them or quarantine the connection.
    impl.enableHookRecord(impl.storage.boundHooks.get(5));

    expect(impl.storage.boundHooks.get(5).enabled).toBe(true);
    expect(restarts).toEqual([]);
    expect(() => impl.assertGatekeeperUsable(1)).not.toThrow();
  }));

  it("promoting the hook's gadget at merge is the widening",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedPendingGadget(impl, 100, 1);
    seedHook(impl, { gadgetId: 100 });
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });

    impl.enableHookRecord(impl.storage.boundHooks.get(5));
    expect(restarts).toEqual([]);
    // The creation lands on a "changes" message, stamping the pending record for merge coverage.
    await impl.commitAgentStep(1, AGENT, [{ type: "message", message: "created a gadget" }], {
      changes: [],
      createdGadgets: [{ gadgetId: 100, title: "G", bindingName: "G" }],
      addedBindings: [],
      createdWorktrees: [],
      worktreeCommits: [],
    });
    expect(restarts).toEqual([]);

    expect(await impl.mergeChanges(1, USER_META, "owner-user-do"))
        .toEqual({ outcome: "merged" });

    // Accepting the creation is the moment the hook's write channel becomes state the "use"
    // collaborator can open, so the merge's scope diff reports the widening: restart plus
    // quarantine, exactly like promoting a pending binding edge.
    expect(impl.storage.gadgets.get(100).pending).toBeUndefined();
    expect(restarts).toHaveLength(1);
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
  }));

  it("hook delivery is refused while the connection is blocked pending the restart",
      () => withImpl(async (impl, restarts, instance) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedHook(impl);

    // The enable is itself the widening that schedules the restart and marks the connection.
    impl.enableHookRecord(impl.storage.boundHooks.get(5));
    expect(restarts).toHaveLength(1);

    // The severed sessions stay live for the reset's delay, and the gatekeeper can fire the
    // just-armed hook immediately -- the inbound delivery route must refuse like every
    // client-reachable one, or the hook writes into a gadget those sessions still read.
    await expect(instance.startHook(5)).rejects.toThrow(/restarting/);
  }));

  it("a connection removed while its hook enable was in flight is not resurrected",
      () => withImpl(async (impl) => {
    seedGatekeeper(impl, 1);
    let disabled = 0;
    let releaseEnable!: () => void;
    let record = {
      id: 5, actionId: 999, gatekeeperId: 1, vendorId: "testvendor",
      controller: {
        enable: () => new Promise<void>(resolve => { releaseEnable = resolve; }),
        disable: async () => { disabled++; },
      },
      callback: {},
      description: { title: "Hook", description: "Delivers events" },
      enabled: false,
    };
    let hooks = new Map<number, object>([[5, record]]);
    impl.storage.boundHooks = {
      get: (id: number) => hooks.get(id),
      put: (r: { id: number }) => hooks.set(r.id, r),
      delete: (id: number) => hooks.delete(id),
      list: () => [...hooks.values()],
    };
    // A client interface over the real impl's hook flip, so enableHook's post-await call is the
    // real revalidation.
    let client = await openFakeOverseer(
        { boundHooks: impl.storage.boundHooks, actions: { get: () => undefined, put: () => {} } },
        {
          exports: { GatekeeperHookLoopback: ({ props }: { props: object }) => props },
          impl: { enableHookRecord: (r: object) => impl.enableHookRecord(r) },
        });

    let pending = client.enableHook(5);
    await new Promise(resolve => setTimeout(resolve, 0));
    // The gatekeeper-side enable is parked with the input gate open; the connection is removed
    // in that window. The teardown's snapshot sees enabled=false, so it sends no disable of its
    // own -- only the post-await revalidation stands between the captured record and a
    // resurrected enabled hook on a connection nobody can see (or ever be verified against).
    impl.removeGatekeeper(1);
    expect(impl.storage.boundHooks.get(5)).toBeUndefined();
    releaseEnable();

    await expect(pending).rejects.toThrow(/removed while/);
    expect(hooks.size).toBe(0);
    // The compensating gatekeeper-side disable is fired best-effort.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(disabled).toBe(1);
  }));

  it("a hook deleted while its disable was in flight is not resurrected as a zombie", async () => {
    let releaseDisable!: () => void;
    let record = {
      id: 5, actionId: 999, gatekeeperId: 1, vendorId: "testvendor",
      controller: { disable: () => new Promise<void>(resolve => { releaseDisable = resolve; }) },
      callback: {},
      description: { title: "Hook", description: "Delivers events" },
      enabled: true,
    };
    let hooks = new Map<number, object>([[5, record]]);
    let client = await openFakeOverseer({
      boundHooks: {
        get: (id: number) => hooks.get(id),
        put: (r: { id: number }) => hooks.set(r.id, r),
        delete: (id: number) => hooks.delete(id),
        list: () => [...hooks.values()],
      },
      actions: { get: () => undefined, put: () => {} },
    });

    let pending = client.disableHook(5);
    await new Promise(resolve => setTimeout(resolve, 0));
    // deleteHook/removeGatekeeper land while the gatekeeper-side disable is parked: deleting the
    // record is the authoritative kill, and the captured record must not undo it.
    hooks.delete(5);
    releaseDisable();
    await pending;

    expect(hooks.size).toBe(0);
  });

  it("removing a connection synchronously deletes its hooks",
      () => withImpl(async (impl, restarts, instance) => {
    seedGatekeeper(impl, 1);
    // A live controller stub can't be persisted through the test's real storage (functions don't
    // structured-clone), so this test fakes the collection.
    let disabled = 0;
    let record = {
      id: 5, actionId: 999, gatekeeperId: 1, vendorId: "testvendor",
      controller: { disable: async () => { disabled++; } },
      callback: {},
      description: { title: "Hook", description: "Delivers events" },
      enabled: true,
    };
    let hooks = new Map([[5, record]]);
    impl.storage.boundHooks = {
      get: (id: number) => hooks.get(id),
      put: (r: any) => hooks.set(r.id, r),
      delete: (id: number) => hooks.delete(id),
      list: () => hooks.values(),
    };

    impl.removeGatekeeper(1);

    // The record delete is the authoritative kill: delivery refuses even before (or without) the
    // gatekeeper-side disable landing, which is fired best-effort rather than awaited.
    expect(impl.storage.boundHooks.get(5)).toBeUndefined();
    await expect(instance.startHook(5)).rejects.toThrow(/deleted or disabled/);
    expect(disabled).toBe(1);
  }));
});

// An agent spawner's env is a reachability edge: once a gadget binds the spawner, any "use"
// collaborator can spawn an agent seeded with the env's connections (connectToGadget ->
// spawn/spawnCallable), so those connections join their verification scope transitively -- and
// binding the spawner is the widening moment, exactly like binding the connection itself.
describe("agent spawner envs widen use scope", () => {
  function seedSpawner(impl: any, id: number, env: Record<string, number>): void {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Spawner ${id}`,
      class: {} as any,
      creationSpec: {
        type: "agentSpawner",
        config: { displayName: "S", modelId: null, env },
      },
    });
  }

  it("binding a spawner restarts a connected use collaborator and quarantines its env targets",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedSpawner(impl, 2, { DB: 1 });
    seedGadget(impl, 100);

    impl.bindWorkpiece(100, "SPAWN", 2);

    expect(restarts).toHaveLength(1);
    // The env target is what the widening exposed, so it is blocked until the reset lands; the
    // spawner itself is vendorless -- nobody is ever verified against it -- and stays usable.
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
    expect(() => impl.assertGatekeeperUsable(2)).not.toThrow();
  }));

  it("spawner-to-spawner env edges widen transitively",
      () => withImpl(async (impl, restarts) => {
    joinSession(impl, "use");
    seedGatekeeper(impl, 1);
    seedSpawner(impl, 2, { DB: 1 });
    seedSpawner(impl, 3, { INNER: 2 });
    seedGadget(impl, 100);

    // Binding the outer spawner reaches the connection through the inner one: the spawned agent's
    // env includes the inner spawner, whose own spawns seed from *its* env.
    impl.bindWorkpiece(100, "SPAWN", 3);

    expect(restarts).toHaveLength(1);
    expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
  }));

  it("binding a spawner whose env targets are already in scope widens nothing",
      () => withImpl(async (impl, restarts) => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    impl.bindWorkpiece(100, "DB", 1);  // nobody connected yet: no restart, no mark
    joinSession(impl, "use");
    seedSpawner(impl, 2, { DB: 1 });

    // The direct binding already put the connection in scope, so the live session was verified
    // against it and the spawner's env adds nothing new.
    impl.bindWorkpiece(100, "SPAWN", 2);

    expect(restarts).toEqual([]);
    expect(() => impl.assertGatekeeperUsable(1)).not.toThrow();
  }));
});

// Subscriptions are exports minted into a collaborator's session: a client can dispose the
// interface while retaining one, and it keeps delivering workspace data -- so each counts toward
// #hasCollaboratorSession for its own lifetime, like every other retained capability.
describe("subscriptions count as sessions", () => {
  it("a retained subscription from a build session holds the gate open",
      () => withImpl(async (impl, restarts) => {
    stubFacets(impl);
    // A collaborator's (non-owner) build session whose session counting is the real impl's.
    let client = await openFakeOverseer({}, { impl: {
      ownerId: "real-owner-id",
      joinSession: (kind: string) => impl.joinSession(kind),
      subscribeToConsoleLogs: async () => new NativeRpcStub<{}>({ [Symbol.dispose]() {} } as any),
    } });
    let sub = await client.subscribeToConsoleLogs(
        new NativeRpcStub({ event: async () => {} } as any) as any);

    // Disposing the interface leaves the subscription live, still delivering workspace data.
    (client as any)[Symbol.dispose]();
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);

    // Only once it too is gone does a widening find nothing to sever. (Stub disposal reaches the
    // wrapped target's disposer asynchronously, so let it settle.)
    (sub as any)[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    expect(restarts).toHaveLength(1);
  }));

  it("a retained subscription from a use session holds the gate open",
      () => withImpl(async (impl, restarts) => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    let client = await openFakeOverseer({}, { role: "use", impl: {
      joinSession: (kind: string) => impl.joinSession(kind),
      subscribeToWorkpieces: () => new NativeRpcStub<{}>({ [Symbol.dispose]() {} } as any),
    } });
    let sub = await client.subscribeToWorkpieces(
        new NativeRpcStub({ init: async () => {} } as any) as any);

    (client as any)[Symbol.dispose]();
    impl.bindWorkpiece(100, "DB", 1);
    expect(restarts).toHaveLength(1);

    // (Stub disposal reaches the wrapped target's disposer asynchronously, so let it settle.)
    (sub as any)[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    seedGatekeeper(impl, 2);
    impl.bindWorkpiece(100, "DB2", 2);
    expect(restarts).toHaveLength(1);
  }));

  it("disposing a chat subscription that already tore down is a no-op", async () => {
    let unsubs: string[] = [];
    let client = await openFakeOverseer({
      chats: { subscribe() {}, unsubscribe: () => unsubs.push("chats") },
      chatMeta: { subscribe() {}, unsubscribe: () => unsubs.push("chatMeta") },
      chatChanges: { list: () => [] },
    }, { impl: {
      addChatSubscriber() {},
      removeChatSubscriber: () => unsubs.push("removeChatSubscriber"),
      streamGeneration: 1,
      logger: { debug() {} },
    } });

    // The failed generation delivery tears the subscription down before the client disposes it.
    // (onRpcBroken must exist on the mock: a native stub over a plain object forwards it.)
    using subscriber = new NativeRpcStub({
      onRpcBroken: () => {},
      streamGeneration: async () => { throw new Error("client gone"); },
    } as any);
    let sub = await client.subscribeToChat(subscriber as any);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(unsubs).toEqual(["chats", "chatMeta", "removeChatSubscriber"]);

    // The later dispose must not tear down (or dispose the subscriber) a second time. (Stub
    // disposal reaches the wrapped target's disposer asynchronously, so let it settle.)
    (sub as any)[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(unsubs).toEqual(["chats", "chatMeta", "removeChatSubscriber"]);
  });
});

// The raw gadget facet stub returned by connectToGadget() is a capability like any other export:
// a client can dispose every counted wrapper while retaining it, and it is the very stub a
// hook-enable widening's data flows through (the hook writes into the gadget it reads) -- so it
// counts toward #hasCollaboratorSession for its own lifetime.
describe("gadget facet stubs count as sessions", () => {
  it("a retained connectToGadget facet from a use session holds the gate open",
      () => withImpl(async (impl, restarts) => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    impl.getGadgetFacetFetcher = () => ({});
    // A real "use" client whose session counting and facet minting are the real impl's.
    let client = await openFakeOverseer({ gadgets: impl.storage.gadgets }, { role: "use", impl: {
      joinSession: (kind: string) => impl.joinSession(kind),
      getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
      getGadgetFacet: (id: number, chatId?: number, joinAs?: string) =>
          impl.getGadgetFacet(id, chatId, joinAs),
      recordGadgetAnalytics: () => {},
      users: { idFromString: (id: string) => id,
               get: () => ({
                 id: { toString: () => "viewer-user-do" },
                 whoami: async () => ({ type: "user", id: "viewer", name: "Viewer" }),
                 recordSharedGadgetOpen: async () => {},
               }) },
    } });
    let child = await client.getGadget(100);
    let facet = await (child as any).connectToGadget();

    // With every wrapper disposed, the retained facet must keep counting on its own, or a
    // widening would find no session to sever while the stub kept reading gadget state.
    (client as any)[Symbol.dispose]();
    (child as any)[Symbol.dispose]();
    impl.bindWorkpiece(100, "DB", 1);
    expect(restarts).toHaveLength(1);

    // Only once the facet too is gone does a widening find nothing to sever. (Stub disposal
    // reaches the wrapped target's disposer asynchronously, so let it settle.)
    (facet as any)[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    seedGatekeeper(impl, 2);
    impl.bindWorkpiece(100, "DB2", 2);
    expect(restarts).toHaveLength(1);
  }));
});

// Revoking access must sever the revoked collaborator's live sessions promptly: the restart is
// scheduled in the same synchronous step as the sharing mutation, never behind the best-effort
// cross-DO cleanup, which can stall or hang.
describe("revocation restart ordering", () => {
  it("removeCollaborator schedules the restart before the observer teardown", async () => {
    let restarts: string[] = [];
    let restartRecorded = Promise.withResolvers<void>();
    let client = await openFakeOverseer({}, { impl: {
      getSharingManager: async () => ({
        removeCollaborator: () =>
            [{ profile: { type: "user", id: "carol", name: "Carol" }, newRole: null }],
      }),
      // A hung gatekeeper/User-DO round trip: the cleanup never settles.
      tearDownLostObservers: () => new Promise(() => {}),
      refreshAffectedCollaboratorListings: async () => {},
      scheduleAccessRestart: (reason: string) => {
        restarts.push(reason);
        restartRecorded.resolve();
        return Promise.resolve();
      },
    } });

    let pending = client.removeCollaborator("carol", []);
    pending.catch(() => {});  // never settles; the restart is what revokes

    await restartRecorded.promise;
    expect(restarts).toHaveLength(1);
  });
});

// Every client-reachable route to a connection blocked pending a scope-widening restart is gated:
// the direct routes throw (getGatekeeperById/openSession, covered above; the slash-command invoke
// here), and the enumerating routes silently omit it until the reset lands.
describe("connections blocked pending restart", () => {
  // rpcPromise-style provider stub, as collectSlashCommands sees over RPC.
  function slashProvider(commandId: string) {
    return {
      getSlashCommandProvider: () => Object.assign(Promise.resolve({
        list: async () => [{ id: commandId, name: commandId, description: "d" }],
        [Symbol.dispose]() {},
      }), { [Symbol.dispose]() {} }),
    };
  }

  it("a blocked connection's slash-command invoke is refused",
      () => withImpl(async (impl) => {
    joinSession(impl);
    impl.getGatekeeperFacet = () => ({
      describe: async () =>
          ({ title: "Test", url: "https://example.com/new", hasSlashCommands: true }),
    });
    let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    let id = await added.getId();
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });

    // The id is client-supplied: without the gate this would read the connection and mint an
    // observation on behalf of a session the reset is about to sever.
    await expect(impl.sendChatMessage(
        { id: { toString: () => "user-do" } } as any, USER_META as any, 1,
        { id: { gatekeeperId: id, commandId: "deploy" }, args: "" } as any))
        .rejects.toThrow(/restarting/);
  }));

  it("a blocked connection's slash commands are omitted from the listing",
      () => withImpl(async (impl) => {
    joinSession(impl);
    impl.env = { BLUEPRINTS: { get: async () => null } };
    impl.storage.gatekeepers.put({
      id: 1, resourceTitle: "Usable", class: {} as any, hasSlashCommands: true,
      creationSpec: {
        type: "gatekeeper", vendorId: "testvendor",
        resourceUrl: "https://example.com/1", typeUrlPattern: "https://*",
      },
    });
    impl.getGatekeeperFacet = (id: number) => ({
      describe: async () =>
          ({ title: "Test", url: "https://example.com/new", hasSlashCommands: true }),
      ...slashProvider(id === 1 ? "usable" : "blocked"),
    });
    let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC);
    await added.getId();

    let names = (await impl.listSlashCommands()).map((choice: any) => choice.name);
    expect(names).toContain("usable");
    expect(names).not.toContain("blocked");
  }));

  it("a blocked connection is skipped by the ambient catalog load",
      () => withImpl(async (impl) => {
    joinSession(impl);
    let catalogLoads: number[] = [];
    impl.getGatekeeperFacet = (id: number) => ({
      describe: async () =>
          ({ title: `T${id}`, url: "https://example.com", suggestedBindingName: "RES" }),
      getAgentCatalog: async () => { catalogLoads.push(id); return { entries: [] }; },
    });
    impl.storage.gatekeepers.put({
      id: 1, resourceTitle: "Usable", class: {} as any,
      creationSpec: { type: "ambient", vendorId: "v1" },
    });
    let added = await impl.addGatekeeper({} as any, { type: "ambient", vendorId: "v2" });
    let blockedId = await added.getId();
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });

    let seeds = await impl.prepareChatBindings(1, []);

    // The blocked connection is left out entirely, like the other enumerating routes: its
    // catalog is neither queried nor cached, and even its seed entry's metadata belongs to a
    // scope nobody live was verified against. It reappears once the reset lands and clients
    // reconnect; the next turn then loads its catalog as a missing id.
    expect(catalogLoads).toEqual([1]);
    expect(seeds.some((seed: any) => seed.target === blockedId)).toBe(false);
    expect(impl.storage.chatContext.get(1).alwaysAvailableCatalogs
        .map((entry: any) => entry.gatekeeperId)).toEqual([1]);
  }));
});
