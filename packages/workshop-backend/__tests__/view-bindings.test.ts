// Overseer.connectToChatBinding() (plans/live-views.md, "A view's env"): a name of a chat's scope as
// an `<inline-html env="...">` view's code reaches it. Saved data comes back as its JSON. A gadget
// is the facet the chat's agent reaches through the name. A connection the user made is a session
// with the view as caller: its reads stay out of the chat, its writes wait there for a person, it
// binds no hooks, and it ends with the chat.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

const waitFor = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CHAT_ID = 1;
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER: AiChatAuthorInfo = { type: "user", id: "owner-profile", name: "Owner" };
const EXPENSES_ID = 100;
const GITHUB_ID = 200;

// The chat's seed bindings: a gadget, a worktree, and a gatekeeper of each kind.
const SEED = { EXPENSES: EXPENSES_ID, REPO: 7, GITHUB: GITHUB_ID, MODEL: 201, AGENTS: 202,
    SEARCH: 203, LEGACY: 204 };
const GATEKEEPERS = [
  { id: GITHUB_ID, class: {},
    creationSpec: { type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/*" } },
  { id: 201, class: {},
    creationSpec: { type: "aiModel", modelId: "m", provider: "anthropic", modelName: "claude" } },
  { id: 202, class: {},
    creationSpec: { type: "agentSpawner", config: { displayName: "Agents", modelId: "m" } } },
  { id: 203, class: {}, creationSpec: { type: "ambient", vendorId: "websearch", accountId: 1 } },
  // Made before blueprint support.
  { id: 204, class: {} },
];

const SERVER_JS = `
import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  total() { return 1200; }
}
`;

// A capability a session hands out, sharing its queue, as a GitHub cursor does.
class FakeCursor extends RpcTarget {
  constructor(readonly queue: ApprovalQueue) { super(); }
  async next() {
    await this.queue.authorizeObservation({ title: "Read the next issue", description: "Issue 13." });
    return "#13";
  }
}

// The session a gatekeeper returns, behind a real stub as in production.
class FakeSession extends RpcTarget {
  disposed = false;
  constructor(readonly queue: ApprovalQueue) { super(); }
  listIssues() { return ["#12"]; }
  // A member reached through a property, as `session.issues.list()`.
  get issues() { return { list: () => ["#12"] }; }
  openCursor() { return new FakeCursor(this.queue); }
  [Symbol.dispose]() { this.disposed = true; }
}

const hookStub = () => new RpcStub(new (class extends RpcTarget { fire() {} })());

let doCounter = 0;

type Fixture = {
  impl: any;
  // Opens a client interface: the owner's, a "build" collaborator's, or a "use" collaborator's.
  open: (as: "owner" | "collaborator" | "user") => Promise<Overseer>;
  sessions: FakeSession[];
  // Session kinds joined and left through joinSession.
  joined: string[];
  left: string[];
};

async function withChat(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`view-bindings-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let timestamp = impl.getChatTimestamp();
    impl.ownerId = "owner-user-do";
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => ({ profile: USER }) }),
    };
    impl.storage.chatMeta.put({ id: CHAT_ID, title: "Views", started: timestamp, lastActive: timestamp });
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: SEED });
    let commitId = await impl.gitCache.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [], author: { name: "Owner", email: "owner@example.com" }, message: "v1",
      timestamp: new Date(0),
    });
    impl.storage.gadgets.put({ type: "gadget", id: EXPENSES_ID, title: "Expenses", created: new Date(0),
        bindingName: "EXPENSES", bindings: {}, commitId });
    impl.storage.gadgets.put({ type: "worktree", id: 7, title: "Repo", created: new Date(0),
        chatId: CHAT_ID, baseCommit: "c", headCommit: "c", pinBase: "c" });
    for (let record of GATEKEEPERS) impl.storage.gatekeepers.put(record);
    impl.addChatMessages(CHAT_ID, USER, [{ type: "message", message: "Chart my spending" }]);

    let sessions: FakeSession[] = [];
    impl.getGatekeeperFacet = async () => ({
      startSession: async (queue: ApprovalQueue) => {
        let session = new FakeSession(queue);
        sessions.push(session);
        return new RpcStub(session);
      },
    });
    let joined: string[] = [];
    let left: string[] = [];
    let joinSession = impl.joinSession.bind(impl);
    impl.joinSession = (kind: string, gadgetId?: number) => {
      joined.push(kind);
      let leave = joinSession(kind, gadgetId);
      return () => {
        left.push(kind);
        leave();
      };
    };

    let open = (as: "owner" | "collaborator" | "user") => openFakeOverseer({ chatMeta: { list: () => [] } }, {
      // Anyone but the owner opens as a collaborator.
      ...(as !== "owner" && { userId: "collaborator-id" }),
      ...(as === "user" && { role: "use" }),
      impl: { openViewBinding: impl.openViewBinding.bind(impl) },
    });
    await fn({ impl, open, sessions, joined, left });
  });
}

function chatActions(impl: any): number[] {
  return [...impl.storage.chats.list()].flatMap(msg => msg.type === "action" ? [msg.actionId] : []);
}

// An agent message whose executeCode call saved TOTALS, and SALES as another name for EXPENSES.
const saved = { type: "message", message: "Saved.", toolCalls: [{
  toolCallId: "t1", toolName: "executeCode", input: { code: "" }, output: "",
  savedEnv: [{ name: "TOTALS" }, { name: "SALES", alias: "EXPENSES" }],
}] };

describe("connectToChatBinding", () => {
  it("refuses a name the chat does not bind, and every binding but data, a gadget or a user's connection",
      () => withChat(async ({ open, sessions }) => {
    let client = await open("owner");
    await expect(client.connectToChatBinding(CHAT_ID, "NOPE"))
        .rejects.toThrow(/"NOPE" is not a binding in this chat/);
    for (let name of ["REPO", "MODEL", "AGENTS", "SEARCH", "LEGACY"]) {
      await expect(client.connectToChatBinding(CHAT_ID, name))
          .rejects.toThrow(`"${name}" can't be used in a view.`);
    }
    expect(sessions).toEqual([]);
    await expect((await open("user")).connectToChatBinding(CHAT_ID, "EXPENSES")).rejects.toThrow();
  }));

  it("returns saved data as its JSON, and another name as the binding it names",
      () => withChat(async ({ impl, open }) => {
    impl.addChatMessages(CHAT_ID, AGENT, [saved]);
    impl.storage.chatSavedData.put({ chatId: CHAT_ID, name: "TOTALS", json: '{"north":1200}' });
    let client = await open("owner");
    expect(await client.connectToChatBinding(CHAT_ID, "TOTALS")).toEqual({ type: "data", json: '{"north":1200}' });
    let sales = await client.connectToChatBinding(CHAT_ID, "SALES");
    if (sales.type !== "gadget") throw new Error("expected a gadget");
    expect(await sales.rpc.total()).toBe(1200);
  }));

  it("opens the chat's gadget, counted toward a collaborator's session until disposed",
      () => withChat(async ({ open, joined, left }) => {
    let gadget = await (await open("collaborator")).connectToChatBinding(CHAT_ID, "EXPENSES");
    if (gadget.type !== "gadget") throw new Error("expected a gadget");
    expect(await gadget.rpc.total()).toBe(1200);
    expect(joined).toEqual(["build"]);
    gadget.rpc[Symbol.dispose]();
    await waitFor(() => left.length > 0);
    expect(left).toEqual(["build"]);
  }));

  it("opens a connection's session, counted toward a collaborator's session until disposed",
      () => withChat(async ({ open, sessions, joined, left }) => {
    let owned = await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    if (owned.type !== "connection") throw new Error("expected a connection");
    expect(await owned.session.listIssues()).toEqual(["#12"]);
    expect(joined).toEqual([]);

    let shared = await (await open("collaborator")).connectToChatBinding(CHAT_ID, "GITHUB");
    if (shared.type !== "connection") throw new Error("expected a connection");
    expect(await shared.session.listIssues()).toEqual(["#12"]);
    expect(joined).toEqual(["build"]);
    shared.session[Symbol.dispose]();
    await waitFor(() => left.length > 0);
    expect(left).toEqual(["build"]);
    await waitFor(() => sessions[1]?.disposed === true);
  }));

  it("keeps a view's reads out of the chat, attributes them to it, and posts its writes there for a person",
      () => withChat(async ({ impl, open, sessions }) => {
    await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    let queue = sessions[0]!.queue;
    // The owner lets the agent label issues without asking; a view still asks.
    impl.storage.autoApproveTags.put({ gatekeeperId: GITHUB_ID,
        actionKind: { tag: "label", label: "Labels" }, enabledBy: USER });

    await queue.authorizeObservation({ title: "Read issue 12", description: "Issue 12.", subresources: [] });
    await queue.submitAction(1, { title: "Label issue 12", description: "Adds a label.",
        implementsRevert: false, actionKind: { tag: "label", label: "Labels" }, autoApprovable: true });

    let records = [...impl.storage.actions.list()];
    expect(records).toMatchObject([
      { type: "observation", caller: { from: "view", chatId: CHAT_ID } },
      { type: "action", state: "pending", caller: { from: "view", chatId: CHAT_ID },
        description: { autoApprovable: false } },
    ]);
    await waitFor(() => chatActions(impl).length > 0);
    expect(chatActions(impl)).toEqual([records[1].id]);
  }));

  it("refuses a hook bound through a view's session, and stores nothing",
      () => withChat(async ({ impl, open, sessions }) => {
    await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    let queue = sessions[0]!.queue;
    // Over RPC this is a rejection; called in process, the queue throws before anything is stored.
    expect(() => queue.bindHook(hookStub() as never, hookStub() as never,
        { title: "On push", description: "Runs on push." })).toThrow("A view can't bind hooks.");
    expect([...impl.storage.boundHooks.list()]).toEqual([]);
    expect([...impl.storage.actions.list()]).toEqual([]);
  }));

  it("refuses a view's lookup and every call once its chat is deleted", () => withChat(async ({ impl, open, sessions }) => {
    let client = await open("owner");
    let gadget = await client.connectToChatBinding(CHAT_ID, "EXPENSES");
    let github = await client.connectToChatBinding(CHAT_ID, "GITHUB");
    if (gadget.type !== "gadget" || github.type !== "connection") throw new Error("expected bindings");
    let queue = sessions[0]!.queue;
    impl.storage.chatMeta.delete(CHAT_ID);

    await expect(client.connectToChatBinding(CHAT_ID, "EXPENSES")).rejects.toThrow();
    await expect(gadget.rpc.total()).rejects.toThrow("This view's chat has been deleted.");
    await expect(github.session.listIssues()).rejects.toThrow("This view's chat has been deleted.");
    expect(() => queue.authorizeObservation({ title: "Read", description: "Read." }))
        .toThrow("This view's chat has been deleted.");
    expect(() => queue.submitAction(1, { title: "Write", description: "Write.", implementsRevert: false,
        autoApprovable: false })).toThrow("This view's chat has been deleted.");
    expect([...impl.storage.actions.list()]).toEqual([]);
  }));

  it("refuses a view's read whose chat is deleted while its authorization awaits", () => withChat(async ({ impl, open, sessions }) => {
    await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    let queue = sessions[0]!.queue;
    // The first observation that narrows sharing awaits the sharing manager: the chat goes then.
    impl.getSharingManager = async () => {
      impl.storage.chatMeta.delete(CHAT_ID);
      return { computeEffectiveAccess: () => new Map(), computeAffectedByOwnerInvitesOnly: () => [] };
    };
    await expect(queue.authorizeObservation({ title: "Read", description: "Read.", ownerInvitesOnly: true }))
        .rejects.toThrow("This view's chat has been deleted.");
    expect([...impl.storage.actions.list()]).toEqual([]);
  }));

  it("passes a call through a property of a connection's session, and refuses it once the chat is deleted",
      () => withChat(async ({ impl, open }) => {
    let github = await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    if (github.type !== "connection") throw new Error("expected a connection");
    expect(await github.session.issues.list()).toEqual(["#12"]);
    impl.storage.chatMeta.delete(CHAT_ID);
    await expect(github.session.issues.list()).rejects.toThrow("This view's chat has been deleted.");
  }));

  it("refuses a call through a capability a view's session returned, once the chat is deleted",
      () => withChat(async ({ impl, open }) => {
    let github = await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    if (github.type !== "connection") throw new Error("expected a connection");
    using cursor = await github.session.openCursor();
    expect(await cursor.next()).toBe("#13");
    impl.storage.chatMeta.delete(CHAT_ID);
    await expect(cursor.next()).rejects.toThrow("This view's chat has been deleted.");
  }));

  it("after the gadget's facet restarts, a view's next call fails and a new lookup works",
      () => withChat(async ({ impl, open }) => {
    let client = await open("owner");
    let first = await client.connectToChatBinding(CHAT_ID, "EXPENSES");
    if (first.type !== "gadget") throw new Error("expected a gadget");
    expect(await first.rpc.total()).toBe(1200);
    impl.proposedChangesChanged(CHAT_ID);
    await expect(first.rpc.total()).rejects.toThrow();
    let second = await client.connectToChatBinding(CHAT_ID, "EXPENSES");
    if (second.type !== "gadget") throw new Error("expected a gadget");
    expect(await second.rpc.total()).toBe(1200);
  }));
});
