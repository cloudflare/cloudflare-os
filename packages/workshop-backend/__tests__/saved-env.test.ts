// Saving env (plans/live-views.md, "Saving env"): executeCode's `env.NAME = value` saves NAME as a
// chat binding, JSON data or another name for a binding, durable with its step.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, AiToolCall, Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { runAgent } from "../src/agent";
import { buildCompactionState } from "../src/agent-compaction";
import type { ChatBindingEntry } from "../src/storage-schema/overseer-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CHAT_ID = 1;
const OWNER_USER_ID = "owner-user-do";
const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const EXPENSES_ID = 100;
const EXPENSES: ChatBindingEntry = { type: "workpiece", id: EXPENSES_ID };

type Bindings = Record<string, ChatBindingEntry>;
type Ran = { log: string, saves: ({ name: string, json: string } | { name: string, alias: string })[] };

type Fixture = {
  impl: any;
  // One executeCode run, with the given bindings and the step's unsaved JSON.
  run: (body: string, opts?: { bindings?: Bindings, pending?: Record<string, string>, claimed?: string[] }) => Promise<Ran>;
  // One agent turn: a user message, then the model's scripted steps. Returns the turn's tool calls.
  turn: (steps: AssistantMessage[]) => Promise<AiToolCall[]>;
  open: () => Promise<Overseer>;
};

let counter = 0;

async function withChat(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`saved-env-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => ALICE,
      getChatContext: async () => ({ profile: ALICE }),
      setWorkspaceLastActive: async () => {},
      messageArrived: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, idFromName: (name: string) => name, get: () => owner };
    let timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({ id: CHAT_ID, title: "Spending", started: timestamp, lastActive: timestamp });
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: { EXPENSES: EXPENSES_ID } });
    impl.storage.gadgets.put({ type: "gadget", id: EXPENSES_ID, title: "Expenses", created: new Date(0),
        bindingName: "EXPENSES", bindings: {} });
    let run = async (body: string, opts: { bindings?: Bindings, pending?: Record<string, string>, claimed?: string[] } = {}) =>
      await impl.executeCodeMode(CHAT_ID, `export default async function(self, env) {\n${body}\n}`, ALICE,
          "some-model", opts.bindings ?? { EXPENSES },
          { pending: new Map(Object.entries(opts.pending ?? {})), claimed: new Set(opts.claimed ?? []) });
    let turn = async (steps: AssistantMessage[]) => {
      let before = new Set(messages(impl).map(message => message.sequence));
      impl.addChatMessages(CHAT_ID, ALICE, [{ type: "message", message: "Chart my spending" }]);
      let faux = createFauxCore({ models: [{ id: "faux-model" }] });
      faux.setResponses([...steps, fauxAssistantMessage(fauxText("Done."))]);
      await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
          { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, ALICE,
          { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
      return messages(impl).filter(message => !before.has(message.sequence))
          .flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    };
    let open = async () => {
      let notifyClosed = new NativeRpcStub<() => void>(() => {});
      return await instance.open(OWNER_USER_ID, ALICE.id, notifyClosed);
    };
    await fn({ impl, run, turn, open });
  });
}

function messages(impl: any): AiChatMessage[] {
  return [...impl.storage.chats.list()].filter((message: AiChatMessage) => message.chatId === CHAT_ID);
}

const code = (body: string) =>
  fauxToolCall("executeCode", { code: `export default async function(self, env) {\n${body}\n}` });
const step = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const output = (call: AiToolCall | undefined) => call?.toolName === "executeCode" ? call.output : call?.error;

describe("executeCode saving env", () => {
  it("saves JSON data and another name for a binding, and says so", () => withChat(async ({ run }) => {
    let { log, saves } = await run(`
      env.TOTALS = { north: 1200, rows: [["Acme", 3.5, true, null]] };
      env.SALES = env.EXPENSES;
      console.log("done");`);
    expect(log.split("\n")).toEqual([
      "done",
      "Saved env.TOTALS (data) for views and later code.",
      "Saved env.SALES (another name for env.EXPENSES) for views and later code.",
    ]);
    expect(saves).toEqual([
      { name: "TOTALS", json: '{"north":1200,"rows":[["Acme",3.5,true,null]]}' },
      { name: "SALES", alias: "EXPENSES" },
    ]);
  }));

  it("refuses names in scope, values that are not JSON, and an oversized one, and saves the rest",
      () => withChat(async ({ run }) => {
    let { log, saves } = await run(`
      env.EXPENSES = { mine: true };
      env.GIT = 1;
      env.PENDING = 1;
      env.WHEN = { at: new Date(0) };
      env.LOOP = {}; env.LOOP.self = env.LOOP;
      env.DRAW = () => 1;
      env.NAN = [NaN];
      env.BIG = "é".repeat(500000);
      env.KEPT = "yes";`, { claimed: ["PENDING"] });
    const neither = "is neither JSON data nor another name for one of this chat's bindings.";
    expect(log.split("\n")).toEqual([
      "env.GIT was not saved: env.GIT is one of this chat's bindings; save it under another name.",
      "env.EXPENSES was not saved: env.EXPENSES is one of this chat's bindings; save it under another name.",
      "env.PENDING was not saved: env.PENDING is one of this chat's bindings; save it under another name.",
      `env.WHEN was not saved: env.WHEN.at is a Date, so env.WHEN ${neither}`,
      `env.LOOP was not saved: env.LOOP.self contains itself, so env.LOOP ${neither}`,
      `env.DRAW was not saved: env.DRAW is a function, so env.DRAW ${neither}`,
      `env.NAN was not saved: env.NAN[0] is NaN, so env.NAN ${neither}`,
      "env.BIG was not saved: env.BIG is 500002 code units as JSON, and a chat's saved data holds at most 400,000.",
      "Saved env.KEPT (data) for views and later code.",
    ]);
    expect(saves).toEqual([{ name: "KEPT", json: '"yes"' }]);
  }));

  it("refuses a save past the chat's total, unless the run first shrinks another", () => withChat(async ({ run }) => {
    let full = { bindings: { EXPENSES, A: { type: "data" } } as Bindings, pending: { A: JSON.stringify("x".repeat(390_000)) } };
    expect((await run(`env.B = "y".repeat(20000);`, full)).saves).toEqual([]);
    let { saves } = await run(`env.A = 1; env.B = "y".repeat(20000);`, full);
    expect(saves.map(save => save.name)).toEqual(["A", "B"]);
  }));

  it("saves data changed in place, keeps a deleted name, and leaves untouched data alone", () => withChat(async ({ run }) => {
    let { log, saves } = await run(`env.FOOD.weeks.push(2); delete env.OLD;`, {
      bindings: { EXPENSES, FOOD: { type: "data" }, OLD: { type: "data" }, SAME: { type: "data" } },
      pending: { FOOD: '{"weeks":[1]}', OLD: "1", SAME: "[3]" },
    });
    expect(saves).toEqual([{ name: "FOOD", json: '{"weeks":[1,2]}' }]);
    expect(log.split("\n")).toEqual([
      "Saved env.FOOD (data) for views and later code.",
      "env.OLD is still saved: a saved name can't be removed; save it again to replace it.",
    ]);
  }));

  it("keeps data names data: a copy of one is data, and one can't become another name", () => withChat(async ({ run }) => {
    let { log, saves } = await run(`env.COPY = env.FOOD; env.FOOD = env.EXPENSES;`, {
      bindings: { EXPENSES, FOOD: { type: "data" } }, pending: { FOOD: "[1]" },
    });
    expect(saves).toEqual([{ name: "COPY", json: "[1]" }]);
    expect(log).toContain("env.FOOD was not saved: env.FOOD holds saved data, and stays data");
  }));

  it("gives a run the step's unsaved data and the chat's stored data", () => withChat(async ({ impl, run }) => {
    impl.storage.chatSavedData.put({ chatId: CHAT_ID, name: "STORED", json: '{"n":1}' });
    let { log } = await run(`console.log(JSON.stringify([env.STORED, env.PENDING]));`, {
      bindings: { STORED: { type: "data" }, PENDING: { type: "data" } }, pending: { PENDING: "[2]" },
    });
    expect(log).toBe('[{"n":1},[2]]');
  }));

  it("saves nothing when the code throws", () => withChat(async ({ run }) => {
    let { log, saves } = await run(`env.TOTALS = 1; throw new Error("boom");`);
    expect(saves).toEqual([]);
    expect(log).toContain("Uncaught exception");
  }));

  it("checks the JSON the harness reports, since the agent's code shares its isolate", () => withChat(async ({ run }) => {
    let { log, saves } = await run(`JSON.stringify = () => "{"; env.X = 1;`);
    expect(saves).toEqual([]);
    expect(log).toBe("env.X was not saved: its JSON does not parse.");
  }));
});

describe("saved env in a turn", () => {
  it("stores a step's saves with its step, stamps them, and later turns read and describe them",
      () => withChat(async ({ impl, turn }) => {
    let [saved] = await turn([step(code(`env.TOTALS = { n: 1 };`))]);
    expect(saved).toMatchObject({ toolName: "executeCode", savedEnv: [{ name: "TOTALS" }] });
    expect([...impl.storage.chatSavedData.list()]).toEqual([{ chatId: CHAT_ID, name: "TOTALS", json: '{"n":1}' }]);
    let [read, described] = await turn([step(code(`console.log(JSON.stringify(env.TOTALS));`),
        fauxToolCall("describeBinding", { name: "TOTALS" }))]);
    expect(output(read)).toBe('{"n":1}');
    expect(described?.toolName === "describeBinding" && described.output).toContain("is JSON data");
    expect(impl.chatScopeNames(CHAT_ID).has("TOTALS")).toBe(true);
  }));

  it("lets a later call in the step read the first's save", () => withChat(async ({ turn }) => {
    let calls = await turn([step(code(`env.A = [1];`), code(`console.log(JSON.stringify(env.A));`))]);
    expect(output(calls[1])).toBe("[1]");
  }));

  it("refuses the second of a save and a createGadget of one name, in either order", () => withChat(async ({ turn }) => {
    let calls = await turn([
      step(fauxToolCall("createGadget", { title: "New", bindingName: "NEWG" }), code(`env.NEWG = 1;`)),
      step(code(`env.LATER = 1;`), fauxToolCall("createGadget", { title: "Later", bindingName: "LATER" })),
    ]);
    expect(output(calls[1])).toBe(
      "env.NEWG was not saved: env.NEWG is one of this chat's bindings; save it under another name.");
    expect(calls[3]?.error).toBeDefined();
  }));

  it("writes saved data only for a chat that still exists", () => withChat(async ({ impl }) => {
    let empty = { changes: [], createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [],
        blueprintMerges: [], savedData: [{ name: "A", json: "1" }] };
    await impl.commitAgentStep(CHAT_ID, ALICE, [], empty);
    expect([...impl.storage.chatSavedData.list()].map((record: { name: string }) => record.name)).toEqual(["A"]);
    impl.storage.chatMeta.delete(CHAT_ID);
    await impl.commitAgentStep(CHAT_ID, ALICE, [], { ...empty, savedData: [{ name: "B", json: "2" }] });
    expect([...impl.storage.chatSavedData.list()].map((record: { name: string }) => record.name)).toEqual(["A"]);
  }));

  it("removes a chat's saved data with the chat", () => withChat(async ({ impl, turn, open }) => {
    await turn([step(code(`env.TOTALS = 1;`))]);
    using client = await open();
    await client.deleteChat(CHAT_ID);
    expect([...impl.storage.chatSavedData.list()]).toEqual([]);
  }));
});

describe("saved env in compaction", () => {
  it("folds saved names into a checkpoint: data, another name as its target's entry, data saved again", () => {
    let call = (savedEnv: { name: string, alias?: string }[]) => ({
      toolCallId: "c", toolName: "executeCode", input: { code: "" }, output: "", savedEnv,
    });
    let message = (sequence: number, toolCalls: object[]) => ({
      chatId: CHAT_ID, sequence, timestamp: new Date(0), author: ALICE, type: "message", message: "", toolCalls,
    }) as AiChatMessage;
    let state = buildCompactionState([
      message(1, [call([{ name: "TOTALS" }, { name: "SALES", alias: "EXPENSES" }])]),
      message(2, [call([{ name: "TOTALS" }])]),
    ], 3, [["EXPENSES", EXPENSES]], undefined);
    expect(state.chatBindings).toEqual([
      ["EXPENSES", EXPENSES], ["TOTALS", { type: "data" }], ["SALES", EXPENSES],
    ]);
  });
});
