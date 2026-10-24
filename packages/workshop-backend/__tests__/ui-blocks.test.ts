// Overseer.connectToChatBinding(): a chat binding as a `<gadget-ui>` view's code reaches it. A
// gadget is the facet the chat's agent reaches through the name. A connection the user made is a
// session with the view as caller: its reads stay out of the chat, and its writes wait there for a
// person.

import { describe, expect, it } from "vitest";
import { env, RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer, waitFor } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CHAT_ID = 1;
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER: AiChatAuthorInfo = { type: "user", id: "owner-profile", name: "Owner" };
const EXPENSES_ID = 100;
const LATER_ID = 101;
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

// An agent message whose createGadget call binds LATER.
const createdLater = { type: "message", message: "Made it.", toolCalls: [{
  toolCallId: "t1", toolName: "createGadget",
  input: { title: "Later", bindingName: "LATER" },
  output: { gadgetId: LATER_ID, changeId: 1 },
}] };

// The session a gatekeeper returns, behind a real stub as in production.
class FakeSession extends RpcTarget {
  disposed = false;
  constructor(readonly queue: ApprovalQueue) { super(); }
  listIssues() { return ["#12"]; }
  [Symbol.dispose]() { this.disposed = true; }
}

let doCounter = 0;

type Fixture = {
  impl: any;
  // Opens a client interface: the owner's, or a "build" collaborator's.
  open: (as: "owner" | "collaborator") => Promise<Overseer>;
  facets: unknown[][];
  // The files each facet would load, as the gadget worker reads them.
  loaded: Record<string, string>[];
  sessions: FakeSession[];
  // Session kinds joined and left through joinSession.
  joined: string[];
  left: string[];
};

async function withChat(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`ui-blocks-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let timestamp = impl.getChatTimestamp();
    impl.ownerId = "owner-user-do";
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => ({ profile: { id: "owner-profile", name: "Owner" } }) }),
    };
    impl.storage.chatMeta.put({ id: CHAT_ID, title: "Views", started: timestamp, lastActive: timestamp });
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: SEED });
    for (let [id, bindingName] of [[EXPENSES_ID, "EXPENSES"], [LATER_ID, "LATER"]] as const) {
      impl.storage.gadgets.put(
          { type: "gadget", id, title: "G", created: new Date(0), bindingName, bindings: {} });
    }
    impl.storage.gadgets.put({ type: "worktree", id: 7, title: "Repo", created: new Date(0),
        chatId: CHAT_ID, baseCommit: "c", headCommit: "c", pinBase: "c" });
    for (let record of GATEKEEPERS) impl.storage.gatekeepers.put(record);
    impl.addChatMessages(CHAT_ID, USER, [{ type: "message", message: "Chart my spending" }]);

    let facets: unknown[][] = [];
    let loaded: Record<string, string>[] = [];
    impl.getGadgetFacet = async (...args: unknown[]) => {
      facets.push(args);
      loaded.push(Object.fromEntries(await impl.readGadgetFiles(args[0], args[1])));
      return {};
    };
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
    impl.joinSession = (kind: string) => {
      joined.push(kind);
      return () => left.push(kind);
    };

    let open = (as: "owner" | "collaborator") => openFakeOverseer({}, { impl: {
      // The fixture opens as "owner-id"; naming another owner makes that a collaborator.
      ...(as === "collaborator" && { ownerId: "someone-else" }),
      openViewBinding: impl.openViewBinding.bind(impl),
    } });
    await fn({ impl, open, facets, loaded, sessions, joined, left });
  });
}

function chatActions(impl: any): number[] {
  return [...impl.storage.chats.list()].flatMap(msg => msg.type === "action" ? [msg.actionId] : []);
}

const serverFiles = (text: string) => new Map([["server.js", text]]);

describe("connectToChatBinding", () => {
  it("refuses a name the chat does not bind, and every binding but a gadget or a user's connection",
      () => withChat(async ({ open, facets, sessions }) => {
    let client = await open("owner");
    await expect(client.connectToChatBinding(CHAT_ID, "NOPE"))
        .rejects.toThrow(/"NOPE" is not a binding in this chat/);
    for (let name of ["REPO", "MODEL", "AGENTS", "SEARCH", "LEGACY"]) {
      await expect(client.connectToChatBinding(CHAT_ID, name))
          .rejects.toThrow(`"${name}" can't be used in a view.`);
    }
    expect(facets).toEqual([]);
    expect(sessions).toEqual([]);
  }));

  it("opens the facet the chat's agent reaches through the name",
      () => withChat(async ({ open, facets }) => {
    await (await open("owner")).connectToChatBinding(CHAT_ID, "EXPENSES");
    await (await open("collaborator")).connectToChatBinding(CHAT_ID, "EXPENSES");

    // At the chat's version, and counted toward a collaborator's session while the stub lives.
    expect(facets).toEqual([[EXPENSES_ID, CHAT_ID, undefined], [EXPENSES_ID, CHAT_ID, "build"]]);
  }));

  it("a name the chat binds after the view resolves once it is bound",
      () => withChat(async ({ impl, open, facets }) => {
    let client = await open("owner");
    await expect(client.connectToChatBinding(CHAT_ID, "LATER"))
        .rejects.toThrow(/"LATER" is not a binding in this chat/);

    impl.addChatMessages(CHAT_ID, AGENT, [createdLater]);
    await client.connectToChatBinding(CHAT_ID, "LATER");
    expect(facets).toEqual([[LATER_ID, CHAT_ID, undefined]]);
  }));

  it("after a compaction, resolves from its checkpoint and the messages after it",
      () => withChat(async ({ impl, open, facets }) => {
    impl.addChatMessages(CHAT_ID, AGENT, [{ type: "message", message: "Here." }]);
    // The checkpoint holds the bindings as of its boundary, so nothing before it is read again.
    let compactedTo = [...impl.storage.chats.list()].at(-1).sequence + 1;
    impl.storage.chatCompactions.put({ chatId: CHAT_ID, compactedTo, summary: "", nextChangeId: 0,
        chatBindings: [["EXPENSES", { type: "workpiece", id: LATER_ID }]] });
    impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(CHAT_ID), compactedTo });

    let client = await open("owner");
    await client.connectToChatBinding(CHAT_ID, "EXPENSES");
    await expect(client.connectToChatBinding(CHAT_ID, "LATER"))
        .rejects.toThrow(/"LATER" is not a binding in this chat/);
    impl.addChatMessages(CHAT_ID, AGENT, [createdLater]);
    await client.connectToChatBinding(CHAT_ID, "LATER");
    expect(facets).toEqual([[LATER_ID, CHAT_ID, undefined], [LATER_ID, CHAT_ID, undefined]]);
  }));

  it("connects to the chat's code with its live edits folded in",
      () => withChat(async ({ impl, open, loaded }) => {
    let base = await impl.gitStore.writeFilesAsCommit(serverFiles("v1"), {
      parents: [], author: { name: "Owner", email: "owner@example.com" }, message: "v1",
      timestamp: new Date(0),
    });
    impl.storage.gadgets.put({ ...impl.storage.gadgets.get(EXPENSES_ID), commitId: base });
    // An edit made in the code editor stays a live row until something materializes it.
    await impl.submitCodeChange(CHAT_ID, {
      generation: 0, revision: 0, clientId: "editor", seq: 1,
      pins: [{ gadgetId: EXPENSES_ID, baseCommit: base }],
      change: diffFiles(new Map([[EXPENSES_ID, serverFiles("v1")]]),
          new Map([[EXPENSES_ID, serverFiles("v2")]])),
    }, USER, "owner-user-do");

    await (await open("owner")).connectToChatBinding(CHAT_ID, "EXPENSES");
    expect(loaded).toEqual([{ "server.js": "v2" }]);
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

  it("keeps a view's reads out of the chat, and posts its writes there for a person to decide",
      () => withChat(async ({ impl, open, sessions }) => {
    await (await open("owner")).connectToChatBinding(CHAT_ID, "GITHUB");
    let queue = sessions[0]!.queue;
    // The owner lets the agent label issues without asking; a view still asks.
    impl.storage.autoApproveTags.put({ gatekeeperId: GITHUB_ID,
        actionKind: { tag: "label", label: "Labels" }, enabledBy: USER });

    await queue.authorizeObservation({ title: "Read issue 12", description: "Issue 12." });
    await queue.submitAction(1, { title: "Label issue 12", description: "Adds a label.",
        implementsRevert: false, actionKind: { tag: "label", label: "Labels" }, autoApprovable: true });

    let records = [...impl.storage.actions.list()];
    expect(records).toMatchObject([
      { type: "observation", caller: { from: "view", chatId: CHAT_ID } },
      // Stored as not auto-approvable, so its card offers no rule that could not apply it.
      { type: "action", state: "pending", caller: { from: "view", chatId: CHAT_ID },
        description: { autoApprovable: false } },
    ]);
    // Posts land in order, so once the write's is there, a read's would be too.
    await waitFor(() => chatActions(impl).length > 0);
    expect(chatActions(impl)).toEqual([records[1].id]);
  }));
});
