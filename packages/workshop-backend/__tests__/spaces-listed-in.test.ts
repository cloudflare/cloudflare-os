// Which space lists a workspace, as the metadata its Overseer serves says (`listedIn`): the space
// its owner's User DO says has acknowledged listing it, told to everyone who can open the
// workspace, owner or not, and absent while no space lists it or when the lookup fails. It is
// presentation only, so none of it decides who may open the workspace. Everything runs against
// real Durable Objects: the workspace's Overseer, its owner's User DO and the spaces.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, CollaboratorRole, GadgetMetadata, Overseer,
} from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
import { makeUserStorage, type WorkspaceRestrictions } from "../src/storage-schema/user-storage.js";
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
const DENIED = "You don't have access to this workspace.";
const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
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

// A team space under a fresh key, created by `admin`.
async function teamSpace(admin: Account): Promise<string> {
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  return key;
}

// Waits out every sync of `owner`'s workspaces asked for so far: deleting a workspace the owner
// has no record of is queued behind them.
const settled = (owner: Account) => owner.user.deleteGadget("ws-none", NEITHER);

// A real workspace of `owner`'s in team space `spaceKey`, or with none in their personal space,
// which lists it unless it is left `provisional`. `run` acts inside its Overseer, on its
// OverseerImpl, with the owner planted rather than established by a first open; the restarts it
// schedules are recorded in `restarts` instead of taking the object from under the test.
async function workspace(owner: Account, spaceKey?: string, provisional = false) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = stub.id.toString();
  await owner.user.newGadget(id, "Untitled", spaceKey);
  if (!provisional) {
    await owner.user.setGadgetLastActive(id, DAY, undefined, NEITHER);
    await settled(owner);
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

const open = (instance: OverseerDurableObject, as: Account): Promise<Overseer> =>
    instance.open(as.userId, as.profile.id, new NativeRpcStub<() => void>(() => {}));
// What the metadata served to `as` says lists the workspace.
const listedIn = async (instance: OverseerDurableObject, as: Account) =>
    (await (await open(instance, as)).getMetadata()).listedIn;
// What opening the workspace as `as` comes to: the role of their session, or the refusal.
const opening = (instance: OverseerDurableObject, as: Account) => open(instance, as)
    .then(async session => (await session.getMetadata()).role, (error: Error) => error.message);

// Subscribes to the metadata served to `as`, and returns what each push of it carried, as `pick`
// takes it, for as long as the test runs.
async function watch<T>(instance: OverseerDurableObject, as: Account,
    pick: (metadata: GadgetMetadata) => T = metadata => metadata.listedIn as T): Promise<T[]> {
  let seen: T[] = [];
  let callback = new NativeRpcStub((metadata: GadgetMetadata) => { seen.push(pick(metadata)); });
  await (await open(instance, as)).subscribeToMetadata(callback as any);
  await vi.waitFor(() => expect(seen).not.toHaveLength(0), WAIT);
  return seen;
}

// The owner adds `to` to the workspace's own sharing, in `role`.
function share(impl: any, owner: Account, to: Account, role: CollaboratorRole): void {
  impl.storage.collaborators.put({
    profile: to.profile,
    addedBy: [{ type: "user", sharer: owner.profile.id, created: DAY, role }],
  });
}

// An observation that states `flag` of the workspace, under which no space lists it.
const flagging = (impl: any, flag: string): Promise<void> => impl.authorizeObservation(
    1, { title: "Read", description: "The test read a thing.", [flag]: true }, { from: "user" });

// What `owner`'s User DO answers when asked which space lists workspace `id`, through a stub of
// its own, so that it can be asked from inside another object.
const acknowledged = (owner: Account, id: string) =>
    env.TEST_USER.getByName(owner.profile.id).workspaceListedIn(id);

// Every lookup a workspace's Overseer makes of which space lists it, which goes to its owner's
// User DO.
const lookups = () => vi.spyOn(UserDurableObject.prototype, "workspaceListedIn");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the owner's User DO, asked which space lists a workspace", () => {
  it("names the space that has acknowledged listing it, personal or team, and none for a "
      + "workspace that no space lists or that is not the user's own", async () => {
    let [alice, bob] = await Promise.all(["alice", "bob"].map(signUp));
    let key = await teamSpace(alice);
    let personal = await workspace(alice);
    let team = await workspace(alice, key);
    let provisional = await workspace(alice, undefined, true);
    let flagged = await workspace(alice);
    let marked = await workspace(alice);
    expect(await alice.user.workspaceListedIn(personal.id)).toBe(alice.personal);
    expect(await alice.user.workspaceListedIn(team.id)).toBe(key);

    await alice.user.setGadgetPublicAccess(
        flagged.id, { containsRestrictedData: false, ownerInvitesOnly: true });
    expect(await alice.user.workspaceListedIn(flagged.id)).toBeNull();
    expect(await alice.user.workspaceListedIn(provisional.id)).toBeNull();
    expect(await bob.user.workspaceListedIn(team.id)).toBeNull();
    expect(await alice.user.workspaceListedIn("ws-none")).toBeNull();

    // A move that stopped half way leaves the record pointed at a space whose listing does not
    // hold the workspace yet: the marker, not the pointer, says which space lists it.
    let other = await teamSpace(alice);
    await runInDurableObject(alice.user, (_instance, state) => {
      let gadgets = makeUserStorage(state.storage).gadgets;
      gadgets.put({ ...gadgets.get(team.id)!, spaceKey: other });
    });
    expect(await alice.user.workspaceListedIn(team.id)).toBe(key);

    // A record that still holds its marker under a flag, as it does until a sync drops the
    // marker, names none: no space may list the workspace.
    await runInDurableObject(alice.user, (_instance, state) => {
      let gadgets = makeUserStorage(state.storage).gadgets;
      gadgets.put({ ...gadgets.get(marked.id)!, containsRestrictedData: true });
    });
    expect(await alice.user.workspaceListedIn(marked.id)).toBeNull();

    // A space asked to list the workspace may or may not have: its marker names the space, but
    // without a title, so none is known to.
    await runInDurableObject(alice.user, (_instance, state) => {
      let gadgets = makeUserStorage(state.storage).gadgets;
      gadgets.put({ ...gadgets.get(personal.id)!, registered: { spaceKey: alice.personal } });
    });
    expect(await alice.user.workspaceListedIn(personal.id)).toBeNull();
  });
});

describe("the space a workspace's metadata says lists it", () => {
  it("is the owner's personal space, told to the owner, a collaborator and a \"use\" "
      + "collaborator alike, and asked of the owner's User DO once", async () => {
    let [alice, carol, dave] = await Promise.all(["alice", "carol", "dave"].map(signUp));
    let ws = await workspace(alice);
    let asked = lookups();
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "build");
      share(impl, alice, dave, "use");
      for (let as of [alice, carol, dave]) {
        expect(await listedIn(instance, as)).toBe(alice.personal);
        expect(await watch(instance, as)).toEqual([alice.personal]);
      }
      expect(await opening(instance, dave)).toBe("use");
    });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("is the team space for a workspace created there, told to a collaborator who is not a "
      + "member of it", async () => {
    let [alice, carol] = await Promise.all(["alice", "carol"].map(signUp));
    let key = await teamSpace(alice);
    let ws = await workspace(alice, key);
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "use");
      expect(await listedIn(instance, alice)).toBe(key);
      expect(await listedIn(instance, carol)).toBe(key);
    });
  });

  it("follows a move, pushed to every subscription", async () => {
    let [alice, carol, dave] = await Promise.all(["alice", "carol", "dave"].map(signUp));
    let key = await teamSpace(alice);
    let ws = await workspace(alice);
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "build");
      share(impl, alice, dave, "use");
      let seen = await Promise.all([alice, carol, dave].map(as => watch(instance, as)));
      // What each of the three subscriptions is to have been told, in order.
      let told = (...keys: string[]) => seen.map(() => keys);
      let owner = await open(instance, alice);
      await owner.moveToSpace(key);
      await vi.waitFor(() => expect(seen).toEqual(told(alice.personal, key)), WAIT);
      expect(await listedIn(instance, carol)).toBe(key);

      await owner.moveToSpace(null);
      await vi.waitFor(
          () => expect(seen).toEqual(told(alice.personal, key, alice.personal)), WAIT);
    });
  });

  it("is asked again after a refused move, which first finishes one left half done",
      async () => {
    let [alice, mallory] = await Promise.all(["alice", "mallory"].map(signUp));
    let key = await teamSpace(alice);
    let foreign = await teamSpace(mallory);
    let ws = await workspace(alice);
    await ws.run(async (_impl, instance) => {
      let seen = await watch(instance, alice);
      let owner = await open(instance, alice);
      // The team space lists the workspace, but the personal space cannot be reached to drop it,
      // so the move stops half way, with the personal space still the one acknowledged.
      vi.spyOn(SpaceDurableObject.prototype, "detachWorkspace")
          .mockRejectedValueOnce(new Error("space unavailable"));
      await expect(owner.moveToSpace(key)).rejects.toThrow("space unavailable");
      expect(await acknowledged(alice, ws.id)).toBe(alice.personal);

      await expect(owner.moveToSpace(foreign)).rejects.toThrow(NO_SUCH_SPACE);
      expect(await acknowledged(alice, ws.id)).toBe(key);
      await vi.waitFor(() => expect(seen).toEqual([alice.personal, key]), WAIT);
    });
  });

  it("follows a move whose answer was lost on its way back", async () => {
    let alice = await signUp("alice");
    let key = await teamSpace(alice);
    let ws = await workspace(alice);
    let setGadgetSpace = UserDurableObject.prototype.setGadgetSpace;
    vi.spyOn(UserDurableObject.prototype, "setGadgetSpace").mockImplementationOnce(
        async function (this: UserDurableObject, ...args) {
          await setGadgetSpace.apply(this, args);
          throw new Error("answer lost");
        });
    await ws.run(async (_impl, instance) => {
      let seen = await watch(instance, alice);
      await expect((await open(instance, alice)).moveToSpace(key)).rejects.toThrow("answer lost");
      await vi.waitFor(() => expect(seen).toEqual([alice.personal, key]), WAIT);
    });
  });

  it("is asked again at the next serve after a move whose answer was lost while the move was "
      + "still under way", async () => {
    let alice = await signUp("alice");
    let key = await teamSpace(alice);
    let ws = await workspace(alice);
    // The team space holds its answer to the move back until the test lets it go.
    let gate = { open: false };
    let attachWorkspaces = SpaceDurableObject.prototype.attachWorkspaces;
    vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces").mockImplementationOnce(
        async function (this: SpaceDurableObject, ...args) {
          while (!gate.open) await scheduler.wait(10);
          return attachWorkspaces.apply(this, args);
        });
    let setGadgetSpace = UserDurableObject.prototype.setGadgetSpace;
    vi.spyOn(UserDurableObject.prototype, "setGadgetSpace").mockImplementationOnce(
        async function (this: UserDurableObject, ...args) {
          setGadgetSpace.apply(this, args).catch(() => {});
          throw new Error("answer lost");
        });
    await ws.run(async (_impl, instance) => {
      let seen = await watch(instance, alice);
      let asked = lookups();
      await expect((await open(instance, alice)).moveToSpace(key)).rejects.toThrow("answer lost");
      // The lookup after the move is answered before the team space has listed the workspace.
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1), WAIT);
      expect(await asked.mock.results[0]!.value).toBe(alice.personal);
      gate.open = true;
      await vi.waitFor(
          async () => expect(await acknowledged(alice, ws.id)).toBe(key), WAIT);
      expect(await listedIn(instance, alice)).toBe(key);
      await vi.waitFor(() => expect(seen).toEqual([alice.personal, key]), WAIT);
    });
  });

  it("is absent for a provisional workspace, kept so until the workspace reports activity, and "
      + "named at a serve after that once it is listed", async () => {
    let alice = await signUp("alice");
    let ws = await workspace(alice, undefined, true);
    let asked = lookups();
    await ws.run(async (_impl, instance) => {
      expect(await listedIn(instance, alice)).toBeUndefined();
    });
    // Listed by activity its Overseer did not report, the workspace is not asked about again.
    await alice.user.setGadgetLastActive(ws.id, DAY, undefined, NEITHER);
    await settled(alice);
    expect(await alice.user.workspaceListedIn(ws.id)).toBe(alice.personal);
    asked.mockClear();
    await ws.run(async (impl, instance) => {
      let seen = await watch(instance, alice);
      expect(seen).toEqual([undefined]);
      expect(asked).not.toHaveBeenCalled();

      // Once it reports activity, which its owner's User DO follows by listing it in the
      // background, it is asked again until an answer names the space.
      impl.bumpLastActive(DAY);
      await vi.waitFor(async () => expect(await listedIn(instance, alice)).toBe(alice.personal),
          WAIT);
      await vi.waitFor(() => expect(seen).toEqual([undefined, alice.personal]), WAIT);
      let times = asked.mock.calls.length;
      expect(await listedIn(instance, alice)).toBe(alice.personal);
      expect(asked).toHaveBeenCalledTimes(times);
    });
  });

  it("takes only the latest lookup's answer, not an older one that comes after it", async () => {
    let alice = await signUp("alice");
    let ws = await workspace(alice);
    let gate = { open: false };
    lookups().mockImplementationOnce(async () => {
      while (!gate.open) await scheduler.wait(10);
      return "~stale";
    });
    await ws.run(async impl => {
      let older = impl.refreshListedIn();
      await impl.refreshListedIn();
      expect(impl.listedIn).toBe(alice.personal);
      gate.open = true;
      await older;
      expect(impl.listedIn).toBe(alice.personal);
    });
  });

  it("names none when the workspace comes under either flag while a lookup is in flight",
      async () => {
    let alice = await signUp("alice");
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice);
      // The lookup is answered before the flag is set, and the answer held back until after.
      // The flag's activity report, which would drop the lookup, is held back longer.
      let gate = { answered: false, open: false, reported: false };
      let workspaceListedIn = UserDurableObject.prototype.workspaceListedIn;
      lookups().mockImplementationOnce(async function (this: UserDurableObject, ...args) {
        let key = await workspaceListedIn.apply(this, args);
        gate.answered = true;
        while (!gate.open) await scheduler.wait(10);
        return key;
      });
      let setGadgetLastActive = UserDurableObject.prototype.setGadgetLastActive;
      vi.spyOn(UserDurableObject.prototype, "setGadgetLastActive").mockImplementationOnce(
          async function (this: UserDurableObject, ...args) {
            while (!gate.reported) await scheduler.wait(10);
            return setGadgetLastActive.apply(this, args);
          });
      await ws.run(async (impl, instance) => {
        let lookup = impl.knowListedIn();
        await vi.waitFor(() => expect(gate.answered).toBe(true), WAIT);
        await flagging(impl, flag);
        gate.open = true;
        await lookup;
        expect(impl.listedIn).toBeUndefined();
        gate.reported = true;
        expect(await listedIn(instance, alice)).toBeUndefined();
      });
      vi.restoreAllMocks();
    }
  });

  it("is pushed to a subscription once a change of publication lists the workspace",
      async () => {
    let alice = await signUp("alice");
    let ws = await workspace(alice, undefined, true);
    // The space cannot be reached when the workspace is first active, so nothing lists it yet.
    vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces")
        .mockRejectedValueOnce(new Error("space unavailable"));
    await alice.user.setGadgetLastActive(ws.id, DAY, undefined, NEITHER);
    await settled(alice);
    await ws.run(async (_impl, instance) => {
      let seen = await watch(instance, alice,
          metadata => [metadata.publicAccess, metadata.listedIn]);
      await (await open(instance, alice)).setPublicAccess("use");
      await vi.waitFor(() => expect(seen).toEqual(
          [[undefined, undefined], ["use", undefined], ["use", alice.personal]]), WAIT);
    });
  });

  it("is withdrawn from every subscription when the workspace comes under either flag, never "
      + "pushed beside the flag, and no longer asked for", async () => {
    let [alice, dave] = await Promise.all(["alice", "dave"].map(signUp));
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice);
      await ws.run(async (impl, instance) => {
        share(impl, alice, dave, "use");
        let owner = await watch(instance, alice, metadata =>
            [metadata.containsRestrictedData || metadata.ownerInvitesOnly, metadata.listedIn]);
        let visitor = await watch(instance, dave);
        await flagging(impl, flag);
        await vi.waitFor(() => expect(owner.at(-1)).toEqual([true, undefined]), WAIT);
        expect(owner).not.toContainEqual([true, alice.personal]);
        expect(visitor).toEqual([alice.personal, undefined]);

        let asked = lookups();
        expect(await listedIn(instance, alice)).toBeUndefined();
        expect(await listedIn(instance, dave)).toBeUndefined();
        expect(asked).not.toHaveBeenCalled();
        asked.mockRestore();
      });
    }

    // Under a flag before its metadata is first served, nobody is asked at all.
    let flagged = await workspace(alice);
    let asked = lookups();
    await flagged.run(async (impl, instance) => {
      impl.storage.containsRestrictedData.put(true);
      expect(await listedIn(instance, alice)).toBeUndefined();
      expect(await watch(instance, alice)).toEqual([undefined]);
    });
    expect(asked).not.toHaveBeenCalled();
  });

  it("is absent, and no error, when the lookup fails, and asked again at the next serve",
      async () => {
    let [alice, carol] = await Promise.all(["alice", "carol"].map(signUp));
    let ws = await workspace(alice);
    let asked = lookups().mockRejectedValue(new Error("user object unavailable"));
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "build");
      expect(await listedIn(instance, alice)).toBeUndefined();
      expect(await watch(instance, carol)).toEqual([undefined]);
      expect(await opening(instance, carol)).toBe("build");
      asked.mockRestore();
      expect(await listedIn(instance, carol)).toBe(alice.personal);
    });
  });

  it("is withdrawn when a lookup after a move fails", async () => {
    let alice = await signUp("alice");
    let key = await teamSpace(alice);
    let ws = await workspace(alice);
    await ws.run(async (_impl, instance) => {
      let seen = await watch(instance, alice);
      lookups().mockRejectedValue(new Error("user object unavailable"));
      await (await open(instance, alice)).moveToSpace(key);
      await vi.waitFor(() => expect(seen).toEqual([alice.personal, undefined]), WAIT);
    });
  });

  it("authorizes nothing: a collaborator removed from the workspace's sharing cannot open it, "
      + "though its metadata named the space that lists it", async () => {
    let [alice, carol] = await Promise.all(["alice", "carol"].map(signUp));
    let key = await teamSpace(alice);
    let ws = await workspace(alice, key);
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "build");
      expect(await listedIn(instance, carol)).toBe(key);
      await (await open(instance, alice)).removeCollaborator(carol.profile.id, []);
      expect(await opening(instance, carol)).toBe(DENIED);
      expect(impl.listedIn).toBe(key);
    });
  });
});
