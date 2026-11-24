// A workspace's summary (what waits on whom, and its hooks) is pushed by its Overseer into the
// User DO of the owner and of each admitted "build" collaborator, which serves it through
// subscribeToWorkspaceSummaries() without opening the workspace. Runs against real Overseer and
// User DOs.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, WorkspaceSummary, WorkspaceSummarySubscriber } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import { putAction } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T> | T) =>
  runInDurableObject(env.TEST_OVERSEER.get(stub.id), instance => fn(instance.impl));

type Fixture = {
  user: DurableObjectStub<UserDurableObject>;
  owner: AiChatAuthorInfo;
  workspace: DurableObjectStub<OverseerDurableObject>;
  workspaceId: string;
};

// An owner with one workspace holding a plain chat (1), a run gadget 11 started (2), and gadgets
// 10 and 11.
const setup = async (): Promise<Fixture> => {
  const id = crypto.randomUUID();
  const user = env.TEST_USER.getByName(id);
  await runInDurableObject(user, (_instance, ctx) =>
    makeUserStorage(ctx.storage).profile.put({type: "user", id, name: "Owner"}));
  const owner = await user.whoami();
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newWorkspace(workspaceId, "Workspace");
  await user.setWorkspaceLastActive(workspaceId, new Date(), undefined);
  await withImpl(workspace, impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
    for (let gadgetId of [10, 11]) {
      impl.storage.gadgets.put({type: "gadget", id: gadgetId, title: `Gadget ${gadgetId}`,
        created: new Date(0), bindingName: `G${gadgetId}`, bindings: {}});
    }
    impl.storage.chatMeta.put({id: 1, title: "Chat", started: new Date(1), lastActive: new Date(1)});
    impl.storage.chatMeta.put({id: 2, title: "Run", started: new Date(2), lastActive: new Date(2),
      spawnerName: "Agent", spawnerId: 5, spawnedByGadgetId: 11});
  });
  return {user, owner, workspace, workspaceId};
};

// An action of `caller`'s, pending unless `state` says otherwise.
const ask = (impl: Impl, id: number, caller: GatekeeperCaller,
    state: "pending" | "approved" = "pending") => {
  putAction(impl.storage, id, {state});
  impl.storage.actions.put({...impl.storage.actions.get(id)!, caller});
};

const storedSummary = (user: DurableObjectStub<UserDurableObject>, workspaceId: string) =>
  runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).workspaceSummaries.get(workspaceId));

const addReader = async (fixture: Fixture) => {
  const profile = {type: "user" as const, id: `reader-${crypto.randomUUID()}`, name: "Reader"};
  const reader = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(reader, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
  await withImpl(fixture.workspace, impl => impl.storage.collaborators.put({profile,
    addedBy: [{type: "user", sharer: fixture.owner.id, role: "build", created: new Date()}]}));
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", fixture.owner, "build", []);
  return {reader, profile};
};

class SummaryUpdates extends RpcTarget implements WorkspaceSummarySubscriber {
  readonly snapshots: WorkspaceSummary[][] = [];
  readonly updates: [string, WorkspaceSummary | null][] = [];
  async snapshot(summaries: WorkspaceSummary[]) { this.snapshots.push(summaries); }
  async updated(workspaceId: string, summary: WorkspaceSummary | null) { this.updates.push([workspaceId, summary]); }
}

it("counts each pending action once, for the chat or run waiting and the gadget that asked", async () => {
  const fixture = await setup();
  const waiting = await withImpl(fixture.workspace, async impl => {
    ask(impl, 0, {from: "gadget", gadgetId: 10});
    ask(impl, 1, {from: "hook", gadgetId: 10});
    ask(impl, 2, {from: "agent", chatId: 2});
    ask(impl, 3, {from: "agent", chatId: 1});
    // Decided, or asked by what is no gadget (any more): no gadget's.
    ask(impl, 4, {from: "gadget", gadgetId: 10}, "approved");
    ask(impl, 5, {from: "gadget", gadgetId: 99});
    // A gadget's code in a chat waits as that chat.
    ask(impl, 6, {from: "gadget", gadgetId: 10, chatId: 1});
    return impl.workspaceSummary().waiting;
  });
  expect(waiting).toEqual({runs: 1, chats: 1, gadgets: [{gadgetId: 10, actions: 2}, {gadgetId: 11, actions: 1}]});
});

it("lists each waiting chat with what it asks, and the chats whose agents work", async () => {
  const fixture = await setup();
  const summary = await withImpl(fixture.workspace, impl => {
    ask(impl, 0, {from: "agent", chatId: 2});
    impl.storage.chatMeta.put({id: 3, title: "Connect", started: new Date(3), lastActive: new Date(3)});
    impl.addChatMessages(3, {type: "agent", id: "model", name: "Model"}, [
      {type: "connectionRequest", requestId: "3:c", vendorId: "github", vendorName: "GitHub",
        reason: "To read issues", state: "pending"},
    ]);
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!,
      activeAgent: {type: "agent", id: "model", name: "Model"}});
    impl.storage.activeAgents.put({chatId: 1, initiatorUserId: fixture.user.id.toString(), modelId: "model",
      initiator: fixture.owner, callbackInitiated: false});
    return impl.workspaceSummary();
  });
  expect(summary.waitingChats).toEqual([
    {chatId: 3, title: "Connect", lastActive: expect.any(Date), waiting: "action",
      ask: {type: "connection", vendorName: "GitHub", reason: "To read issues"}},
    {chatId: 2, title: "Run", lastActive: new Date(2), waiting: "approval",
      ask: {type: "action", title: "Action 0"}, spawnerId: 5, spawnerName: "Agent"},
  ]);
  expect(summary.workingChatIds).toEqual([1]);
});

it("clears a request-only wait when the user stops the paused turn", async () => {
  const {workspace, workspaceId, user} = await setup();
  await withImpl(workspace, impl => {
    impl.addChatMessages(1, {type: "agent", id: "model", name: "Model"}, [
      {type: "webFetchRequest", requestId: "1:fetch", url: "https://example.test/", state: "pending"},
    ]);
  });
  await vi.waitFor(async () => expect(await storedSummary(user, workspaceId))
    .toMatchObject({waiting: {chats: 1, runs: 0, gadgets: []}}));

  await withImpl(workspace, impl => impl.cancelAgent(1));
  await vi.waitFor(async () => expect(await storedSummary(user, workspaceId))
    .toMatchObject({waiting: {chats: 0, runs: 0, gadgets: []}}));
});

it("shows what a later turn asks, not a request a stopped turn left pending", async () => {
  const {workspace, owner} = await setup();
  const agent: AiChatAuthorInfo = {type: "agent", id: "model", name: "Model"};
  const summary = await withImpl(workspace, impl => {
    impl.addChatMessages(1, agent, [
      {type: "webFetchRequest", requestId: "1:a", url: "https://a.example.test/", state: "pending"},
    ]);
    impl.cancelAgent(1);
    impl.addChatMessages(1, owner, [{type: "message", message: "Try the other one"}]);
    impl.addChatMessages(1, agent, [
      {type: "webFetchRequest", requestId: "1:b", url: "https://b.example.test/", state: "pending"},
    ]);
    return impl.workspaceSummary();
  });
  expect(summary.waitingChats).toMatchObject([
    {chatId: 1, waiting: "action", ask: {type: "webFetch", url: "https://b.example.test/"}},
  ]);
});

it("pushes changes to the owner and admitted builders, and drops a summary when access narrows", async () => {
  const fixture = await setup();
  const {reader} = await addReader(fixture);
  const updates = new SummaryUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await reader.subscribeToWorkspaceSummaries(callback);

  await withImpl(fixture.workspace, impl => ask(impl, 0, {from: "gadget", gadgetId: 10}));
  const expected = {workspaceId: fixture.workspaceId,
    waiting: {runs: 0, chats: 0, gadgets: [{gadgetId: 10, actions: 1}]}, waitingChats: [],
    workingChatIds: [], hooks: []};
  await vi.waitFor(async () => expect(await storedSummary(fixture.user, fixture.workspaceId)).toEqual(expected));
  await vi.waitFor(async () => expect(await storedSummary(reader, fixture.workspaceId)).toEqual(expected));
  await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([fixture.workspaceId, expected]));

  // Narrowed to using a gadget: theirs goes, and a later push is refused.
  await reader.updateSharedWorkspaceRole(fixture.workspaceId, "use");
  await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([fixture.workspaceId, null]));
  await reader.syncWorkspaceListing(fixture.workspaceId, {listingRev: Number.MAX_SAFE_INTEGER, summary: expected});
  expect(await storedSummary(reader, fixture.workspaceId)).toBeUndefined();
});

// Background reads (the summary, unread previews) reach a "build" collaborator only once each
// chosen account is verified against what was recorded since their admission, checked right
// before the publish, once per profile however many publishes wait on it.
describe("background reads of an offline builder", () => {
  // The reader, admitted to a workspace with connection 7 (their account 1) and then offline.
  // The connection denies `denied`, or fails while `fail`; `checks` are the IDs it was asked
  // about, `previews` the users unread fanout reached, and `park` holds its answers back.
  const admitReader = async () => {
    const fixture = await setup();
    const {reader, profile} = await addReader(fixture);
    const state = {denied: new Set<string>(), fail: false, checks: [] as string[][],
      previews: [] as string[], park: Promise.resolve()};
    await withImpl(fixture.workspace, impl => {
      impl.storage.gatekeepers.put({id: 7, resourceTitle: "Docs", class: {} as never,
        creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7", typeUrlPattern: "https://*"}});
      impl.getGatekeeperFacet = async () => ({
        verifyObserverAccess: async (observers: {id: string}[], ids: string[]) => {
          state.checks.push(ids);
          await state.park;
          if (state.fail) throw new Error("provider down");
          return {allowedObserverIds: ids.some(id => state.denied.has(id)) ? [] : observers.map(({id}) => id)};
        },
      }) as never;
      const users = impl.users;
      impl.users = new Proxy(users, {get(target, key) {
        if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {get(user, member) {
          if (member === "getVerifier") return async () => ({});
          if (member === "messageArrived") return async () => { state.previews.push(id.toString()); };
          return Reflect.get(user, member);
        }});
        if (key === "idFromString") return (id: string) => target.idFromString(id);
        if (key === "idFromName") return (name: string) => target.idFromName(name);
        return Reflect.get(target, key);
      }});
      impl.storage.observers.put({profileId: profile.id, observerId: "obs-r",
        accountChoices: {7: {accountId: 1, verifiedThroughActionId: impl.storage.nextActionId.get() - 1}}});
    });
    const watermark = () => withImpl(fixture.workspace,
      impl => impl.storage.observers.get(profile.id)?.accountChoices[7]?.verifiedThroughActionId);
    return {fixture, reader, profile, state, watermark};
  };

  // A read through connection 7 the reader is not online for, and a change to the summary.
  const readAndAsk = async (impl: Impl, subresource: string) => {
    await impl.authorizeObservation(7, {title: "Read", description: "A read", subresources: [subresource]}, {from: "user"});
    ask(impl, impl.storage.nextActionId.get(), {from: "gadget", gadgetId: 10});
  };
  // Both background publishes, the listing pass and an unread fanout of chat 1, at once.
  const publishBoth = (impl: Impl) => {
    impl.storage.dirtyChats.put({chatId: 1, firstMessageSequence: 0, firstVisibleSequence: 1});
    return Promise.allSettled([impl.deliverUserUpdates(), impl.deliverDirtyChats()]);
  };
  const summaryActions = async (user: DurableObjectStub<UserDurableObject>, workspaceId: string) =>
    (await storedSummary(user, workspaceId))?.waiting.gadgets[0]?.actions;

  it("checks once for both publishes, then delivers or, once denied, withholds both without calling again", async () => {
    const {fixture, reader, profile, state, watermark} = await admitReader();
    const readerId = reader.id.toString();

    // Both publishes wait on one check of what is new, then deliver.
    const parked = Promise.withResolvers<void>();
    state.park = parked.promise;
    await withImpl(fixture.workspace, async impl => {
      using admission = vi.spyOn(impl, "mayReadChatState");
      await readAndAsk(impl, "doc:1");
      const both = publishBoth(impl);
      await vi.waitFor(() => expect(admission.mock.calls.filter(call => call[1] === profile.id).length).toBeGreaterThanOrEqual(2));
      parked.resolve();
      await both;
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.verifiedThroughActionId).toBe(impl.storage.nextActionId.get() - 1);
    });
    expect(state.checks).toEqual([["doc:1"]]);
    expect(state.previews).toContain(readerId);
    await vi.waitFor(async () => expect(await summaryActions(reader, fixture.workspaceId)).toBe(1));

    // Denied what is new: neither, and the summary they hold is cleared.
    state.denied.add("doc:2");
    state.previews = [];
    const checkedThrough = await watermark();
    await withImpl(fixture.workspace, async impl => {
      await readAndAsk(impl, "doc:2");
      await publishBoth(impl);
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.denied).toBe(true);
    });
    expect(state.checks).toEqual([["doc:1"], ["doc:2"]]);
    expect(state.previews).toEqual([fixture.user.id.toString()]);
    expect(await watermark()).toBe(checkedThrough);
    await vi.waitFor(async () => expect(await storedSummary(reader, fixture.workspaceId)).toBeUndefined());

    // Later publishes call nothing, and still withhold both.
    state.previews = [];
    await withImpl(fixture.workspace, async impl => {
      ask(impl, impl.storage.nextActionId.get(), {from: "gadget", gadgetId: 10});
      await publishBoth(impl);
    });
    await vi.waitFor(async () => expect(await summaryActions(fixture.user, fixture.workspaceId)).toBe(3));
    expect(state.checks).toHaveLength(2);
    expect(state.previews).toEqual([fixture.user.id.toString()]);
    expect(await storedSummary(reader, fixture.workspaceId)).toBeUndefined();
  });

  it("retries the summary alone, and both publishes, when the check fails, without counting it as a denial", async () => {
    const {fixture, reader, profile, state, watermark} = await admitReader();
    const readerId = reader.id.toString();
    const admittedAt = await watermark();
    state.fail = true;
    await withImpl(fixture.workspace, async impl => {
      // Owed outputs as well, which the failed check must not hold back.
      impl.storage.pendingUserUpdates.put({userId: readerId, profileId: profile.id, seq: 1, parts: ["outputs"]});
      await readAndAsk(impl, "doc:1");
      await publishBoth(impl);
      expect(impl.storage.pendingUserUpdates.get(readerId)?.parts).toEqual(["summary"]);
      expect(impl.storage.dirtyChats.get(1)?.failedRecipients?.map(({userId}) => userId)).toEqual([readerId]);
    });
    expect(await watermark()).toBe(admittedAt);
    expect(state.previews).not.toContain(readerId);
    expect(await storedSummary(reader, fixture.workspaceId)).toBeUndefined();

    state.fail = false;
    await withImpl(fixture.workspace, async impl => {
      await impl.userUpdateAttempt(readerId);
      await impl.deliverDirtyChats();
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.verifiedThroughActionId).toBe(impl.storage.nextActionId.get() - 1);
    });
    expect(state.previews).toContain(readerId);
    expect(await summaryActions(reader, fixture.workspaceId)).toBe(1);
  });
});

it("ignores a summary read before one already taken", async () => {
  const {user, workspaceId} = await setup();
  const summary = (actions: number): WorkspaceSummary => ({workspaceId,
    waiting: {runs: 0, chats: 0, gadgets: [{gadgetId: 10, actions}]}, waitingChats: [], workingChatIds: [], hooks: []});
  const newer = Number.MAX_SAFE_INTEGER;
  await user.syncWorkspaceListing(workspaceId, {listingRev: newer, summary: summary(2)});
  await user.syncWorkspaceListing(workspaceId, {listingRev: newer - 1, summary: summary(1)});
  expect(await storedSummary(user, workspaceId)).toEqual(summary(2));
});

it("gives a new subscriber the summaries kept", async () => {
  const fixture = await setup();
  await withImpl(fixture.workspace, impl => ask(impl, 0, {from: "agent", chatId: 1}));
  const expected = {workspaceId: fixture.workspaceId, waiting: {runs: 0, chats: 1, gadgets: []},
    waitingChats: [{chatId: 1, title: "Chat", lastActive: new Date(1), waiting: "approval",
      ask: {type: "action", title: "Action 0"}}],
    workingChatIds: [], hooks: []};
  await vi.waitFor(async () => expect(await storedSummary(fixture.user, fixture.workspaceId)).toEqual(expected));

  const updates = new SummaryUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await fixture.user.subscribeToWorkspaceSummaries(callback);
  await vi.waitFor(() => expect(updates.snapshots).toEqual([[expected]]));
});
