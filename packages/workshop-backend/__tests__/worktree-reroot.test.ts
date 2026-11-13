// An agent step can re-root its chat's pin for a worktree at a commit holding the result of a
// command run there (WorktreeTurnAccess.reRoot in agent.ts), as an update from mainline re-roots
// a gadget's pin at a merge commit. In production WorktreeReplicas calls it when a command's
// result is submitted. The tests here run the real runAgent with pi's faux provider standing in
// for the model, and call the hook directly from a stand-in for executeCodeMode.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Context,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, ChatGadgetPinState,
} from "@gadgets/workshop-shared/api";
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { runAgent, type WorktreeTurnAccess } from "../src/agent";
import { concatBytes } from "../src/git-codec";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "faux-model", name: "Faux" };
const CHAT = 1;
const BASE = { "a.txt": "one\n", "b.txt": "bee\n" };

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>, name?: string): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name ?? `worktree-reroot-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

let commitCounter = 0;
async function commitFiles(impl: any, files: Record<string, string>, parents: string[] = [])
    : Promise<string> {
  return await impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents,
    author: { name: "Alice", email: "alice@example.com" },
    message: `test commit ${++commitCounter}`,
    timestamp: new Date(1700000000_000),
  });
}

// A chat with a worktree `REPO` at a commit of `files`, recorded as created by an agent step.
async function setup(impl: any, files: Record<string, string> = BASE)
    : Promise<{ id: number, base: string }> {
  impl.storage.chatMeta.put(
      { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  let base = await commitFiles(impl, files);
  let { id } = await impl.createWorktree("Repo", CHAT, base);
  await impl.commitAgentStep(CHAT, AGENT, [], {
    changes: [], createdGadgets: [], addedBindings: [], worktreeCommits: [], blueprintMerges: [],
    createdWorktrees: [{ worktreeId: id, title: "Repo", bindingName: "REPO" }],
  });
  return { id, base };
}

function chatMessages(impl: any): AiChatMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(CHAT)}.` })];
}

function putMessage(impl: any, body: AiChatMessageBody): number {
  let sequence = impl.nextChatSequence(CHAT);
  impl.storage.chats.put(
      { chatId: CHAT, sequence, timestamp: impl.getChatTimestamp(), author: USER, ...body });
  return sequence;
}

function pins(impl: any): ChatGadgetPinState[] {
  return impl.storage.chatMeta.get(CHAT).codeBase?.pins ?? [];
}

// The worktree's files as the chat holds them (touched paths only), rebuilt from the log.
async function chatFiles(impl: any, id: number): Promise<Record<string, string>> {
  impl.invalidateChatContent(CHAT);
  let content = await impl.getCurrentChatContent(CHAT, impl.storage.chatMeta.get(CHAT));
  expect(content).toEqual(await impl.buildChatContent(CHAT));
  return Object.fromEntries(content.get(id) ?? new Map());
}

// What each executeCode call does, by its code: the stand-in for executeCodeMode runs it with
// the turn's worktree access, as the Worktree binding would reach it.
type Script = (turn: WorktreeTurnAccess) => Promise<string>;
function stubExecution(impl: any, scripts: Record<string, Script>): void {
  impl.executeCodeMode = async (_chatId: number, code: string, _initiator: unknown,
                                _authorId: unknown, _bindings: unknown, _onDelta: unknown,
                                turn: WorktreeTurnAccess) => await scripts[code](turn);
}
const execute = (code: string) => fauxToolCall("executeCode", { code });
const read = (filename: string) => fauxToolCall("readFile", { workpiece: "REPO", filename });

// Runs one agent turn, prompted by a new user message, in which the model makes each step's
// calls in turn and then stops. Returns the text of each call's result, by step.
async function agentTurn(impl: any, steps: ReturnType<typeof fauxToolCall>[][],
                         signal = new AbortController().signal): Promise<string[][]> {
  putMessage(impl, { type: "message", message: "Go." });
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let contexts: Context[] = [];
  faux.setResponses([
    ...steps.map(calls => fauxAssistantMessage(calls, { stopReason: "toolUse" })),
    fauxAssistantMessage(fauxText("Done.")),
  ].map(step => (context: TranscriptContext) => {
    contexts.push({ messages: structuredClone(context.messages) });
    return step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT, AGENT, signal,
      USER, { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  let results = contexts.at(-1)!.messages.flatMap(message => message.role === "toolResult"
      ? [message.content.map(part => part.type === "text" ? part.text : "").join("")]
      : []).slice(-steps.flat().length);
  return steps.map(calls => results.splice(0, calls.length));
}

// The files as the agent's replay of the log reads them, in a new turn.
async function agentReads(impl: any, names: string[]): Promise<string[]> {
  return (await agentTurn(impl, [names.map(read)]))[0];
}

// The commit a command's result would be submitted as: `files` on the worktree's current base.
async function resultCommit(impl: any, turn: WorktreeTurnAccess, id: number,
                            files: Record<string, string>): Promise<string> {
  return await commitFiles(impl, files, [turn.getBaseCommit(id)!]);
}

const COMMAND_RESULT = { "a.txt": "one\ncommand\n", "b.txt": "bee\nchat\nfixed\n", "c.txt": "new\n" };

// A chat whose first turn read a.txt and wrote b.txt, and whose second ran a command that the
// worktree's files were re-rooted at, with an edit before it (absorbed) and one after it.
async function reRootedChat(impl: any) {
  let { id, base } = await setup(impl);
  await agentTurn(impl, [[read("a.txt"),
      fauxToolCall("writeFile", { workpiece: "REPO", filename: "b.txt", content: "bee\nchat\n" })]]);
  let result!: string;
  let live: Record<string, unknown> = {};
  stubExecution(impl, {
    command: async turn => {
      turn.appendChange(id, "a.txt", { set: "one\nbuffered\n" });
      result = await resultCommit(impl, turn, id, COMMAND_RESULT);
      turn.reRoot(id, result);
      live = {
        base: turn.getBaseCommit(id), overlay: [...turn.getOverlayFiles(id).keys()],
        a: await turn.readFile(id, "a.txt"), c: await turn.readFile(id, "c.txt"),
      };
      turn.appendChange(id, "c.txt", { set: "newer\n" });
      return "ran";
    },
    noop: async () => "nothing",
  });
  let steps = await agentTurn(impl, [
    [execute("command"), read("a.txt"),
     fauxToolCall("writeFile", { workpiece: "REPO", filename: "d.txt", content: "d\n" }),
     execute("noop")],
    [fauxToolCall("editFile",
        { workpiece: "REPO", filename: "b.txt", textToReplace: "chat", replacement: "chat!" })],
  ]);
  let step = chatMessages(impl).findLast(msg => msg.type === "changes")!;
  return { id, base, result, live, steps, step };
}

const GUARD = "An executeCode call earlier in this step changed files, which take effect when " +
    "the step ends. End this response and call this tool again in your next step.";

describe("re-rooting a worktree's chat pin in an agent step", () => {
  it("shows in live reads for the rest of the step, and its message declares it",
      () => withImpl(async impl => {
    let { id, base, result, live, steps, step } = await reRootedChat(impl);

    // Live, the execution saw the re-rooted files, with nothing left in the overlay.
    expect(live).toEqual(
        { base: result, overlay: [], a: "one\ncommand\n", c: "new\n" });

    // The file tools after it refused to run, as did a second execution; the model's reads of
    // the worktree were forgotten, so its next step had to read b.txt again.
    expect(steps).toEqual([
      ["ran", GUARD, GUARD, expect.stringContaining("This step already made code changes")],
      ["You must read a file before you can edit it."],
    ]);

    // The step's message declares the re-root, reviewed against the accepted commit, and
    // records only the edit after it: the one before it is in the result already.
    expect(step).toMatchObject({
      type: "changes", author: AGENT,
      pins: [{ gadgetId: id, baseCommit: result, mergedCommit: base }],
      change: { [id]: [["c.txt", { set: "newer\n" }]] },
    });
    expect(step.watermark).toBeUndefined();
    expect(pins(impl)).toEqual([{ gadgetId: id, baseCommit: result, mergedCommit: base }]);
    expect(impl.storage.gadgets.get(id).pinBase).toBe(base);
    expect([...impl.storage.chatChanges.list({ prefix: `${keyString(CHAT)}.` })]).toEqual([]);
    expect(await chatFiles(impl, id)).toEqual({ "c.txt": "newer\n" });

    // The user reviews everything the chat changed against the accepted commit.
    expect(impl.chatMetaForClient(impl.storage.chatMeta.get(CHAT)).proposedChangeWorkpieces)
        .toEqual([id]);
    expect(await impl.listChangedPaths(base, result)).toEqual(["a.txt", "b.txt", "c.txt"]);
  }));

  it("bumps the generation destructively, with no rows, so clients rebuild from the log",
      () => withImpl(async impl => {
    let { id } = await setup(impl);
    await agentTurn(impl, [[
      fauxToolCall("writeFile", { workpiece: "REPO", filename: "b.txt", content: "bee\nchat\n" }),
    ]]);
    let before = impl.storage.chatMeta.get(CHAT).codeBase;
    stubExecution(impl, {
      command: async turn => {
        turn.reRoot(id, await resultCommit(impl, turn, id, COMMAND_RESULT));
        return "ran";
      },
    });
    await agentTurn(impl, [[execute("command")]]);
    let after = impl.storage.chatMeta.get(CHAT).codeBase;
    expect(after.generation).toBe(before.generation + 1);
    expect(after.revision).toBe(0);
    expect(after.prior).toBeUndefined();
  }));

  it("survives replay, a reload, and a restart", async () => {
    let name = `worktree-reroot-restart-${++doCounter}`;
    let id!: number;
    await withImpl(async impl => {
      ({ id } = await reRootedChat(impl));
      expect(await agentReads(impl, ["a.txt", "b.txt", "c.txt"]))
          .toEqual(["one\ncommand\n", "bee\nchat\nfixed\n", "newer\n"]);
    }, name);

    await abortAllDurableObjects();

    await withImpl(async impl => {
      expect(await chatFiles(impl, id)).toEqual({ "c.txt": "newer\n" });
      expect(await agentReads(impl, ["a.txt", "b.txt", "c.txt"]))
          .toEqual(["one\ncommand\n", "bee\nchat\nfixed\n", "newer\n"]);
      // A read since the re-root is knowledge the model can edit by.
      let [[edited]] = await agentTurn(impl, [[fauxToolCall("editFile",
          { workpiece: "REPO", filename: "a.txt", textToReplace: "command", replacement: "x" })]]);
      expect(edited).toContain("success");
    }, name);
  });

  it("forgets on replay what the model read before the re-root", () => withImpl(async impl => {
    let { id } = await reRootedChat(impl);
    // b.txt was read (and written) before the re-root, and is not read since.
    let [[refused]] = await agentTurn(impl, [[fauxToolCall("editFile",
        { workpiece: "REPO", filename: "b.txt", textToReplace: "chat", replacement: "chat!" })]]);
    expect(refused).toBe("You must read a file before you can edit it.");
    expect(await chatFiles(impl, id)).toEqual({ "c.txt": "newer\n" });
  }));

  it("is lost if the Durable Object restarts before the step's barrier", async () => {
    let name = `worktree-reroot-crash-${++doCounter}`;
    let id!: number, base!: string;
    await withImpl(async impl => {
      ({ id, base } = await setup(impl));
      await agentTurn(impl, [[
        fauxToolCall("writeFile", { workpiece: "REPO", filename: "b.txt", content: "bee\nchat\n" }),
      ]]);
      let reRooted!: () => void;
      let reached = new Promise<void>(resolve => reRooted = resolve);
      stubExecution(impl, {
        command: async turn => {
          turn.reRoot(id, await resultCommit(impl, turn, id, COMMAND_RESULT));
          reRooted();
          return await new Promise<string>(() => {});  // the command never finishes
        },
      });
      void agentTurn(impl, [[execute("command")]]).catch(() => {});
      await reached;
      expect(pins(impl)).toEqual([{ gadgetId: id, baseCommit: base, mergedCommit: base }]);
    }, name);

    await abortAllDurableObjects();

    await withImpl(async impl => {
      expect(pins(impl)).toEqual([{ gadgetId: id, baseCommit: base, mergedCommit: base }]);
      expect(chatMessages(impl).at(-1)).toMatchObject({ type: "message", message: "Go." });
      expect(await chatFiles(impl, id)).toEqual({ "b.txt": "bee\nchat\n" });
      expect(await agentReads(impl, ["a.txt", "b.txt"])).toEqual(["one\n", "bee\nchat\n"]);
    }, name);
  });

  it("is undone by reverting its step", () => withImpl(async impl => {
    let { id, base, step } = await reRootedChat(impl);
    // The step's first message is its tool-call record, just before its changes message.
    let toolStep = chatMessages(impl).findLast(msg =>
        msg.type === "message" && msg.sequence < step.sequence)!;
    await impl.revertChanges(CHAT, toolStep.sequence, USER);
    expect(pins(impl)).toEqual([{ gadgetId: id, baseCommit: base, mergedCommit: base }]);
    expect(await chatFiles(impl, id)).toEqual({ "b.txt": "bee\nchat\n" });
    expect(await agentReads(impl, ["a.txt", "b.txt"])).toEqual(["one\n", "bee\nchat\n"]);
  }));
});

describe("reads around a re-root", () => {
  it("a base read the re-root overtakes reads the new base", () => withImpl(async impl => {
    let { id } = await setup(impl);
    // Holds the first base read once it has its text, until the re-root has happened.
    let readFileAtCommit = impl.readFileAtCommit.bind(impl);
    let held!: () => void, release!: () => void;
    let holding = new Promise<void>(resolve => held = resolve);
    let released = new Promise<void>(resolve => release = resolve);
    impl.readFileAtCommit = async (commit: string, path: string) => {
      let text = await readFileAtCommit(commit, path);
      impl.readFileAtCommit = readFileAtCommit;
      held();
      await released;
      return text;
    };
    let reads: unknown[] = [];
    stubExecution(impl, {
      command: async turn => {
        let result = await resultCommit(impl, turn, id, COMMAND_RESULT);
        let pending = turn.readFile(id, "a.txt");
        await holding;
        turn.reRoot(id, result);
        release();
        reads.push(await pending, await turn.readFile(id, "a.txt"));
        return "ran";
      },
    });
    await agentTurn(impl, [[execute("command")]]);
    expect(reads).toEqual(["one\ncommand\n", "one\ncommand\n"]);
  }));

  // An execution that only commits pins the worktree live, so a read after it is served from
  // the session, and a later execution of the step can still re-root.
  it("replays a read made in the step before the re-root at the accepted commit",
      () => withImpl(async impl => {
    let { id, base } = await setup(impl);
    stubExecution(impl, {
      commit: async turn => {
        let commit = await commitFiles(impl, { ...BASE, "a.txt": "committed\n" }, [base]);
        turn.appendCommit(id, commit, base);
        return "committed";
      },
      command: async turn => {
        turn.reRoot(id, await resultCommit(impl, turn, id, COMMAND_RESULT));
        return "ran";
      },
    });
    let [live] = await agentTurn(impl, [[execute("commit"), read("a.txt"), execute("command")]]);
    expect(live).toEqual(["committed", "one\n", "ran"]);

    // The next turn's replay shows the model the same read, then the re-rooted file.
    putMessage(impl, { type: "message", message: "Go." });
    let faux = createFauxCore({ models: [{ id: "faux-model" }] });
    let replayed: string[] = [];
    faux.setResponses([
      (context: TranscriptContext) => {
        replayed = context.messages.flatMap(message => message.role === "toolResult"
            ? [message.content.map(part => part.type === "text" ? part.text : "").join("")]
            : []);
        return fauxAssistantMessage([read("a.txt")], { stopReason: "toolUse" });
      },
      (context: TranscriptContext) => {
        replayed.push(...context.messages.slice(-1).flatMap(message =>
            message.role === "toolResult" && message.content[0].type === "text"
                ? [message.content[0].text] : []));
        return fauxAssistantMessage(fauxText("Done."));
      },
    ]);
    await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT, AGENT,
        new AbortController().signal, USER,
        { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
    expect(replayed).toEqual(["committed", "one\n", "ran", "one\ncommand\n"]);
  }));
});

describe("accepting a re-rooted worktree", () => {
  // The worktree's history from its accepted commit, by commit id.
  async function history(impl: any, id: number): Promise<string[]> {
    let log = await impl.gitCache.readCommitLog(impl.storage.gadgets.get(id).pinBase);
    return log.map((entry: { oid: string }) => entry.oid);
  }

  it("keeps the content of a re-root that is the chat's only change, on the old pinBase",
      () => withImpl(async impl => {
    let { id, base } = await setup(impl);
    let result!: string;
    stubExecution(impl, {
      command: async turn => {
        result = await resultCommit(impl, turn, id, COMMAND_RESULT);
        turn.reRoot(id, result);
        return "ran";
      },
    });
    await agentTurn(impl, [[execute("command")]]);
    expect(pins(impl)).toEqual([{ gadgetId: id, baseCommit: result, mergedCommit: base }]);

    expect(await impl.mergeChanges(CHAT, { profile: USER }, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    let accepted = impl.storage.gadgets.get(id).pinBase;
    expect(await impl.gitCache.commitTree(accepted)).toBe(await impl.gitCache.commitTree(result));
    expect(await history(impl, id)).toEqual([accepted, base]);
    expect(pins(impl)).toEqual([]);
    expect(await agentReads(impl, ["a.txt", "c.txt"])).toEqual(["one\ncommand\n", "new\n"]);
  }));

  it("applies the paths touched after the last re-root, and only those, to its commit",
      () => withImpl(async impl => {
    let { id, base, result } = await reRootedChat(impl);
    expect(await impl.mergeChanges(CHAT, { profile: USER }, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    let accepted = impl.storage.gadgets.get(id).pinBase;
    expect(Object.fromEntries(await impl.gitCache.readCommitFiles(accepted)))
        .toEqual({ ...COMMAND_RESULT, "c.txt": "newer\n" });
    expect(await history(impl, id)).toEqual([accepted, base]);
    expect(await history(impl, id)).not.toContain(result);
  }));

  it("keeps an executable bit the re-rooted tree has", () => withImpl(async impl => {
    let { id, base } = await setup(impl, { "a.txt": "one\n", "run.sh": "#!/bin/sh\n" });
    let blob = (text: string) =>
        impl.gitCache.putFromGatekeeper(999, "blob", new TextEncoder().encode(text));
    let tree = await impl.gitCache.putFromGatekeeper(999, "tree", treePayload([
      { mode: "100644", name: "a.txt", oid: await blob("one\n") },
      { mode: "100755", name: "run.sh", oid: await blob("#!/bin/sh\n") },
    ]));
    let result = await impl.gitCache.putFromGatekeeper(999, "commit", new TextEncoder().encode(
        `tree ${tree}\nparent ${base}\n` +
        `author Test <test@example.com> 1700000000 +0000\n` +
        `committer Test <test@example.com> 1700000000 +0000\n\nchmod +x run.sh\n`));
    stubExecution(impl, {
      command: async turn => {
        turn.reRoot(id, result);
        turn.appendChange(id, "a.txt", { set: "two\n" });
        return "ran";
      },
    });
    await agentTurn(impl, [[execute("command")]]);

    expect(await impl.mergeChanges(CHAT, { profile: USER }, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    let accepted = impl.storage.gadgets.get(id).pinBase;
    expect((await impl.gitCache.pathEntryAtCommit(accepted, "run.sh")).kind).toBe("executable");
    expect(await impl.readFileAtCommit(accepted, "a.txt")).toBe("two\n");
    expect(await history(impl, id)).toEqual([accepted, base]);
  }));
});

describe("the file tools after an execution that changed files", () => {
  it("refuse to run in the same step, and run in the next", () => withImpl(async impl => {
    let { id } = await setup(impl);
    stubExecution(impl, {
      write: async turn => {
        turn.appendChange(id, "a.txt", { set: "written\n" });
        return "wrote";
      },
      noop: async () => "nothing",
    });
    let steps = await agentTurn(impl, [
      [execute("noop"), read("a.txt")],
      [execute("write"), read("a.txt"), fauxToolCall("grep", { workpiece: "REPO", pattern: "x" }),
       fauxToolCall("editFile",
           { workpiece: "REPO", filename: "a.txt", textToReplace: "one", replacement: "two" })],
      [read("a.txt")],
    ]);
    expect(steps).toEqual([
      ["nothing", "one\n"],
      ["wrote", GUARD, GUARD, GUARD],
      ["written\n"],
    ]);
    // Replay shows the model the same.
    expect(await agentReads(impl, ["a.txt"])).toEqual(["written\n"]);
  }));
});

function treePayload(entries: { mode: string, name: string, oid: GitOid }[]): Uint8Array {
  return concatBytes(entries.flatMap(entry => [
    new TextEncoder().encode(`${entry.mode} ${entry.name}\0`),
    Uint8Array.from(entry.oid.match(/../g)!.map(h => parseInt(h, 16))),
  ]));
}
