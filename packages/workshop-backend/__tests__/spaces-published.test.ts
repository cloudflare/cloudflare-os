// A workspace published to the deployment: anyone signed in opens it in the role its owner chose,
// its owner's record and its entry in its space's listing say so, and someone who is not a member
// of that space sees the space's published entries and nothing else of it. Everything runs
// against real Durable Objects: the workspace's Overseer, its owner's User DO and the space. What
// SharingManager makes of the published role is in sharing.test.ts.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, CollaboratorRole, GadgetMetadata, Overseer, Space,
} from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
import { makeSpaceStorage } from "../src/storage-schema/space-storage.js";
import {
  makeUserStorage, type GadgetRecord, type WorkspaceRestrictions,
} from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// A user: their id as a workspace's Overseer holds it, and the key of their personal space.
type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; userId: string;
  personal: string;
};

const NEITHER: WorkspaceRestrictions = { containsRestrictedData: false, ownerInvitesOnly: false };
// What an Overseer states of a workspace published at `publicAccess` after `revision` changes.
const statement = (publicAccess: CollaboratorRole | undefined, revision: number) =>
    ({ ...NEITHER, publicAccess, publicAccessRevision: revision });
const DENIED = "You don't have access to this workspace.";
const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const NO_SHARING = "You do not have permission to share this workspace.";
const OWNER_ONLY = "Only the workspace owner can publish it.";
const UNPUBLISHABLE = /cannot be published/;
const WITHDRAWN = "Gadget restarted because it is no longer published as it was.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const DAY = new Date("2026-01-01");
const unique = () => crypto.randomUUID().slice(0, 8);
const space = (key: string) => env.TEST_SPACE.getByName(key);

async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, userId: user.id.toString(), personal: `~${id}` };
}

// A team space under a fresh key, created by `admin`, with `members` in the "use" role.
async function teamSpace(admin: Account, ...members: Account[]): Promise<string> {
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  for (let { profile } of members) {
    await space(key).setMemberRole(admin.profile.id, profile.id, "use");
  }
  return key;
}

// The owner's stored record of a workspace, and its entry in a space's listing as a member sees it.
const stored = (owner: Account, id: string): Promise<GadgetRecord | undefined> =>
    runInDurableObject(owner.user, (_instance, state) =>
        makeUserStorage(state.storage).gadgets.get(id));
const entry = async (key: string, viewer: Account, id: string) =>
    (await space(key).listWorkspaces(viewer.profile.id)).find(listed => listed.id === id);

// A real workspace of `owner`'s in team space `spaceKey`, or with none in their personal space,
// which lists it unless it is left `provisional`. `run` acts inside its Overseer, on its
// OverseerImpl, with the owner planted rather than established by a first open; the restarts it
// schedules are recorded in `restarts` instead of taking the object from under the test.
async function workspace(
    owner: Account, spaceKey?: string, title = "Untitled", provisional = false) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = stub.id.toString();
  await owner.user.newGadget(id, title, spaceKey);
  if (!provisional) {
    await owner.user.setGadgetLastActive(id, DAY, undefined, NEITHER);
    // Deleting a workspace the owner has no record of waits out the sync that lists this one.
    await owner.user.deleteGadget("ws-none", NEITHER);
  }
  let restarts: string[] = [];
  let run = (act: (impl: any, instance: OverseerDurableObject) => unknown) =>
      runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as { impl: any }).impl;
        impl.storage.ownerId.put(owner.userId);
        impl.ownerId = owner.userId;
        impl.ensureAmbientCapsules = async () => {};
        impl.markOutputsDirty = () => {};
        impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
        await act(impl, instance);
      });
  await run(() => {});
  return { id, run, restarts };
}

// Alice's workspace in a team space of hers where Carol is a "use" member, and Mallory, who is
// in no space of Alice's and whom the workspace's sharing gives nothing.
async function published() {
  let [alice, carol, mallory] = await Promise.all(["alice", "carol", "mallory"].map(signUp));
  let key = await teamSpace(alice, carol);
  return { alice, carol, mallory, key, ws: await workspace(alice, key) };
}

const open = (instance: OverseerDurableObject, as: Account): Promise<Overseer> =>
    instance.open(as.userId, as.profile.id, new NativeRpcStub<() => void>(() => {}));
// What opening the workspace as `as` comes to: the role of their session, or the refusal.
const opening = (instance: OverseerDurableObject, as: Account) => open(instance, as)
    .then(async session => (await session.getMetadata()).role, (error: Error) => error.message);
// The owner publishes the workspace at `role`, or with null withdraws that.
const publish = async (
    instance: OverseerDurableObject, owner: Account, role: CollaboratorRole | null) =>
    (await open(instance, owner)).setPublicAccess(role);

// The owner adds `to` to the workspace's own sharing, in `role`.
function share(impl: any, owner: Account, to: Account, role: CollaboratorRole): void {
  impl.storage.collaborators.put({
    profile: to.profile,
    addedBy: [{ type: "user", sharer: owner.profile.id, created: DAY, role }],
  });
}

// An observation that states `flag` of the workspace, under which it is not published.
const flagging = (impl: any, flag: string): Promise<void> => impl.authorizeObservation(
    1, { title: "Read", description: "The test read a thing.", [flag]: true }, { from: "user" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a published workspace's Overseer", () => {
  it("opens for anyone signed in, in the role it is published with, and for no stranger otherwise",
      async () => {
    let { alice, mallory, ws } = await published();
    await ws.run(async (impl, instance) => {
      expect(await opening(instance, mallory)).toBe(DENIED);
      await publish(instance, alice, "use");
      let viewer = await open(instance, mallory);
      // A session that may only use the workspace is not told whether it is published.
      expect(await viewer.getMetadata()).not.toHaveProperty("publicAccess");
      expect((await viewer.getMetadata()).role).toBe("use");
      await expect(viewer.listCollaborators()).rejects.toThrow("Unauthorized");

      await publish(instance, alice, "build");
      expect(await (await open(instance, mallory)).getMetadata())
          .toMatchObject({ role: "build", publicAccess: "build", owner: alice.profile });
      await publish(instance, alice, null);
      expect(impl.storage.publicAccess.get()).toBeUndefined();
      expect(await opening(instance, mallory)).toBe(DENIED);
    });
  });

  it("tells the owner's metadata, and its subscription, the role it is published with",
      async () => {
    let { alice, ws } = await published();
    await ws.run(async (_impl, instance) => {
      let owner = await open(instance, alice);
      let seen: (CollaboratorRole | undefined)[] = [];
      using callback = new NativeRpcStub(
          (metadata: GadgetMetadata) => { seen.push(metadata.publicAccess); });
      using _subscription = await owner.subscribeToMetadata(callback as any);
      await owner.setPublicAccess("use");
      await owner.setPublicAccess("build");
      await owner.setPublicAccess(null);
      expect((await owner.getMetadata()).publicAccess).toBeUndefined();
      await vi.waitFor(() => expect(seen).toEqual([undefined, "use", "build", undefined]), WAIT);
    });
  });

  it("raises a lower role to the published one and never lowers a higher one", async () => {
    let { alice, carol, mallory, ws } = await published();
    await ws.run(async (impl, instance) => {
      share(impl, alice, mallory, "build");
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("build");
      expect(await opening(instance, carol)).toBe("use");
      await publish(instance, alice, "build");
      // Carol uses as a member of the space, and builds because the workspace is published.
      expect(await opening(instance, carol)).toBe("build");
    });
  });

  it("is published and withdrawn by its owner alone", async () => {
    let { alice, carol, mallory, ws } = await published();
    await ws.run(async (impl, instance) => {
      share(impl, alice, mallory, "build");
      let builder = await open(instance, mallory);
      await expect(builder.setPublicAccess("use")).rejects.toThrow(OWNER_ONLY);
      await publish(instance, alice, "use");
      await expect(builder.setPublicAccess(null)).rejects.toThrow(OWNER_ONLY);
      let viewer = await open(instance, carol);
      await expect(viewer.setPublicAccess("build")).rejects.toThrow("Unauthorized");
      expect(impl.storage.publicAccess.get()).toBe("use");
    });
  });

  it("is not published, and cannot be, under either flag", async () => {
    let { alice, mallory, key } = await published();
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice, key);
      await ws.run(async (impl, instance) => {
        // A published role that a flag was set beside, by no route the code has, gives nothing.
        impl.storage.publicAccess.put("build");
        impl.storage[flag].put(true);
        expect(await opening(instance, mallory)).toBe(DENIED);
        expect((await (await open(instance, alice)).getMetadata()).publicAccess).toBeUndefined();
        for (let role of ["use", "build", null] as const) {
          await expect(publish(instance, alice, role)).rejects.toThrow(UNPUBLISHABLE);
        }
        expect(impl.storage.publicAccess.get()).toBe("build");
      });
    }
  });

  it("restarts when withdrawn or lowered if anyone opened through the publication, and never "
      + "when raised", async () => {
    let { alice, mallory, ws } = await published();
    await ws.run(async (_impl, instance) => {
      await publish(instance, alice, "use");
      let session = await open(instance, mallory);
      // Mallory closes her session, and may have kept anything it handed out to her.
      (session as unknown as Disposable)[Symbol.dispose]();
      await publish(instance, alice, "build");
      await publish(instance, alice, "build");
      expect(ws.restarts).toEqual([]);
      await publish(instance, alice, "use");
      expect(ws.restarts).toEqual([WITHDRAWN]);
      await publish(instance, alice, null);
      expect(ws.restarts).toEqual([WITHDRAWN, WITHDRAWN]);
    });
  });

  it("restarts for nobody whom its sharing or its space gives the published role anyway",
      async () => {
    let { alice, carol, mallory, key } = await published();
    let asked = vi.spyOn(UserDurableObject.prototype, "workspaceRoleInSpace");
    // Nobody opened it; a collaborator and a member of its space opened it in roles that are
    // theirs without the publication: withdrawing it ends no session.
    let ws = await workspace(alice, key);
    await ws.run(async (impl, instance) => {
      await publish(instance, alice, "use");
      await publish(instance, alice, null);
      share(impl, alice, mallory, "use");
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("use");
      expect(await opening(instance, carol)).toBe("use");
      expect(asked).toHaveBeenCalledTimes(2);
      await publish(instance, alice, null);
      expect(ws.restarts).toEqual([]);

      // Removed while it is published, a collaborator keeps the session they have, which the
      // publication entitles them to from then on: taking it back is what ends that session.
      let owner = await open(instance, alice);
      await owner.setPublicAccess("use");
      expect(await owner.removeCollaborator(mallory.profile.id, [])).toEqual([]);
      expect(ws.restarts).toEqual([]);
      await owner.setPublicAccess(null);
      expect(ws.restarts).toEqual([WITHDRAWN]);
    });

    // Published to build, the space is not asked what it gives Carol, so she counts as having
    // opened through the publication.
    asked.mockClear();
    let built = await workspace(alice, key);
    await built.run(async (_impl, instance) => {
      await publish(instance, alice, "build");
      expect(await opening(instance, carol)).toBe("build");
      expect(asked).not.toHaveBeenCalled();
      await publish(instance, alice, null);
      expect(built.restarts).toEqual([WITHDRAWN]);
      expect(await opening(instance, carol)).toBe("use");
    });
  });

  it("restarts once its owner's User DO has the change, so that their call returns, and no later "
      + "than a bound if that takes too long", async () => {
    let { alice, mallory, ws } = await published();
    let events: string[] = [];
    let mirror = UserDurableObject.prototype.setGadgetPublicAccess;
    let delay = 0;
    vi.spyOn(UserDurableObject.prototype, "setGadgetPublicAccess").mockImplementation(
        async function (this: UserDurableObject, id, restrictions) {
          await scheduler.wait(delay);
          await mirror.call(this, id, restrictions);
          events.push("mirrored");
        });
    await ws.run(async (impl, instance) => {
      impl.scheduleAccessRestart = async () => { events.push("restart"); };
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("use");
      // Slower than the restart's own delay, which the owner's call would not have outlived.
      delay = 300;
      await publish(instance, alice, null);
      await vi.waitFor(() => expect(events).toEqual(["mirrored", "mirrored", "restart"]), WAIT);
      // Slower than the restart waits for it: the sessions it ends do not wait any longer.
      await publish(instance, alice, "use");
      delay = 2_500;
      events.length = 0;
      await publish(instance, alice, null);
      expect(events).toEqual(["restart", "mirrored"]);
    });
  }, 15_000);

  it("stops being published when an observation first sets a flag, once the flag is stored",
      async () => {
    let { alice, mallory, key } = await published();
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice, key);
      await ws.run(async (impl, instance) => {
        await publish(instance, alice, "use");
        expect(await opening(instance, mallory)).toBe("use");
        // What the owner's subscription to the metadata is told: never the flag beside the role.
        let seen: unknown[] = [];
        using callback = new NativeRpcStub((metadata: GadgetMetadata) => {
          seen.push([metadata.containsRestrictedData || metadata.ownerInvitesOnly,
                     metadata.publicAccess]);
        });
        using _subscription =
            await (await open(instance, alice)).subscribeToMetadata(callback as any);
        let atRestart: unknown[] = [];
        impl.scheduleAccessRestart = async (reason: string) => {
          atRestart.push([reason, impl.storage[flag].get(), impl.storage.publicAccess.get()]);
        };
        await flagging(impl, flag);
        expect(atRestart).toEqual([[WITHDRAWN, true, undefined]]);
        expect(await opening(instance, mallory)).toBe(DENIED);
        await vi.waitFor(() => expect(seen.at(-1)).toEqual([true, undefined]), WAIT);
        expect(seen).not.toContainEqual([true, "use"]);
      });
      // The report that states the flag takes the publication off the owner's record too.
      await vi.waitFor(async () => expect(await stored(alice, ws.id))
          .toEqual(expect.not.objectContaining({ publicAccess: "use" })), WAIT);
      await vi.waitFor(async () => expect(await entry(key, alice, ws.id)).toBeUndefined(), WAIT);
    }
    // One that nobody opened through its publication loses it and keeps its sessions.
    let quiet = await workspace(alice, key);
    await quiet.run(async (impl, instance) => {
      await publish(instance, alice, "build");
      await flagging(impl, "containsRestrictedData");
      expect(impl.storage.publicAccess.get()).toBeUndefined();
      expect(quiet.restarts).toEqual([]);
    });
  });

  it("makes nobody a collaborator: no power to share, and no record of it as shared with them",
      async () => {
    let { alice, carol, mallory, ws } = await published();
    await ws.run(async (impl, instance) => {
      await publish(instance, alice, "build");
      let visitor = await open(instance, mallory);
      await expect(visitor.addCollaborator(carol.profile.id, "use")).rejects.toThrow(NO_SHARING);
      await expect(visitor.createShareLink("use")).rejects.toThrow(NO_SHARING);
      expect(await visitor.listCollaborators()).toEqual([]);
      // A collaborator who builds because it is published is recorded in the role sharing gives.
      share(impl, alice, carol, "use");
      expect(await opening(instance, carol)).toBe("build");
    });
    await vi.waitFor(async () => expect(await carol.user.getGadget(ws.id))
        .toMatchObject({ owner: alice.profile, role: "use" }), WAIT);
    expect(await mallory.user.getGadget(ws.id)).toBeNull();
  });

  it("takes the record of it as shared with someone to the role sharing gives them, when a "
      + "removal while it is published changes what sharing gives and nothing else", async () => {
    let { alice, mallory, ws } = await published();
    let [bob, dave] = await Promise.all(["bob", "dave"].map(signUp));
    let record = (of: Account) => of.user.getGadget(ws.id);
    await ws.run(async (impl, instance) => {
      share(impl, alice, mallory, "build");
      share(impl, alice, bob, "build");
      // Dave builds because Bob added him, and the owner's own grant to him is to use.
      impl.storage.collaborators.put({ profile: dave.profile, addedBy: [
        { type: "user", sharer: alice.profile.id, created: DAY, role: "use" },
        { type: "user", sharer: bob.profile.id, created: DAY, role: "build" },
      ] });
      for (let collaborator of [mallory, bob, dave]) {
        expect(await opening(instance, collaborator)).toBe("build");
      }
    });
    await vi.waitFor(async () => expect(await Promise.all([mallory, bob, dave].map(record)))
        .toMatchObject([{ role: "build" }, { role: "build" }, { role: "build" }]), WAIT);

    await ws.run(async (_impl, instance) => {
      let owner = await open(instance, alice);
      await owner.setPublicAccess("build");
      // Published at "build", neither removal changes what anyone can do.
      expect(await owner.removeCollaborator(mallory.profile.id, [])).toEqual([]);
      expect(await owner.removeCollaborator(bob.profile.id, [])).toEqual([]);
    });
    expect(await record(mallory)).toBeNull();
    expect(await record(bob)).toBeNull();
    expect(await record(dave)).toMatchObject({ owner: alice.profile, role: "use" });
  });

  it("counts an excluded observer who reaches an observation through the publication", async () => {
    let { alice, mallory, ws } = await published();
    let asked = vi.spyOn(UserDurableObject.prototype, "workspaceRoleInSpace");
    await ws.run(async (impl, instance) => {
      // Mallory is an observer of the workspace's one connection, which no gadget binds, so
      // whoever builds reaches what it reads and whoever only uses does not.
      let removals: string[] = [];
      impl.storage.gatekeepers.put({
        id: 1, resourceTitle: "Connection", class: {},
        creationSpec: {
          type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/1",
          typeUrlPattern: "https://*",
        },
      });
      impl.storage.observers.put(
          { profileId: mallory.profile.id, observerId: "obs", accountChoices: { 1: 10 } });
      impl.getGatekeeperFacet = (id: number) => ({
        removeObserver: async (removed: string) => { removals.push(`${id}:${removed}`); },
      });
      let observe = (): Promise<void> => impl.authorizeObservation(1, {
        title: "Observation", description: "One the gatekeeper keeps from its observers.",
        excludeObservers: ["obs"],
      }, { from: "agent", chatId: 1 });

      await publish(instance, alice, "build");
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      expect([asked.mock.calls.length, removals]).toEqual([0, []]);
      // Published to use she no longer reaches this connection, and stays an observer of the rest.
      await publish(instance, alice, "use");
      await observe();
      expect(removals).toEqual(["1:obs"]);
      expect(impl.storage.observers.get(mallory.profile.id)).toBeDefined();
      // Withdrawn, nothing gives her a role: she is no longer set up to observe at all.
      await publish(instance, alice, null);
      await observe();
      expect(impl.storage.observers.get(mallory.profile.id)).toBeUndefined();
    });
  });

  it("keeps counting an excluded observer whom a publication taken back admitted, until the "
      + "restart that ends their session", async () => {
    let { alice, mallory, ws } = await published();
    await ws.run(async (impl, instance) => {
      await publish(instance, alice, "build");
      expect(await opening(instance, mallory)).toBe("build");
      impl.storage.gatekeepers.put({
        id: 1, resourceTitle: "Connection", class: {},
        creationSpec: {
          type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/1",
          typeUrlPattern: "https://*",
        },
      });
      impl.storage.observers.put(
          { profileId: mallory.profile.id, observerId: "obs", accountChoices: { 1: 10 } });
      impl.getGatekeeperFacet = () => ({ removeObserver: async () => {} });
      let observe = (): Promise<void> => impl.authorizeObservation(1, {
        title: "Observation", description: "One the gatekeeper keeps from its observers.",
        excludeObservers: ["obs"],
      }, { from: "agent", chatId: 1 });

      // The restart is pending (the test only records it), and her session with it.
      await publish(instance, alice, null);
      expect(ws.restarts).toEqual([WITHDRAWN]);
      expect(await opening(instance, mallory)).toBe(DENIED);
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      expect(impl.storage.observers.get(mallory.profile.id)).toBeDefined();
    });
  });
});

describe("the mirror of a publication", () => {
  it("follows a publish, a change of role, a move and a withdrawal before the call returns",
      async () => {
    let { alice, key, ws } = await published();
    let mirrored = async (listedIn: string) => [
      (await alice.user.getGadget(ws.id))?.publicAccess,
      (await alice.user.listGadgets()).find(gadget => gadget.id === ws.id)?.publicAccess,
      (await stored(alice, ws.id))?.registered?.published,
      (await entry(listedIn, alice, ws.id))?.published,
    ];
    // Each is the owner's one call, and what the mirror says the moment it has returned.
    let asOwner = (act: (owner: Overseer) => Promise<void>) =>
        ws.run(async (_impl, instance) => act(await open(instance, alice)));
    await asOwner(owner => owner.setPublicAccess("use"));
    expect(await mirrored(key)).toEqual(["use", "use", "use", "use"]);
    await asOwner(owner => owner.setPublicAccess("build"));
    expect(await mirrored(key)).toEqual(["build", "build", "build", "build"]);
    await asOwner(owner => owner.moveToSpace(null));
    expect(await mirrored(alice.personal)).toEqual(["build", "build", "build", "build"]);
    await asOwner(owner => owner.setPublicAccess(null));
    expect(await mirrored(alice.personal)).toEqual([undefined, undefined, undefined, undefined]);
    expect(await entry(alice.personal, alice, ws.id)).not.toHaveProperty("published");
    expect(await stored(alice, ws.id)).not.toHaveProperty("publicAccess");
  });

  it("fails the call after the change when it is lost, and is made again by the next report",
      async () => {
    let { alice, mallory, key, ws } = await published();
    // First the owner's User DO cannot be reached, then the space cannot.
    let failures: [() => unknown, CollaboratorRole | null][] = [
      [() => vi.spyOn(UserDurableObject.prototype, "setGadgetPublicAccess")
          .mockRejectedValueOnce(new Error("user object unavailable")), "use"],
      [() => vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces")
          .mockRejectedValueOnce(new Error("space unavailable")), null],
    ];
    for (let [fail, role] of failures) {
      await ws.run(async (impl, instance) => {
        let owner = await open(instance, alice);
        fail();
        await expect(owner.setPublicAccess(role)).rejects.toThrow(/unavailable/);
        expect(impl.storage.publicAccess.get()).toBe(role ?? undefined);
        expect(await opening(instance, mallory)).toBe(role ?? DENIED);
      });
      expect((await entry(key, alice, ws.id))?.published).toBe(role ? undefined : "use");
      // Any later call that states the workspace's flags states this too: here a new title.
      await ws.run(async (_impl, instance) =>
          (await open(instance, alice)).setTitle(`Renamed ${role}`));
      await vi.waitFor(async () => expect([
        (await stored(alice, ws.id))?.publicAccess, (await entry(key, alice, ws.id))?.published,
      ]).toEqual([role ?? undefined, role ?? undefined]), WAIT);
    }
  });

  it("is not put back by a statement made before a later change, and is dropped under a flag",
      async () => {
    let { alice, key, ws } = await published();
    // Deleting a workspace the owner has no record of waits out the syncs asked for before it.
    let mirrored = async () => {
      await alice.user.deleteGadget("ws-none", NEITHER);
      return [(await stored(alice, ws.id))?.publicAccess,
              (await entry(key, alice, ws.id))?.published];
    };
    await alice.user.setGadgetPublicAccess(ws.id, statement("use", 1));
    await alice.user.setGadgetPublicAccess(ws.id, statement(undefined, 2));
    // An activity report sent while the workspace was published arrives after it was withdrawn.
    await alice.user.setGadgetLastActive(ws.id, DAY, undefined, statement("use", 1));
    expect(await mirrored()).toEqual([undefined, undefined]);
    // One sent after a later change, such as a change whose own statement was lost, says it.
    await alice.user.updateTitle(ws.id, "Renamed", statement("build", 3));
    expect(await mirrored()).toEqual(["build", "build"]);
    expect(await alice.user.getGadget(ws.id)).not.toHaveProperty("publicAccessRevision");

    // Once a flag is recorded no statement of the role counts, as recent as it may be.
    await alice.user.setGadgetLastActive(
        ws.id, DAY, undefined, { ...statement(undefined, 3), containsRestrictedData: true });
    await alice.user.setGadgetPublicAccess(ws.id, statement("build", 4));
    expect(await mirrored()).toEqual([undefined, undefined]);
  });

  it("marks no entry for a workspace that no space lists, which is published all the same",
      async () => {
    let [alice, mallory] = await Promise.all(["alice", "mallory"].map(signUp));
    let ws = await workspace(alice, undefined, "Untitled", true);
    await ws.run(async (_impl, instance) => {
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("use");
    });
    expect(await stored(alice, ws.id)).toMatchObject({ publicAccess: "use" });
    expect(await stored(alice, ws.id)).not.toHaveProperty("registered");
    expect(await space(alice.personal).open(mallory.profile.id)).toBeNull();
    // Its entry is marked when a space comes to list it: here at its first activity.
    await alice.user.setGadgetLastActive(
        ws.id, DAY, undefined, { ...NEITHER, publicAccess: "use" });
    await vi.waitFor(async () =>
        expect((await entry(alice.personal, alice, ws.id))?.published).toBe("use"), WAIT);
  });
});

// Alice's team space, where Bob is a member, listing two workspaces of hers, of which the
// owner's User DO states `roadmap` to be published as its Overseer would, and Mallory, who is
// in no space of Alice's.
async function visited() {
  let [alice, bob, mallory] = await Promise.all(["alice", "bob", "mallory"].map(signUp));
  let key = await teamSpace(alice, bob);
  let { id: roadmap } = await workspace(alice, key, "Roadmap");
  let { id: notes } = await workspace(alice, key, "Notes");
  let state = (id: string, publicAccess?: CollaboratorRole) =>
      alice.user.setGadgetPublicAccess(id, { ...NEITHER, publicAccess });
  return { alice, bob, mallory, key, roadmap, notes, state };
}
// The capability the space hands `as`, which a test asserts it does hand them.
const visit = async (key: string, as: Account) =>
    await space(key).open(as.profile.id) as unknown as Space & Disposable;
// Every call of a `Space` that someone the space is not open to makes, each refused alike.
const refusals = (as: Space, id: string) => Promise.all([
  as.getInfo(), as.listWorkspaces(), as.resolveWorkspace("roadmap"), as.listMembers(),
  as.setWorkspaceSlug(id, "plan"), as.setMemberRole("anyone", "use"), as.removeMember("anyone"),
].map(call => outcome(call)));
// The keys of the spaces a user's own list of spaces holds.
const mirror = async (of: Account) => (await of.user.listSpaces()).map(info => info.key);
// What a call comes to, awaited with a single handler: expect(...).rejects forks a stub's
// promise, and the leftover copy is reported as an unhandled rejection.
const outcome = (call: PromiseLike<unknown>) =>
    call.then(() => "answered", (error: Error) => error.message);

describe("a space, to someone who is not a member of it", () => {
  it("is refused while it lists nothing published, as an unclaimed key is", async () => {
    let { mallory, key, roadmap } = await visited();
    for (let closed of [key, `team-${unique()}`]) {
      expect(await space(closed).open(mallory.profile.id)).toBeNull();
      let id = mallory.profile.id;
      for (let call of [
        space(closed).getInfo(id), space(closed).listWorkspaces(id),
        space(closed).resolveWorkspace(id, "roadmap"),
        space(closed).setWorkspaceSlug(id, roadmap, "plan"),
      ]) {
        expect(await outcome(call)).toBe(NO_SUCH_SPACE);
      }
    }
  });

  it("opens while it lists a published workspace, shows and resolves only those, and refuses "
      + "everything else", async () => {
    let { alice, mallory, key, roadmap, notes, state } = await visited();
    await state(roadmap, "use");
    using visitor = await visit(key, mallory);
    expect(await visitor.getInfo()).toEqual({ key, name: "Team", kind: "team" });
    expect(await visitor.listWorkspaces()).toMatchObject([
      { id: roadmap, title: "Roadmap", owner: alice.profile, slug: "roadmap", published: "use" },
    ]);
    expect((await space(key).listWorkspaces(alice.profile.id)).map(listed => listed.id).toSorted())
        .toEqual([roadmap, notes].toSorted());

    // A published workspace resolves under its slug and one it used to have, no other under any.
    await space(key).setWorkspaceSlug(alice.profile.id, roadmap, "plan");
    expect(await visitor.resolveWorkspace("plan"))
        .toMatchObject({ workspace: { id: roadmap }, canonical: true });
    expect(await visitor.resolveWorkspace("roadmap"))
        .toMatchObject({ workspace: { id: roadmap }, canonical: false });
    expect(await visitor.resolveWorkspace("notes")).toBeNull();
    expect(await visitor.resolveWorkspace("nothing")).toBeNull();
    expect(await space(key).resolveWorkspace(alice.profile.id, "notes"))
        .toMatchObject({ workspace: { id: notes } });

    expect((await refusals(visitor, roadmap)).slice(3)).toEqual(Array(4).fill(NO_SUCH_SPACE));
    expect((await space(key).listMembers(alice.profile.id)).map(member => member.profile.id))
        .not.toContain(mallory.profile.id);
  });

  it("gives a visitor no place in their own list of spaces, no role and no lease", async () => {
    let { alice, mallory, key, roadmap, state } = await visited();
    await state(roadmap, "build");
    using _visitor = await visit(key, mallory);
    expect(await mirror(mallory)).toEqual([mallory.personal]);
    expect(await space(key).workspaceRole(roadmap, alice.profile.id, mallory.profile.id))
        .toBeNull();
    expect(await alice.user.workspaceRoleInSpace(roadmap, mallory.profile.id)).toBeNull();
    expect(await runInDurableObject(space(key), (_instance, { storage }) =>
        [...makeSpaceStorage(storage).leases.list()])).toEqual([]);
  });

  it("is refused again once the last published workspace is withdrawn, moved or deleted",
      async () => {
    let { alice, mallory, key, roadmap, notes, state } = await visited();
    await Promise.all([state(roadmap, "use"), state(notes, "build")]);
    using visitor = await visit(key, mallory);
    expect((await visitor.listWorkspaces()).map(listed => listed.id).toSorted())
        .toEqual([roadmap, notes].toSorted());
    await state(roadmap);
    expect((await visitor.listWorkspaces()).map(listed => listed.id)).toEqual([notes]);
    await alice.user.setGadgetSpace(notes, null, { ...NEITHER, publicAccess: "build" });
    expect(await refusals(visitor, roadmap)).toEqual(Array(7).fill(NO_SUCH_SPACE));
    expect(await space(key).open(mallory.profile.id)).toBeNull();
    // The workspace took its publication to the space it moved to, which is open for it now.
    using moved = await visit(alice.personal, mallory);
    expect(await moved.listWorkspaces()).toMatchObject([{ id: notes, published: "build" }]);
    await alice.user.deleteGadget(notes, { ...NEITHER, publicAccess: "build" });
    expect(await space(alice.personal).open(mallory.profile.id)).toBeNull();
  });

  it("makes a visitor of a member who is removed, while it lists something published", async () => {
    let { alice, bob, key, roadmap, notes, state } = await visited();
    await state(roadmap, "use");
    using member = await visit(key, bob);
    expect(await member.getInfo()).toMatchObject({ key, role: "use" });
    expect(await member.listWorkspaces()).toHaveLength(2);
    expect(await mirror(bob)).toContain(key);

    await space(key).removeMember(alice.profile.id, bob.profile.id);
    expect(await member.getInfo()).toEqual({ key, name: "Team", kind: "team" });
    expect((await member.listWorkspaces()).map(listed => listed.id)).toEqual([roadmap]);
    expect(await member.resolveWorkspace("notes")).toBeNull();
    expect(await outcome(member.listMembers())).toBe(NO_SUCH_SPACE);
    expect(await outcome(member.setWorkspaceSlug(notes, "plan"))).toBe(NO_SUCH_SPACE);
    // Opening it again as a visitor puts nothing back in his list of spaces.
    using _again = await visit(key, bob);
    expect(await mirror(bob)).toEqual([bob.personal]);
  });
});
