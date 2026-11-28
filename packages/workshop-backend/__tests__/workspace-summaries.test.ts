// A workspace's summary (the actions waiting, by gadget, and its hooks) is pushed by its Overseer
// into the User DO of the owner and of each "build" collaborator, as change messages, and served
// through subscribeToWorkspaceSummaries() without opening the workspace. Which chats are working
// or waiting on someone travels on their heads, through unread fanout, which only an admitted
// collaborator is sent. Runs against real Overseer and User DOs.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, Overseer, UnreadStateSubscriber, UnreadThread, UserUnreadState, WorkspaceSummary,
  WorkspaceSummarySubscriber,
} from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import type { GatekeeperCaller, StoredChatMessage } from "../src/storage-schema/overseer-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import type { WorkspaceListing } from "../src/workspace-listing.js";
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
// A member of a proxied User DO namespace, its methods bound to it as natives require.
const namespaceMember = (target: object, key: string | symbol) => {
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
};

const AGENT: AiChatAuthorInfo = {type: "agent", id: "model", name: "Model"};

type Fixture = {
  user: DurableObjectStub<UserDurableObject>;
  owner: AiChatAuthorInfo;
  workspace: DurableObjectStub<OverseerDurableObject>;
  workspaceId: string;
};

// An owner with one workspace holding a plain chat (1), a run gadget 11 started (2), and gadgets
// 10 and 11. Both chats predate enrollment, so every builder is sent them.
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

const storedAttention = (user: DurableObjectStub<UserDurableObject>, workspaceId: string) =>
  runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).workspaceAttention.get(workspaceId)?.waiting);

// A "build" collaborator, whose listing is recorded unless `recorded` is false.
const addReader = async (fixture: Fixture, recorded = true) => {
  const profile = {type: "user" as const, id: `reader-${crypto.randomUUID()}`, name: "Reader"};
  const reader = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(reader, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
  await withImpl(fixture.workspace, impl => impl.storage.collaborators.put({profile,
    addedBy: [{type: "user", sharer: fixture.owner.id, role: "build", created: new Date()}]}));
  if (recorded) await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", fixture.owner, "build", []);
  return {reader, profile};
};

// Records what the workspace sends `userId` of its listing, still delivering it.
const captureListings = (impl: Impl, userId: string) => {
  const sent: WorkspaceListing[] = [];
  const users = impl.users;
  impl.users = new Proxy(users, {get(target, key) {
    if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {get(user, member) {
      if (member === "syncWorkspaceListing" && id.toString() === userId) {
        return async (...args: Parameters<UserDurableObject["syncWorkspaceListing"]>) => {
          sent.push(args[1]);
          return await (user as DurableObjectStub<UserDurableObject>).syncWorkspaceListing(...args);
        };
      }
      return Reflect.get(user, member);
    }});
    return namespaceMember(target, key);
  }});
  return sent;
};

class SummaryUpdates extends RpcTarget implements WorkspaceSummarySubscriber {
  readonly snapshots: WorkspaceSummary[][] = [];
  readonly updates: [string, WorkspaceSummary | null][] = [];
  async snapshot(summaries: WorkspaceSummary[]) { this.snapshots.push(summaries); }
  async updated(workspaceId: string, summary: WorkspaceSummary | null) { this.updates.push([workspaceId, summary]); }
}

// A recent-chats subscriber, which keeps the snapshot it is given.
class UnreadUpdates extends RpcTarget implements UnreadStateSubscriber {
  readonly snapshots: UserUnreadState[] = [];
  async updated(state: UserUnreadState) { this.snapshots.push(state); }
  async summaryUpdated() {}
  async chatUpdated() {}
}

// The workspace's chats on `user`'s recent feed, by id.
const recentChats = async (user: DurableObjectStub<UserDurableObject>, workspaceId: string) => {
  const updates = new UnreadUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await user.subscribeToUnreadState("recent", callback);
  await vi.waitFor(() => expect(updates.snapshots).toHaveLength(1));
  return (updates.snapshots[0]!.chats as UnreadThread[]).filter(chat => chat.workspaceId === workspaceId)
    .toSorted((a, b) => a.chatId - b.chatId);
};
const recentChatIds = async (user: DurableObjectStub<UserDurableObject>, workspaceId: string) =>
  (await recentChats(user, workspaceId)).map(chat => chat.chatId);
const recentHead = async (user: DurableObjectStub<UserDurableObject>, workspaceId: string, chatId: number) =>
  (await recentChats(user, workspaceId)).find(chat => chat.chatId === chatId);

describe("attention", () => {
  it("counts each pending action once, for the gadget that asked or started the run", async () => {
    const {workspace, workspaceId, user} = await setup();
    await withImpl(workspace, impl => {
      ask(impl, 0, {from: "gadget", gadgetId: 10});
      ask(impl, 1, {from: "hook", gadgetId: 10});
      ask(impl, 2, {from: "agent", chatId: 2});
      // A chat no gadget started, decided, or asked by what is no gadget (any more): no gadget's.
      ask(impl, 3, {from: "agent", chatId: 1});
      ask(impl, 4, {from: "gadget", gadgetId: 10}, "approved");
      ask(impl, 5, {from: "gadget", gadgetId: 99});
      ask(impl, 6, {from: "gadget", gadgetId: 10, chatId: 1});
    });
    await vi.waitFor(async () => expect(await storedAttention(user, workspaceId))
      .toEqual([{gadgetId: 10, actions: 2}, {gadgetId: 11, actions: 1}]));
  });

  it("pushes changes to the owner and builders, and drops a summary when access narrows", async () => {
    const fixture = await setup();
    const {reader} = await addReader(fixture);
    const updates = new SummaryUpdates();
    using callback = new RpcStub(updates);
    using _subscription = await reader.subscribeToWorkspaceSummaries(callback);

    await withImpl(fixture.workspace, impl => ask(impl, 0, {from: "gadget", gadgetId: 10}));
    const expected = {workspaceId: fixture.workspaceId, waiting: [{gadgetId: 10, actions: 1}], hooks: []};
    await vi.waitFor(async () => expect(await storedAttention(fixture.user, fixture.workspaceId)).toEqual(expected.waiting));
    await vi.waitFor(async () => expect(await storedAttention(reader, fixture.workspaceId)).toEqual(expected.waiting));
    await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([fixture.workspaceId, expected]));

    // Narrowed to using a gadget: theirs goes, and a later push is refused.
    await reader.updateSharedWorkspaceRole(fixture.workspaceId, "use");
    await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([fixture.workspaceId, null]));
    await reader.syncWorkspaceListing(fixture.workspaceId, {listingRev: Number.MAX_SAFE_INTEGER, attention: expected.waiting});
    expect(await storedAttention(reader, fixture.workspaceId)).toBeUndefined();
  });

  it("ignores attention read before one already taken", async () => {
    const {user, workspaceId} = await setup();
    const newer = Number.MAX_SAFE_INTEGER;
    await user.syncWorkspaceListing(workspaceId, {listingRev: newer, attention: [{gadgetId: 10, actions: 2}]});
    await user.syncWorkspaceListing(workspaceId, {listingRev: newer - 1, attention: [{gadgetId: 10, actions: 1}]});
    expect(await storedAttention(user, workspaceId)).toEqual([{gadgetId: 10, actions: 2}]);
  });

  it("gives a new subscriber the summaries kept", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, impl => ask(impl, 0, {from: "gadget", gadgetId: 11}));
    const expected = {workspaceId: fixture.workspaceId, waiting: [{gadgetId: 11, actions: 1}], hooks: []};
    await vi.waitFor(async () => expect(await storedAttention(fixture.user, fixture.workspaceId)).toEqual(expected.waiting));

    const updates = new SummaryUpdates();
    using callback = new RpcStub(updates);
    using _subscription = await fixture.user.subscribeToWorkspaceSummaries(callback);
    await vi.waitFor(() => expect(updates.snapshots).toEqual([[expected]]));
  });
});

describe("hooks", () => {
  it("sends each hook bound, changed or unbound alone", async () => {
    const fixture = await setup();
    const updates = new SummaryUpdates();
    using callback = new RpcStub(updates);
    using _subscription = await fixture.user.subscribeToWorkspaceSummaries(callback);
    const ownerId = fixture.user.id.toString();
    const hook = (enabled: boolean) => ({id: 0, actionId: 0, gatekeeperId: 10, gadgetId: 10,
      controller: {} as never, callback: {} as never, description: {title: "On push", description: "Runs on push"}, enabled});
    const sent = await withImpl(fixture.workspace, async impl => {
      const sent = captureListings(impl, ownerId);
      impl.storage.boundHooks.put(hook(true));
      impl.storage.boundHooks.put({...hook(true), id: 1});
      await impl.userUpdateAttempt(ownerId);
      return sent;
    });
    expect(sent.filter(listing => listing.hooks).map(listing => listing.hooks!.map(({id}) => id))).toEqual([[0, 1]]);

    const edited = await withImpl(fixture.workspace, async impl => {
      const sent = captureListings(impl, ownerId);
      impl.storage.boundHooks.put(hook(false));
      await impl.userUpdateAttempt(ownerId);
      impl.storage.boundHooks.delete(1);
      await impl.userUpdateAttempt(ownerId);
      return sent;
    });
    expect(edited.filter(listing => listing.hooks).map(listing => listing.hooks)).toEqual([
      [{id: 0, hook: expect.objectContaining({id: 0, enabled: false})}],
      [{id: 1, hook: null}],
    ]);
    expect(edited.every(listing => listing.attention === undefined)).toBe(true);
    await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([fixture.workspaceId, {workspaceId: fixture.workspaceId,
      waiting: [], hooks: [expect.objectContaining({id: 0, enabled: false})]}]));
  });

  it("sends every hook to a builder once their listing is resynced", async () => {
    const fixture = await setup();
    const {reader, profile} = await addReader(fixture);
    const readerId = reader.id.toString();
    await withImpl(fixture.workspace, async impl => {
      impl.storage.boundHooks.put({id: 3, actionId: 0, gatekeeperId: 10, gadgetId: 10,
        controller: {} as never, callback: {} as never, description: {title: "On push", description: "Runs on push"}, enabled: true});
      await impl.deliverUserUpdates();
      impl.resyncListingTo(readerId, profile.id);
      await impl.userUpdateAttempt(readerId);
    });
    const updates = new SummaryUpdates();
    using callback = new RpcStub(updates);
    using _subscription = await reader.subscribeToWorkspaceSummaries(callback);
    await vi.waitFor(() => expect(updates.snapshots).toEqual([[{workspaceId: fixture.workspaceId,
      waiting: [], hooks: [expect.objectContaining({id: 3})]}]]));
  });
});

describe("a chat's head", () => {
  // Gives `user` a cursor for chat 1 by a message there, so head-only updates reach it.
  const track = async (fixture: Fixture, user = fixture.user) => {
    await withImpl(fixture.workspace, impl => impl.addChatMessages(1, fixture.owner, [{type: "message", message: "Hi"}]));
    await vi.waitFor(async () => expect(await recentChatIds(user, fixture.workspaceId)).toContain(1));
  };

  it("sends no hooks and no attention for a turn starting and ending", async () => {
    const fixture = await setup();
    await track(fixture);
    const ownerId = fixture.user.id.toString();
    const sent = await withImpl(fixture.workspace, async impl => {
      const sent = captureListings(impl, ownerId);
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: AGENT});
      await Promise.all([impl.deliverUserUpdates(), impl.deliverDirtyChats()]);
      impl.cancelAgent(1);
      await Promise.all([impl.deliverUserUpdates(), impl.deliverDirtyChats()]);
      return sent;
    });
    expect(sent.filter(listing => listing.hooks !== undefined || listing.attention !== undefined)).toEqual([]);
  });

  it("says the agent is working from a turn's start until it is stopped", async () => {
    const fixture = await setup();
    await track(fixture);
    await withImpl(fixture.workspace, impl =>
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: AGENT}));
    await vi.waitFor(async () => expect((await recentHead(fixture.user, fixture.workspaceId, 1))?.working).toBe(true));

    await withImpl(fixture.workspace, impl => impl.cancelAgent(1));
    await vi.waitFor(async () => expect(await recentHead(fixture.user, fixture.workspaceId, 1)).not.toHaveProperty("working"));
  });

  it("says the agent is working through a callback's turn that writes no text", async () => {
    const fixture = await setup();
    await track(fixture);
    const ownerId = fixture.user.id.toString();
    await withImpl(fixture.workspace, async impl => {
      const users = impl.users;
      impl.users = new Proxy(users, {get(target, key) {
        if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {get(user, member) {
          if (member === "getChatContext") {
            return async () => ({profile: fixture.owner,
              aiModel: {profile: AGENT, config: {provider: "cloudflare", model: "@cf/test/model", apiToken: ""}}});
          }
          return Reflect.get(user, member);
        }});
        return namespaceMember(target, key);
      }});
      // The turn the call starts never runs, so all the chat gains is the callback, which no head shows.
      vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      await impl.deliverAgentCallback(1, "ping", [], ownerId, "model");
      await vi.waitFor(() => expect(impl.storage.chatMeta.get(1)?.activeAgent).toEqual(AGENT));
    });
    await vi.waitFor(async () => expect((await recentHead(fixture.user, fixture.workspaceId, 1))?.working).toBe(true));
    expect((await recentHead(fixture.user, fixture.workspaceId, 1))?.latestMessagePreview).toBe("Hi");

    await withImpl(fixture.workspace, impl => impl.cancelAgent(1));
    await vi.waitFor(async () => expect(await recentHead(fixture.user, fixture.workspaceId, 1)).not.toHaveProperty("working"));
  });

  it("says what a paused chat asks the user asked, enrolled or not, until it is answered", async () => {
    const fixture = await setup();
    const {reader} = await addReader(fixture);
    const readerId = reader.id.toString();
    // A new chat, which nobody is enrolled in: only the person asked hears of it.
    await withImpl(fixture.workspace, impl => {
      impl.storage.nextChatSequences.put({chatId: 3, nextSequence: 0, notificationParticipants: []});
      impl.storage.chatMeta.put({id: 3, title: "Connect", started: new Date(3), lastActive: new Date(3), activeAgent: AGENT});
      impl.addChatMessages(3, AGENT, [{type: "connectionRequest", requestId: "3:c", vendorId: "github",
        vendorName: "GitHub", reason: "To read issues", state: "pending"}]);
      // The turn ends waiting on the request, asking the reader.
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(3)!, activeAgent: undefined});
      impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 3,
        sequence: impl.nextChatSequencePeek(3) - 1, userId: readerId, kind: "permissionRequested"});
    });
    await vi.waitFor(async () => expect((await recentHead(reader, fixture.workspaceId, 3))?.waiting)
      .toEqual({kind: "action", ask: {type: "connection", vendorName: "GitHub", reason: "To read issues"}}));
    expect(await recentChatIds(fixture.user, fixture.workspaceId)).not.toContain(3);

    // Answered: a head-only update, which reaches them all the same.
    await withImpl(fixture.workspace, impl => {
      const request = [...impl.storage.chats.list()].find(msg => msg.chatId === 3 && msg.type === "connectionRequest")!;
      impl.storage.chats.put({...request, state: "approved"} as StoredChatMessage);
    });
    await vi.waitFor(async () => expect(await recentHead(reader, fixture.workspaceId, 3)).not.toHaveProperty("waiting"));
  });

  it("sends what a chat waiting at the version-8 upgrade asks, once the workspace restarts", async () => {
    const fixture = await setup();
    const {reader} = await addReader(fixture);
    const readerId = reader.id.toString();
    await withImpl(fixture.workspace, async impl => {
      impl.storage.nextChatSequences.put({chatId: 3, nextSequence: 0, notificationParticipants: []});
      impl.storage.chatMeta.put({id: 3, title: "Connect", started: new Date(3), lastActive: new Date(3)});
      impl.addChatMessages(3, AGENT, [{type: "connectionRequest", requestId: "3:c", vendorId: "github",
        vendorName: "GitHub", reason: "To read issues", state: "pending"}]);
      impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 3,
        sequence: impl.nextChatSequencePeek(3) - 1, userId: readerId, kind: "permissionRequested"});
      // Version 7 delivered the notification, so the reader has the chat, but no waiting state.
      await impl.deliverDirtyChats();
      // As version 7 left it: nothing recorded what the chat waits on.
      impl.ownerId = undefined;
      const {waiting: _waiting, headStateAt: _at, askedUsers: _asked, ...counter} = impl.storage.nextChatSequences.get(3)!;
      impl.storage.nextChatSequences.put(counter);
      impl.storage.dirtyChats.delete(3);
      impl.storage.version.put(7);
    });
    await vi.waitFor(async () => expect(await recentHead(reader, fixture.workspaceId, 3)).toBeDefined());
    expect(await recentHead(reader, fixture.workspaceId, 3)).not.toHaveProperty("waiting");
    // A reset, not an eviction: eviction waits out the minute's timer the message's activity listing
    // may have armed.
    await expect(runInDurableObject(fixture.workspace, (_instance, ctx) => ctx.abort("Restart")))
      .rejects.toThrow("Restart");
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
      expect(impl.storage.nextChatSequences.get(3)?.askedUsers).toEqual([readerId]);
      await vi.waitFor(() => expect(impl.storage.nextChatSequences.get(3)?.waiting).toBeDefined());
      await impl.deliverDirtyChats();
    });
    await vi.waitFor(async () => expect((await recentHead(reader, fixture.workspaceId, 3))?.waiting)
      .toEqual({kind: "action", ask: {type: "connection", vendorName: "GitHub", reason: "To read issues"}}));
  });

  it("says a chat waits for approval of its own action, by its title", async () => {
    const fixture = await setup();
    await track(fixture);
    await withImpl(fixture.workspace, impl => ask(impl, 0, {from: "agent", chatId: 1}));
    await vi.waitFor(async () => expect((await recentHead(fixture.user, fixture.workspaceId, 1))?.waiting)
      .toEqual({kind: "approval", ask: {type: "action", title: "Action 0"}}));

    await withImpl(fixture.workspace, impl =>
      impl.storage.actions.put({...impl.storage.actions.get(0)!, state: "approved"}));
    await vi.waitFor(async () => expect(await recentHead(fixture.user, fixture.workspaceId, 1)).not.toHaveProperty("waiting"));
  });
});

// Background reads (chat heads, previews) reach a "build" collaborator only once each chosen
// account is verified against what was recorded since their admission, checked right before the
// publish, once per profile however many publishes wait on it. Attention and hooks are not
// background reads: they go out on the role alone.
describe("background reads of an offline builder", () => {
  // The reader, admitted to a workspace with connection 7 (their account 1) and then offline, and
  // listed unless `recorded` is false. The connection denies `denied`, or fails while `fail`;
  // `checks` are the IDs it was asked about, `previews` the users unread fanout reached, and `park`
  // holds its answers back; `whileChecking` runs before each answer.
  const admitReader = async (recorded = true) => {
    const fixture = await setup();
    const {reader, profile} = await addReader(fixture, recorded);
    const state = {denied: new Set<string>(), fail: false, checks: [] as string[][],
      previews: [] as string[], park: Promise.resolve(), whileChecking: (): void => {}};
    await withImpl(fixture.workspace, impl => {
      impl.storage.gatekeepers.put({id: 7, resourceTitle: "Docs", class: {} as never,
        creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7", typeUrlPattern: "https://*"}});
      impl.getGatekeeperFacet = async () => ({
        addObserver: async () => {},
        verifyObserverAccess: async (observers: {id: string}[], ids: string[]) => {
          state.checks.push(ids);
          await state.park;
          state.whileChecking();
          if (state.fail) throw new Error("provider down");
          return {allowedObserverIds: ids.some(id => state.denied.has(id)) ? [] : observers.map(({id}) => id)};
        },
      }) as never;
      const users = impl.users;
      impl.users = new Proxy(users, {get(target, key) {
        if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {get(user, member) {
          if (member === "getVerifier") return async () => ({});
          if (member === "messageArrived") {
            return async (...args: Parameters<UserDurableObject["messageArrived"]>) => {
              state.previews.push(id.toString());
              return await (user as DurableObjectStub<UserDurableObject>).messageArrived(...args);
            };
          }
          return Reflect.get(user, member);
        }});
        if (key === "idFromString") return (id: string) => target.idFromString(id);
        if (key === "idFromName") return (name: string) => target.idFromName(name);
        return namespaceMember(target, key);
      }});
      impl.storage.observers.put({profileId: profile.id, observerId: "obs-r",
        accountChoices: {7: {accountId: 1, verifiedThroughActionId: impl.storage.nextActionId.get() - 1}}});
    });
    const watermark = () => withImpl(fixture.workspace,
      impl => impl.storage.observers.get(profile.id)?.accountChoices[7]?.verifiedThroughActionId);
    return {fixture, reader, profile, state, watermark};
  };

  // A read through connection 7 the reader is not online for, and a pending action of gadget 10.
  const readAndAsk = async (impl: Impl, subresource: string) => {
    await impl.authorizeObservation(7, {title: "Read", description: "A read", subresources: [subresource]}, {from: "user"});
    ask(impl, impl.storage.nextActionId.get(), {from: "gadget", gadgetId: 10});
  };
  // The listing pass and an unread fanout of both chats, at once.
  const publish = (impl: Impl) => {
    for (let chatId of [1, 2]) impl.addChatMessages(chatId, AGENT, [{type: "message", message: "Done."}]);
    return Promise.allSettled([impl.deliverUserUpdates(), impl.deliverDirtyChats()]);
  };
  const attentionActions = async (user: DurableObjectStub<UserDurableObject>, workspaceId: string) =>
    (await storedAttention(user, workspaceId))?.[0]?.actions;
  const chatSeedPending = (user: DurableObjectStub<UserDurableObject>, workspaceId: string) =>
    runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).gadgets.get(workspaceId)?.chatSeedPending);

  it("checks once for every publish, then delivers or, once denied, withholds previews without calling again", async () => {
    const {fixture, reader, profile, state, watermark} = await admitReader();
    const readerId = reader.id.toString();

    // Both chats' fanouts wait on one check of what is new, then deliver.
    const parked = Promise.withResolvers<void>();
    state.park = parked.promise;
    await withImpl(fixture.workspace, async impl => {
      using admission = vi.spyOn(impl, "mayReadChatState");
      await readAndAsk(impl, "doc:1");
      const both = publish(impl);
      await vi.waitFor(() => expect(admission.mock.calls.some(call => call[1] === profile.id)).toBe(true));
      parked.resolve();
      await both;
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.verifiedThroughActionId).toBe(impl.storage.nextActionId.get() - 1);
    });
    expect(state.checks).toEqual([["doc:1"]]);
    expect(state.previews).toContain(readerId);
    await vi.waitFor(async () => expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2]));
    await vi.waitFor(async () => expect(await attentionActions(reader, fixture.workspaceId)).toBe(1));

    // Denied what is new: no previews, and their account keeps the chats it holds of the
    // workspace and is told an open is required, owing what began meanwhile to the next open that
    // admits them. Attention still reaches them.
    state.denied.add("doc:2");
    state.previews = [];
    const checkedThrough = await watermark();
    await withImpl(fixture.workspace, async impl => {
      await readAndAsk(impl, "doc:2");
      await publish(impl);
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.denied).toBe(true);
      await impl.userUpdateAttempt(readerId);
    });
    expect(state.checks).toEqual([["doc:1"], ["doc:2"]]);
    expect(state.previews.every(id => id === fixture.user.id.toString())).toBe(true);
    expect(await watermark()).toBe(checkedThrough);
    expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2]);
    expect(await reader.getWorkspace(fixture.workspaceId)).toMatchObject(
      {chatAccessRequired: [expect.objectContaining({gatekeeperId: 7, reason: "denied"})]});
    expect(await chatSeedPending(reader, fixture.workspaceId)).toBe(true);
    await vi.waitFor(async () => expect(await attentionActions(reader, fixture.workspaceId)).toBe(2));

    // Later publishes call nothing, and still withhold previews.
    state.previews = [];
    await withImpl(fixture.workspace, async impl => {
      ask(impl, impl.storage.nextActionId.get(), {from: "gadget", gadgetId: 10});
      await publish(impl);
    });
    await vi.waitFor(async () => expect(await attentionActions(fixture.user, fixture.workspaceId)).toBe(3));
    await vi.waitFor(async () => expect(await attentionActions(reader, fixture.workspaceId)).toBe(3));
    expect(state.checks).toHaveLength(2);
    expect(state.previews.every(id => id === fixture.user.id.toString())).toBe(true);
    expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2]);
  });

  it("retries previews when the check fails, without counting it as a denial, and sends attention regardless", async () => {
    const {fixture, reader, profile, state, watermark} = await admitReader();
    const readerId = reader.id.toString();
    const admittedAt = await watermark();
    state.fail = true;
    await withImpl(fixture.workspace, async impl => {
      await readAndAsk(impl, "doc:1");
      await publish(impl);
      expect(impl.storage.dirtyChats.get(1)?.failedRecipients?.map(({userId}) => userId)).toEqual([readerId]);
    });
    expect(await watermark()).toBe(admittedAt);
    expect(state.previews).not.toContain(readerId);
    await vi.waitFor(async () => expect(await attentionActions(reader, fixture.workspaceId)).toBe(1));
    expect(await chatSeedPending(reader, fixture.workspaceId)).toBeUndefined();

    state.fail = false;
    await withImpl(fixture.workspace, async impl => {
      await impl.deliverDirtyChats();
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.verifiedThroughActionId).toBe(impl.storage.nextActionId.get() - 1);
    });
    expect(state.previews).toContain(readerId);
  });

  it("keeps a denial recorded while a background check of the same account and watermark awaits", async () => {
    const {fixture, reader, profile, state, watermark} = await admitReader();
    const admittedAt = await watermark();
    const parked = Promise.withResolvers<void>();
    state.park = parked.promise;
    await withImpl(fixture.workspace, async impl => {
      await readAndAsk(impl, "doc:1");
      const both = publish(impl);
      await vi.waitFor(() => expect(state.checks).toEqual([["doc:1"]]));
      // A refused reopen denies the choice meanwhile (see ensureObserver), keeping its account and
      // watermark; the check it raced then allows what it was asked about.
      const record = impl.storage.observers.get(profile.id)!;
      impl.storage.observers.put({...record, accountChoices: {7: {...record.accountChoices[7]!, denied: true}}});
      parked.resolve();
      await both;
      expect(impl.storage.observers.get(profile.id)?.accountChoices[7])
        .toEqual({accountId: 1, verifiedThroughActionId: admittedAt, denied: true});
    });
    expect(state.previews).not.toContain(reader.id.toString());
  });

  it("sends no chat state a check admitted after the workspace's deletion began", async () => {
    const {fixture, reader, state} = await admitReader();
    const readerId = reader.id.toString();
    const parked = Promise.withResolvers<void>();
    state.park = parked.promise;
    await withImpl(fixture.workspace, async impl => {
      await readAndAsk(impl, "doc:1");
      const both = publish(impl);
      await vi.waitFor(() => expect(state.checks).toEqual([["doc:1"]]));
      impl.beginDeletion(new Set([readerId, fixture.user.id.toString()]));
      parked.resolve();
      await both;
    });
    expect(state.previews).not.toContain(readerId);
  });

  // A shared open hands the reader's User DO the chats' starting points, which carry their heads,
  // only through the same check as the other background reads.
  describe("a shared open's chat starting points", () => {
    // Opens the workspace as the reader through their real admission, closes that session while
    // the owner's profile is fetched for the open's handoff, runs `meanwhile`, and returns what the
    // handoff recorded in the reader's User DO: the starting points, and the IDs connection 7 had
    // been asked about by then.
    const openAcross = (fixture: Fixture, reader: DurableObjectStub<UserDurableObject>,
        profile: {id: string}, state: {checks: string[][]},
        meanwhile: (impl: Impl) => Promise<void> | void = () => {}) =>
      runInDurableObject(env.TEST_OVERSEER.get(fixture.workspace.id), async (instance: OverseerDurableObject) => {
        const impl = instance.impl;
        const readerId = reader.id.toString(), ownerId = fixture.user.id.toString();
        // No account provides anything here, and this environment has no deployment settings to say.
        impl.ensureAmbientCapsules = async () => {};
        // Only the handoff asks the owner's User DO for their profile once this is cached.
        await impl.getOwnerProfileId();
        const fetching = Promise.withResolvers<void>(), fetched = Promise.withResolvers<void>();
        const recorded = Promise.withResolvers<{baselines: unknown, checks: string[][]}>();
        const users = impl.users;
        impl.users = new Proxy(users, {get(target, key) {
          if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {get(user, member) {
            if (member === "whoami" && id.toString() === ownerId) {
              return async () => { fetching.resolve(); await fetched.promise; return fixture.owner; };
            }
            if (member === "recordSharedWorkspaceOpen" && id.toString() === readerId) {
              return async (...args: Parameters<UserDurableObject["recordSharedWorkspaceOpen"]>) => {
                const checks = [...state.checks];
                await (user as DurableObjectStub<UserDurableObject>).recordSharedWorkspaceOpen(...args)
                  .then(() => recorded.resolve({baselines: args[4], checks}), recorded.reject);
              };
            }
            return Reflect.get(user, member);
          }});
          return namespaceMember(target, key);
        }});
        try {
          using closed = new NativeRpcStub<() => void>(() => {});
          const session = await instance.open(readerId, profile.id, closed) as Overseer & Disposable;
          await fetching.promise;
          session[Symbol.dispose]();
          await meanwhile(impl);
          fetched.resolve();
          return await recorded.promise;
        } finally {
          impl.users = users;
        }
      });
    const readDoc2 = (impl: Impl) =>
      impl.authorizeObservation(7, {title: "Read", description: "A read", subresources: ["doc:2"]}, {from: "user"});

    it.each([false, true])("checks a requirement recorded after the admitting session closed before handing them over (denied: %s)",
        async denied => {
      const {fixture, reader, profile, state} = await admitReader(false);
      if (denied) state.denied.add("doc:2");
      const {baselines, checks} = await openAcross(fixture, reader, profile, state, async impl => {
        await readDoc2(impl);
        // Recorded without asking about them: no session of theirs is open.
        expect(state.checks).toEqual([]);
      });
      expect(checks).toEqual([["doc:2"]]);
      expect(baselines).toEqual(denied ? null : [
        expect.objectContaining({chatId: 1, head: expect.objectContaining({chatTitle: "Chat"})}),
        expect.objectContaining({chatId: 2, head: expect.objectContaining({chatTitle: "Run"})}),
      ]);
      expect(await reader.getWorkspace(fixture.workspaceId)).toMatchObject({role: "build"});
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual(denied ? [] : [1, 2]);
    });

    it("hands none over to a builder found denied while the owner's profile is fetched, asking nothing more", async () => {
      const {fixture, reader, profile, state} = await admitReader(false);
      state.denied.add("doc:2");
      const {baselines, checks} = await openAcross(fixture, reader, profile, state, async impl => {
        await readDoc2(impl);
        impl.storage.dirtyChats.put({chatId: 1, firstMessageSequence: 0, firstVisibleSequence: 1});
        await impl.deliverDirtyChats();
        expect(impl.storage.observers.get(profile.id)?.accountChoices[7]?.denied).toBe(true);
      });
      expect(checks).toEqual([["doc:2"]]);
      expect(baselines).toBeNull();
      expect(await reader.getWorkspace(fixture.workspaceId)).toMatchObject({role: "build"});
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([]);
    });

    it("records the listing without them when the check fails", async () => {
      const {fixture, reader, profile, state} = await admitReader(false);
      const {baselines, checks} = await openAcross(fixture, reader, profile, state, async impl => {
        state.fail = true;
        await readDoc2(impl);
      });
      expect(checks).toEqual([["doc:2"]]);
      expect(baselines).toBeNull();
      expect(await reader.getWorkspace(fixture.workspaceId)).toMatchObject({role: "build"});
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([]);
    });

    it("hands none over to a collaborator who uses a gadget", async () => {
      const {fixture, reader, profile, state} = await admitReader(false);
      await withImpl(fixture.workspace, impl => impl.storage.collaborators.put({profile,
        addedBy: [{type: "user", sharer: fixture.owner.id, role: "use", gadgetId: 10, created: new Date()}]}));
      const {baselines} = await openAcross(fixture, reader, profile, state);
      expect(baselines).toBeNull();
      expect(await reader.getWorkspace(fixture.workspaceId)).toMatchObject({role: "use"});
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([]);
    });

    it("drops a chat deleted while they are checked, reading nothing of it again", async () => {
      const {fixture, reader, profile, state} = await admitReader(false);
      const {baselines} = await openAcross(fixture, reader, profile, state, async impl => {
        await readDoc2(impl);
        // Not listed yet, the reader ignores the deletion's notice.
        state.whileChecking = () => { impl.storage.chatMeta.delete(2); };
      });
      expect(baselines).toEqual([expect.objectContaining({chatId: 1})]);
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1]);
    });

    it("seeds what a denied open withheld at the next open admitted to them", async () => {
      const {fixture, reader, profile, state} = await admitReader(false);
      state.denied.add("doc:2");
      await openAcross(fixture, reader, profile, state, readDoc2);
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([]);

      // Allowed now: the next admission verifies them again.
      state.denied.delete("doc:2");
      await openAcross(fixture, reader, profile, state);
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2]);
    });

    it("tells them an open is required on a denial, keeping their chats, and clears it at the next admitted open, seeding chats begun meanwhile", async () => {
      const {fixture, reader, profile, state} = await admitReader();
      await withImpl(fixture.workspace, impl => publish(impl));
      await vi.waitFor(async () => expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2]));

      state.denied.add("doc:2");
      await withImpl(fixture.workspace, async impl => {
        await readDoc2(impl);
        await publish(impl);
        await impl.userUpdateAttempt(reader.id.toString());
        // Begun while they are paused: nothing of it reaches them.
        impl.storage.chatMeta.put({id: 3, title: "Later", started: new Date(3), lastActive: new Date(3)});
        impl.addChatMessages(3, AGENT, [{type: "message", message: "New."}]);
        await impl.deliverDirtyChats();
      });
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2]);
      expect((await reader.getWorkspace(fixture.workspaceId))?.chatAccessRequired).toEqual(
        [{gatekeeperId: 7, vendorId: "testvendor", reason: "denied"}]);

      state.denied.delete("doc:2");
      await openAcross(fixture, reader, profile, state);
      expect(await recentChatIds(reader, fixture.workspaceId)).toEqual([1, 2, 3]);
      await withImpl(fixture.workspace, impl => impl.userUpdateAttempt(reader.id.toString()));
      await vi.waitFor(async () =>
        expect(await reader.getWorkspace(fixture.workspaceId)).not.toHaveProperty("chatAccessRequired"));
    });

    it("tells them an open is required for a connection added since they chose accounts", async () => {
      const {fixture, reader} = await admitReader();
      await withImpl(fixture.workspace, async impl => {
        impl.storage.gatekeepers.put({id: 8, resourceTitle: "More", class: {} as never,
          creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/8", typeUrlPattern: "https://*"}});
        await impl.userUpdateAttempt(reader.id.toString());
      });
      expect((await reader.getWorkspace(fixture.workspaceId))?.chatAccessRequired).toEqual(
        [{gatekeeperId: 8, vendorId: "testvendor", reason: "notChosen"}]);
    });
  });
});
