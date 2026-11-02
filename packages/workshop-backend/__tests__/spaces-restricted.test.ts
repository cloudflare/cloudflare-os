// No space lists a workspace that holds restricted data or is owner-invites-only: the registrar
// in UserDurableObject, which mirrors those two flags, and the Overseer that states them to it,
// against real Durable Objects. What the registrar does with a workspace a space may list is in
// spaces-workspaces.test.ts.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
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

// What an Overseer states of its workspace: neither flag, or one of them.
const NEITHER: WorkspaceRestrictions = { containsRestrictedData: false, ownerInvitesOnly: false };
const RESTRICTED: WorkspaceRestrictions = { ...NEITHER, containsRestrictedData: true };
const INVITES_ONLY: WorkspaceRestrictions = { ...NEITHER, ownerInvitesOnly: true };

// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const unique = () => crypto.randomUUID().slice(0, 8);

// A user with an account. Unless told not to they list their spaces, which spends their
// object's one catch-up while they have no workspace: what a test then observes was done by
// the call it made.
async function signUp(name: string, listSpaces = true): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  if (listSpaces) await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, userId: user.id.toString(), personal: `~${id}` };
}

// A team space under a fresh key, created by `admin` and with `members` in the lowest role.
async function teamSpace(admin: Account, ...members: Account[]): Promise<string> {
  let key = `team-${unique()}`;
  let space = env.TEST_SPACE.getByName(key);
  expect(await space.claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  for (let { profile } of members) await space.setMemberRole(admin.profile.id, profile.id, "use");
  return key;
}

// A provisional workspace, of which no Overseer has reported anything.
async function newWorkspace(owner: Account, spaceKey?: string): Promise<string> {
  let id = `ws-${unique()}`;
  await owner.user.newGadget(id, "Untitled", spaceKey);
  return id;
}

// An activity report from a workspace's Overseer, stating `restrictions`. Its sync is detached.
function report(owner: Account, id: string, restrictions = NEITHER): Promise<void> {
  return owner.user.setGadgetLastActive(id, new Date(), undefined, restrictions);
}

// Waits out every sync the owner's object has been asked for so far, detached ones included:
// deleting a workspace it has no record of takes its turn after them and touches no space.
const settled = (owner: Account) => owner.user.deleteGadget("ws-none", NEITHER);

// Reads, or with `legacy` first writes, the owner's stored record of a workspace. A legacy
// record is one as it stood before Overseers stated their flags: active, neither flag known,
// and marked as listed if a space lists it.
function stored(owner: Account, id: string, legacy = false): Promise<GadgetRecord | undefined> {
  return runInDurableObject(owner.user, (_instance, state) => {
    let { gadgets } = makeUserStorage(state.storage);
    let created = new Date("2026-01-01");
    let registered = gadgets.get(id)?.registered;
    let marker = registered && { registered };
    if (legacy) gadgets.put({ id, title: "Untitled", created, lastActive: created, ...marker });
    return gadgets.get(id);
  });
}

// Waits for the space that should list an unrestricted workspace to have acknowledged it.
async function listed(owner: Account, id: string, spaceKey = owner.personal): Promise<void> {
  await vi.waitFor(async () => expect((await stored(owner, id))?.registered)
      .toEqual({ spaceKey, title: "Untitled" }), WAIT);
}

// A workspace that has reported neither flag and is listed by the space it belongs to.
async function listedWorkspace(owner: Account, spaceKey?: string): Promise<string> {
  let id = await newWorkspace(owner, spaceKey);
  await report(owner, id);
  await listed(owner, id, spaceKey);
  return id;
}

// The ids of the workspaces the space lists, sorted, as its member `viewer` is shown them.
async function listing(key: string, viewer: Account): Promise<string[]> {
  let entries = await env.TEST_SPACE.getByName(key).listWorkspaces(viewer.profile.id);
  return entries.map(entry => entry.id).toSorted();
}

// Everything the registrar asks of any space from here on, so that a test can tell a space
// that was never told of a workspace from one that listed it and dropped it again.
function spaceCalls() {
  let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces");
  return { attach, detach: vi.spyOn(SpaceDurableObject.prototype, "detachWorkspace") };
}

// What a space does when asked to list workspaces or to drop one, and the former with its
// answer lost on the way back: the space lists them, and the registrar never hears that it does.
const { attachWorkspaces, detachWorkspace } = SpaceDurableObject.prototype;
const answerLost: typeof attachWorkspaces = async function (this: SpaceDurableObject, ...asked) {
  await attachWorkspaces.apply(this, asked);
  throw new Error("answer lost");
};

// The id of the workspace an Overseer is of, as a spy on one of its methods records it.
const workspaceId = (overseer: unknown) =>
    (overseer as { ctx: DurableObjectState }).ctx.id.toString();

// A real workspace of `owner`'s, provisional in their records. `run` acts inside it on its
// OverseerImpl, and `open` gives its client interface as the owner holds it. The owner is
// planted rather than established by a first open, and the two calls an open makes to the
// owner's object besides the ones under test are stubbed, as in worktrees.test.ts.
async function workspace({ user, userId, profile }: Account) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = stub.id.toString();
  await user.newGadget(id, "Untitled");
  let run = (act: (impl: any, open: () => Promise<Overseer>) => unknown) =>
      runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as { impl: any }).impl;
        impl.storage.ownerId.put(userId);
        impl.ownerId = userId;
        impl.ensureAmbientCapsules = async () => {};
        impl.markOutputsDirty = () => {};
        let notifyClosed = new NativeRpcStub<() => void>(() => {});
        await act(impl, () => instance.open(userId, profile.id, notifyClosed));
      });
  await run(() => {});
  return { id, stub, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a workspace that holds restricted data or is owner-invites-only", () => {
  it("is never told to a space when its first activity report states a flag", async () => {
    let alice = await signUp("alice");
    let { attach } = spaceCalls();
    for (let restrictions of [RESTRICTED, INVITES_ONLY]) {
      let id = await newWorkspace(alice);
      await report(alice, id, restrictions);
      await settled(alice);
      expect(await stored(alice, id)).toMatchObject(restrictions);
      expect(await stored(alice, id)).not.toHaveProperty("registered");
    }
    expect(attach).not.toHaveBeenCalled();
    expect(await listing(alice.personal, alice)).toEqual([]);
  });

  it("leaves its listing when it reports a flag, and keeps where its owner grouped it",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    let id = await listedWorkspace(bob, team);
    expect(await listing(team, alice)).toEqual([id]);

    await report(bob, id, INVITES_ONLY);
    await settled(bob);
    expect(await listing(team, alice)).toEqual([]);
    expect(await stored(bob, id)).toMatchObject({ spaceKey: team, ...INVITES_ONLY });
    expect(await stored(bob, id)).not.toHaveProperty("registered");

    // Both flags are one-way, so a report made before that one and arriving after it lists
    // nothing and takes nothing back.
    let { attach } = spaceCalls();
    await report(bob, id, NEITHER);
    await settled(bob);
    expect(attach).not.toHaveBeenCalled();
    expect(await stored(bob, id)).toMatchObject(INVITES_ONLY);
  });

  it("stays marked as listed until the space that lists it has dropped it", async () => {
    let alice = await signUp("alice");
    let id = await listedWorkspace(alice);
    let { detach } = spaceCalls();
    detach.mockRejectedValueOnce(new Error("space unavailable"));
    await report(alice, id, RESTRICTED);
    await settled(alice);
    // Nothing but the marker names the space that still lists it, for the next sync to ask again.
    expect(await stored(alice, id)).toMatchObject(
        { ...RESTRICTED, registered: { spaceKey: alice.personal, title: "Untitled" } });
    expect(await listing(alice.personal, alice)).toEqual([id]);

    await report(alice, id, RESTRICTED);
    await settled(alice);
    expect(await stored(alice, id)).not.toHaveProperty("registered");
    expect(await listing(alice.personal, alice)).toEqual([]);
  });

  it("leaves a listing it was put on by a call whose answer never arrived", async () => {
    // Put there by its own first sync, and by a page of the catch-up.
    let [alice, dana] = await Promise.all([signUp("alice"), signUp("dana", false)]);
    let { attach, detach } = spaceCalls();
    attach.mockImplementation(answerLost);
    let synced = await newWorkspace(alice);
    await report(alice, synced);
    let paged = `ws-${unique()}`;
    let created = new Date("2026-01-01");
    await runInDurableObject(dana.user, (_instance, state) => makeUserStorage(state.storage)
        .gadgets.put({ id: paged, title: "Untitled", created, lastActive: created, ...NEITHER }));
    await dana.user.listSpaces();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2), WAIT);
    // Each is listed, and a marker without a title is all its record has to say that it may be.
    for (let [owner, id] of [[alice, synced], [dana, paged]] as const) {
      await settled(owner);
      expect(await listing(owner.personal, owner)).toEqual([id]);
      expect((await stored(owner, id))?.registered).toEqual({ spaceKey: owner.personal });
    }

    await report(alice, synced, RESTRICTED);
    await settled(alice);
    expect(await listing(alice.personal, alice)).toEqual([]);
    expect(await stored(alice, synced)).not.toHaveProperty("registered");

    // A space out of reach keeps its entry and the record its marker, and the sync a delete
    // starts with asks again: a record that went first would leave an entry nothing could drop.
    detach.mockRejectedValueOnce(new Error("space unavailable"));
    await report(dana, paged, RESTRICTED);
    await settled(dana);
    expect(await listing(dana.personal, dana)).toEqual([paged]);
    for (let [owner, id] of [[alice, synced], [dana, paged]] as const) {
      await owner.user.deleteGadget(id, RESTRICTED);
      expect(await owner.user.getGadget(id)).toBeNull();
      expect(await listing(owner.personal, owner)).toEqual([]);
    }
  });

  it("leaves both listings that a move which stopped half way left it on", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    let id = await listedWorkspace(bob);
    let { detach } = spaceCalls();
    let unavailable = new Error("space unavailable");
    detach.mockRejectedValueOnce(unavailable);
    await expect(bob.user.setGadgetSpace(id, team, NEITHER).then(() => {}))
        .rejects.toThrow("space unavailable");
    expect(await listing(team, alice)).toEqual([id]);
    expect(await listing(bob.personal, bob)).toEqual([id]);

    // The space it was leaving drops it, and the one it was going to is out of reach at first.
    detach.mockImplementationOnce(detachWorkspace).mockRejectedValueOnce(unavailable);
    await report(bob, id, RESTRICTED);
    await settled(bob);
    expect(await listing(bob.personal, bob)).toEqual([]);
    expect(await listing(team, alice)).toEqual([id]);
    expect(await stored(bob, id)).toHaveProperty("registered");

    await report(bob, id, RESTRICTED);
    await settled(bob);
    expect(await listing(team, alice)).toEqual([]);
    expect(await stored(bob, id)).toMatchObject({ spaceKey: team, ...RESTRICTED });
    expect(await stored(bob, id)).not.toHaveProperty("registered");
  });

  it("gives a space no title from a title update that is the first to state a flag", async () => {
    let alice = await signUp("alice");
    // One that is listed, and one of which no report at all came before this one.
    let ids = [await listedWorkspace(alice), `ws-${unique()}`];
    await stored(alice, ids[1], true);
    let { attach } = spaceCalls();
    for (let id of ids) await alice.user.updateTitle(id, "Quarterly numbers", RESTRICTED);
    await settled(alice);
    expect(attach).not.toHaveBeenCalled();
    expect(await listing(alice.personal, alice)).toEqual([]);
  });

  it("is only pointed by a move, which asks no space whether its owner may add to it",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    // Bob is no member: this space refuses a workspace of his that a space may list.
    let team = await teamSpace(alice);
    let hidden = await newWorkspace(bob);
    await report(bob, hidden, RESTRICTED);
    let shown = await listedWorkspace(bob);
    let { attach, detach } = spaceCalls();

    await bob.user.setGadgetSpace(hidden, team, RESTRICTED);
    expect(await stored(bob, hidden)).toMatchObject({ spaceKey: team });
    expect(detach).not.toHaveBeenCalled();

    // A move to a key no space can have is refused whole. Recording the flag it states, with
    // no sync to follow, would leave a workspace known to be restricted on its listing.
    await expect(bob.user.setGadgetSpace(shown, "Bad Key", RESTRICTED).then(() => {}))
        .rejects.toThrow("A space key is");
    expect(await stored(bob, shown)).toMatchObject(
        { ...NEITHER, registered: { spaceKey: bob.personal, title: "Untitled" } });

    // A move that is the first to state a flag takes the workspace off its listing, and that
    // is all a space hears of it.
    await bob.user.setGadgetSpace(shown, team, INVITES_ONLY);
    expect(await stored(bob, shown)).toMatchObject({ spaceKey: team, ...INVITES_ONLY });
    expect(await stored(bob, shown)).not.toHaveProperty("registered");
    expect(detach).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
    expect(await listing(bob.personal, bob)).toEqual([]);
  });

  it("is deleted with no listing to drop, or dropped from the one a failed delete left it in",
      async () => {
    let alice = await signUp("alice");
    let hidden = await newWorkspace(alice);
    await report(alice, hidden, RESTRICTED);
    let { detach } = spaceCalls();
    await alice.user.deleteGadget(hidden, RESTRICTED);
    expect(await alice.user.getGadget(hidden)).toBeNull();
    expect(detach).not.toHaveBeenCalled();

    // A delete that could not reach the space keeps the record, and the space its entry.
    let id = await listedWorkspace(alice);
    detach.mockRejectedValueOnce(new Error("space unavailable"));
    await expect(alice.user.deleteGadget(id, NEITHER).then(() => {}))
        .rejects.toThrow("space unavailable");
    expect(await listing(alice.personal, alice)).toEqual([id]);

    await report(alice, id, RESTRICTED);
    await settled(alice);
    expect(await listing(alice.personal, alice)).toEqual([]);
    await alice.user.deleteGadget(id, RESTRICTED);
    expect(await alice.user.listGadgets()).toEqual([]);
  });

  it("gives a space nothing from a delete that is the first to state a flag", async () => {
    let alice = await signUp("alice");
    // One whose new title its space has yet to hear of, and one that no space has acknowledged.
    let renamed = await listedWorkspace(alice);
    let unheard = await newWorkspace(alice);
    let { attach, detach } = spaceCalls();
    let unavailable = new Error("space unavailable");
    attach.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);
    await alice.user.updateTitle(renamed, "Plan Q3", NEITHER);
    await report(alice, unheard);
    await settled(alice);
    expect(attach).toHaveBeenCalledTimes(2);
    attach.mockClear();

    // With its space out of reach the delete fails, and the entry stays as it was.
    detach.mockRejectedValueOnce(unavailable);
    await expect(alice.user.deleteGadget(renamed, RESTRICTED).then(() => {}))
        .rejects.toThrow("space unavailable");
    expect(await stored(alice, renamed)).toMatchObject(
        { ...RESTRICTED, registered: { spaceKey: alice.personal, title: "Untitled" } });

    for (let id of [renamed, unheard]) await alice.user.deleteGadget(id, INVITES_ONLY);
    expect(attach).not.toHaveBeenCalled();
    expect(await alice.user.listGadgets()).toEqual([]);
    expect(await listing(alice.personal, alice)).toEqual([]);
  });

  it("shows its owner the flags it reported, and nobody the marker", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let shown = await listedWorkspace(alice);
    let hidden = await newWorkspace(alice);
    await report(alice, hidden, RESTRICTED);
    let record = { title: "Untitled", created: expect.any(Date), lastActive: expect.any(Date) };
    let gadgets = await alice.user.listGadgets();
    expect(Object.fromEntries(gadgets.map(gadget => [gadget.id, gadget]))).toEqual({
      [shown]: { id: shown, ...record, ...NEITHER },
      [hidden]: { id: hidden, ...record, ...RESTRICTED },
    });

    // A record of a workspace shared with a user mirrors no flag, whatever states one to it.
    await bob.user.recordSharedGadgetOpen(hidden, "Untitled", alice.profile, "build");
    await bob.user.updateTitle(hidden, "Untitled", RESTRICTED);
    await report(bob, hidden, RESTRICTED);
    expect(await stored(bob, hidden)).not.toHaveProperty("containsRestrictedData");
    expect(await bob.user.listGadgets()).toEqual(
        [{ id: hidden, ...record, owner: alice.profile, role: "build" }]);
  });
});

describe("the catch-up for workspaces whose flags no Overseer has reported", () => {
  it("asks each Overseer once, records the answers and lists only those with neither flag",
      async () => {
    let [dana, eve] = await Promise.all([signUp("dana", false), signUp("eve")]);
    // More than are asked at a time, so that the catch-up has to go on past the one that fails.
    let open = await Promise.all(Array.from({ length: 17 }, () => workspace(dana)));
    let [restricted, invitesOnly, unreachable, foreign] = await Promise.all(
        [workspace(dana), workspace(dana), workspace(dana), workspace(eve)]);
    await restricted.run(impl => impl.storage.containsRestrictedData.put(true));
    await invitesOnly.run(impl => impl.storage.ownerInvitesOnly.put(true));
    let listable = open.map(({ id }) => id).toSorted();
    let unlisted = [restricted, invitesOnly, unreachable, foreign].map(({ id }) => id);
    for (let id of [...listable, ...unlisted]) await stored(dana, id, true);
    // Neither of these is asked, though each has an Overseer that would answer: one has seen
    // no activity, the other is not Dana's.
    await workspace(dana);
    await dana.user.recordSharedGadgetOpen(
        (await workspace(eve)).id, "Theirs", eve.profile, "build");

    // Each Overseer takes long enough to answer that all those asked along with it are being
    // asked at once, which is how many the catch-up keeps awake at a time.
    let answer = OverseerDurableObject.prototype.getRestrictionsForOwnerBackfill;
    let asked = { atOnce: 0, most: 0 };
    let ask = vi.spyOn(OverseerDurableObject.prototype, "getRestrictionsForOwnerBackfill")
        .mockImplementation(async function (this: OverseerDurableObject, ownerId) {
          asked.most = Math.max(asked.most, ++asked.atOnce);
          await scheduler.wait(50);
          asked.atOnce--;
          if (workspaceId(this) === unreachable.id) throw new Error("workspace unavailable");
          return answer.call(this, ownerId);
        });
    // The first catch-up learns the flags and then fails at the space.
    let { attach } = spaceCalls();
    attach.mockRejectedValueOnce(new Error("space unavailable"));
    await dana.user.listSpaces();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1), WAIT);
    expect(ask.mock.contexts.map(workspaceId).toSorted())
        .toEqual([...listable, ...unlisted].toSorted());
    expect(asked.most).toBeGreaterThan(1);
    expect(asked.most).toBeLessThanOrEqual(16);

    // The next one asks only the two it has no answer from, and lists what it may.
    await vi.waitFor(async () => {
      await dana.user.listSpaces();
      expect(await listing(dana.personal, dana)).toEqual(listable);
    }, WAIT);
    await dana.user.listSpaces();
    await settled(dana);
    expect(ask.mock.contexts.slice(21).map(workspaceId).toSorted())
        .toEqual([unreachable.id, foreign.id].toSorted());
    expect(await listing(dana.personal, dana)).toEqual(listable);
    let told = attach.mock.calls.flatMap(([, registrations]) => registrations.map(({ id }) => id));
    expect(told.filter(id => unlisted.includes(id))).toEqual([]);

    expect(await stored(dana, listable[0])).toMatchObject(NEITHER);
    expect(await stored(dana, restricted.id)).toMatchObject(RESTRICTED);
    expect(await stored(dana, invitesOnly.id)).toMatchObject(INVITES_ONLY);
    // No answer, and the answer kept from an object that is not the owner's, leave it unknown.
    for (let id of [unreachable.id, foreign.id]) {
      expect(await stored(dana, id)).not.toHaveProperty("containsRestrictedData");
      expect(await stored(dana, id)).not.toHaveProperty("ownerInvitesOnly");
    }

    // The activity report of the one that could not be reached settles it.
    await report(dana, unreachable.id);
    await listed(dana, unreachable.id);
    expect(await listing(dana.personal, dana)).toEqual([...listable, unreachable.id].toSorted());
  });

  it("takes off its listing a workspace listed before its flags were known, unless it has neither",
      async () => {
    let dana = await signUp("dana", false);
    let [open, restricted] = await Promise.all([workspace(dana), workspace(dana)]);
    // One that has no Overseer, and whose id cannot even address one.
    let orphan = await newWorkspace(dana);
    for (let id of [open.id, restricted.id, orphan]) {
      await report(dana, id);
      await listed(dana, id);
      await stored(dana, id, true);
    }
    await restricted.run(impl => impl.storage.containsRestrictedData.put(true));
    let { attach, detach } = spaceCalls();

    await dana.user.listSpaces();
    await vi.waitFor(async () => {
      expect(await stored(dana, restricted.id)).not.toHaveProperty("registered");
      expect(await stored(dana, orphan)).not.toHaveProperty("registered");
    }, WAIT);
    expect(await listing(dana.personal, dana)).toEqual([open.id]);
    expect(await stored(dana, open.id)).toMatchObject(
        { ...NEITHER, registered: { spaceKey: dana.personal, title: "Untitled" } });
    expect(await stored(dana, restricted.id)).toMatchObject(RESTRICTED);
    expect(await stored(dana, orphan)).not.toHaveProperty("containsRestrictedData");
    expect(attach).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledTimes(2);
  });

  it("asks no more Overseers once none of those asked together has answered", async () => {
    let dana = await signUp("dana", false);
    // One more than are asked at a time, and a workspace known to have neither flag: a catch-up
    // lists it once it is done asking, and fails there the first time, so that another follows.
    let [known, ...unknown] =
        Array.from({ length: 18 }, () => env.TEST_OVERSEER.newUniqueId().toString());
    for (let id of unknown) await stored(dana, id, true);
    let created = new Date("2026-01-01");
    await runInDurableObject(dana.user, (_instance, state) => makeUserStorage(state.storage)
        .gadgets.put({ id: known, title: "Untitled", created, lastActive: created, ...NEITHER }));
    let ask = vi.spyOn(OverseerDurableObject.prototype, "getRestrictionsForOwnerBackfill")
        .mockRejectedValue(new Error("workspace unavailable"));
    let { attach } = spaceCalls();
    attach.mockRejectedValueOnce(new Error("space unavailable"));
    await dana.user.listSpaces();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1), WAIT);
    expect(ask).toHaveBeenCalledTimes(16);

    // The next catch-up starts with the same ones, and an answer from one of them takes it on
    // to the last. Neither asks the Overseer of the workspace whose flags are known.
    ask.mockResolvedValueOnce(NEITHER);
    await vi.waitFor(async () => {
      await dana.user.listSpaces();
      expect(ask).toHaveBeenCalledTimes(33);
    }, WAIT);
    expect(ask.mock.contexts.map(workspaceId)).not.toContain(known);
  });

  it("keeps a flag reported while an answer made before it was set was on its way", async () => {
    let dana = await signUp("dana", false);
    let [flagged, open] = [0, 1].map(() => env.TEST_OVERSEER.newUniqueId().toString());
    for (let id of [flagged, open]) await stored(dana, id, true);
    // Both Overseers answer that they have neither flag, and only once the test lets them.
    let answers = { held: true };
    let ask = vi.spyOn(OverseerDurableObject.prototype, "getRestrictionsForOwnerBackfill")
        .mockImplementation(async () => {
          while (answers.held) await scheduler.wait(10);
          return NEITHER;
        });
    try {
      await dana.user.listSpaces();
      await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2), WAIT);
      await report(dana, flagged, RESTRICTED);
    } finally {
      answers.held = false;
    }
    // The two answers are recorded before anything is listed, so once one workspace is listed
    // the other would be too, had its answer taken the flag back.
    await listed(dana, open);
    expect(await stored(dana, flagged)).toMatchObject(RESTRICTED);
    expect(await listing(dana.personal, dana)).toEqual([open]);
  });
});

describe("a workspace's Overseer", () => {
  it("states its flags with its activity, and at once when an observation first sets one",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    for (let restrictions of [RESTRICTED, INVITES_ONLY]) {
      let { id, stub, run } = await workspace(alice);
      await run(impl => impl.bumpLastActive());
      await listed(alice, id);
      expect(await stub.getRestrictionsForOwnerBackfill(alice.userId)).toEqual(NEITHER);

      // The report just made holds the next activity report back for a minute, and this one
      // is not held back. Only the flag the observation carries is set.
      let { containsRestrictedData, ownerInvitesOnly } = restrictions;
      await run(impl => impl.authorizeObservation(1, {
        title: "Read a thing", description: "The test read a thing.",
        ...(containsRestrictedData && { containsRestrictedData }),
        ...(ownerInvitesOnly && { ownerInvitesOnly }),
      }, { from: "user" }));
      await vi.waitFor(async () =>
          expect(await stored(alice, id)).not.toHaveProperty("registered"), WAIT);
      expect(await stored(alice, id)).toMatchObject(restrictions);
      expect(await listing(alice.personal, alice)).toEqual([]);

      // Only its owner's object is told them.
      expect(await stub.getRestrictionsForOwnerBackfill(alice.userId)).toEqual(restrictions);
      expect(await stub.getRestrictionsForOwnerBackfill(bob.userId)).toBeNull();
    }
  });

  it("does not keep an observation waiting for the report that it set a flag", async () => {
    let alice = await signUp("alice");
    let { id, run } = await workspace(alice);
    // The owner's object takes the report only once the test lets it.
    let { setGadgetLastActive } = UserDurableObject.prototype;
    let reports = { held: true };
    vi.spyOn(UserDurableObject.prototype, "setGadgetLastActive").mockImplementation(
        async function (this: UserDurableObject, ...reported) {
          while (reports.held) await scheduler.wait(10);
          return setGadgetLastActive.apply(this, reported);
        });
    try {
      let observed = run(impl => impl.authorizeObservation(1, {
        title: "Read a thing", description: "The test read a thing.", containsRestrictedData: true,
      }, { from: "user" })).then(() => "observed");
      let waited = scheduler.wait(2_000).then(() => "still waiting");
      expect(await Promise.race([observed, waited])).toBe("observed");
      expect(await stored(alice, id)).not.toHaveProperty("containsRestrictedData");
    } finally {
      reports.held = false;
    }
    await vi.waitFor(async () => expect(await stored(alice, id)).toMatchObject(RESTRICTED), WAIT);
  });

  it("states its flags with a title update, a move, a delete and a blueprint's instantiation",
      async () => {
    let alice = await signUp("alice");
    let team = await teamSpace(alice);
    let [renamed, moved, deleted] =
        await Promise.all([workspace(alice), workspace(alice), workspace(alice)]);
    for (let { id, run } of [renamed, moved, deleted]) {
      await run(impl => impl.bumpLastActive());
      await listed(alice, id);
    }
    let { attach } = spaceCalls();
    let deleteGadget = vi.spyOn(UserDurableObject.prototype, "deleteGadget");

    // A flag that no observation set, so that the call under test is the first to state it.
    await renamed.run(async (impl, open) => {
      impl.storage.containsRestrictedData.put(true);
      await (await open()).setTitle("Quarterly numbers");
    });
    await moved.run(async (impl, open) => {
      impl.storage.ownerInvitesOnly.put(true);
      await (await open()).moveToSpace(team);
    });
    // A delete ends by telling its caller's session and restarting the workspace's object. Here
    // the session is a function of this object's own, which cannot be called while the delete
    // holds the object, and the restart would take the object from under the test.
    await deleted.run(async (impl, open) => {
      impl.storage.containsRestrictedData.put(true);
      impl.scheduleAccessRestart = async () => {};
      let session = Object.assign(await open(), { notifyClosed: async () => {} });
      await session.deleteSelf();
    });
    // Instantiating a blueprint ends with an activity report of its own, here the first that
    // the workspace makes.
    let instantiated = await workspace(alice);
    let archive = new Y.Doc();
    archive.getMap().set("index.js", new Y.Text("export {};"));
    await instantiated.run(impl => impl.storage.ownerInvitesOnly.put(true));
    await instantiated.stub.initializeFromBlueprint(Y.encodeStateAsUpdateV2(archive), "Made");
    expect(deleteGadget).toHaveBeenCalledWith(deleted.id, RESTRICTED);
    expect(await alice.user.getGadget(deleted.id)).toBeNull();
    await settled(alice);
    expect(await stored(alice, renamed.id))
        .toMatchObject({ title: "Quarterly numbers", ...RESTRICTED });
    expect(await stored(alice, moved.id)).toMatchObject({ spaceKey: team, ...INVITES_ONLY });
    expect(await stored(alice, instantiated.id))
        .toMatchObject({ lastActive: expect.any(Date), ...INVITES_ONLY });
    expect(attach).not.toHaveBeenCalled();
    expect(await listing(alice.personal, alice)).toEqual([]);
    expect(await listing(team, alice)).toEqual([]);
  });
});
