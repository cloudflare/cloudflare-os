// Property-based end-to-end tests: fast-check generates sequences of the operations a real client
// performs, and each run replays one against the real Workshop over RPC, checked against a small
// model. Seeds and the shrink time limit come from `src/property-runs.ts`; a failure prints the
// seed and the shrunk counterexample's path, which replay it when passed to that fc.assert().
//
// Every run allocates a fresh account (and so a fresh workspace and fixture-gatekeeper label),
// so runs, and shrink attempts, never see each other's state.

import { setTimeout as sleep } from "node:timers/promises";
import type { RpcStub } from "capnweb";
import * as fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber,
  ActionLogEntry, Overseer, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { applyCodeChange, diffFiles, type CodeChange, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { PROPERTY_RUN_OPTIONS } from "../src/property-runs.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
  WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** A fresh account's new workspace, released with the returned stack. */
async function freshWorkspace(stack: DisposableStack, prefix: string) {
  const [username] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username));
  const ws = stack.use(await api.newWorkspace());
  return { api, ws };
}

// ---------------------------------------------------------------------------------------------
// Approvals: writes a gadget stages, decided by the user in any order, with and without an
// auto-approval rule. The fixture gatekeeper numbers its actions independently of the Workshop's
// ledger, so every decision also checks the ledger-to-gatekeeper id mapping: approving the wrong
// entry applies the wrong value, or throws in the fixture.

type Decision = "approve" | "reject" | "leave";

class ApprovalModel {
  readonly states: ("pending" | "approved" | "rejected")[];
  applied: number[] = [];

  constructor(readonly values: number[], readonly eligible: boolean[]) {
    this.states = values.map(() => "pending");
    this.drain();
  }

  decide(index: number, decision: "approve" | "reject") {
    this.states[index] = decision === "approve" ? "approved" : "rejected";
    if (decision === "approve") this.applied.push(this.values[index]!);
    this.drain();
  }

  // The drain: eligible pending writes apply in submission order, stopping at the first pending
  // write that needs a human (auto-approval.ts).
  drain() {
    for (const [i, state] of this.states.entries()) {
      if (state !== "pending") continue;
      if (!this.eligible[i]) return;
      this.states[i] = "approved";
      this.applied.push(this.values[i]!);
    }
  }
}

const approvalScenario = fc.uniqueArray(fc.integer({ min: -1_000_000, max: 1_000_000 }),
    { minLength: 1, maxLength: 6 }).chain(values => fc.record({
  values: fc.constant(values),
  ruleEnabled: fc.boolean(),
  autoApprovable: fc.array(fc.boolean(), { minLength: values.length, maxLength: values.length }),
  decisions: fc.array(fc.constantFrom<Decision>("approve", "reject", "leave"),
      { minLength: values.length, maxLength: values.length }),
  order: fc.shuffledSubarray(values.map((_, i) => i),
      { minLength: values.length, maxLength: values.length }),
  concurrent: fc.boolean(),
}));

async function writesOf(ws: RpcStub<Overseer>, gatekeeperId: number) {
  const writes: (ActionLogEntry & { type: "action" })[] = [];
  let beforeId: number | undefined;
  do {
    const page = await ws.listActions({ filter: "action", beforeId });
    for (const entry of page.entries) {
      if (entry.type === "action" && entry.gatekeeperId === gatekeeperId) writes.push(entry);
    }
    beforeId = page.nextBeforeId;
  } while (beforeId !== undefined);
  return writes;
}

const valueOf = (entry: ActionLogEntry) => Number(/^Set the test value to (-?\d+)$/
    .exec(entry.description.title)?.[1]);

it.concurrent("decided writes apply exactly once, to the write the user decided", async () => {
  await fc.assert(fc.asyncProperty(approvalScenario, async scenario => {
    using stack = new DisposableStack();
    const { api, ws } = await freshWorkspace(stack, "approvals");
    await api.provisionAmbientAccount(TEST_VENDOR_ID);
    const account = await waitFor("the test account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
    const label = accountLabel(account);
    const gatekeeper = await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/approvals");
    if (!gatekeeper) throw new Error("Failed to create the test connection");
    const gatekeeperId = await stack.use(gatekeeper).getId();
    const session = stack.use(await gatekeeper.openSession() as RpcStub<TestSession>);
    if (scenario.ruleEnabled) {
      await ws.setAutoApprovedActionKind(gatekeeperId, { tag: "set-value", label: "Set value" });
    }

    const { values } = scenario;
    const eligible = values.map((_, i) => scenario.ruleEnabled && scenario.autoApprovable[i]!);
    const write = (i: number) =>
      session.writeValue(values[i]!, { autoApprovable: scenario.autoApprovable[i] });
    // A gadget may fire its writes concurrently, but the drain then races submission, so the
    // model's "nothing applies past a pending gate" order holds only for sequential submission.
    if (scenario.concurrent && !scenario.ruleEnabled) {
      await Promise.all(values.map((_, i) => write(i)));
    } else {
      for (const i of values.keys()) await write(i);
    }

    const model = new ApprovalModel(values, eligible);
    const idOf = new Map((await writesOf(ws, gatekeeperId)).map(entry => [valueOf(entry), entry.id]));
    expect([...idOf.keys()].toSorted()).toEqual(values.toSorted());

    const matchesModel = async () => {
      const writes = await writesOf(ws, gatekeeperId);
      const states = new Map(writes.map(entry => [valueOf(entry), entry.state]));
      return values.every((value, i) => states.get(value) === model.states[i]) ? writes : null;
    };
    const expectFixtureMatches = async () => {
      const pending = values.filter((_, i) => model.states[i] === "pending");
      const state = await testActionState(harness, label);
      expect(state.pending.map(action => action.value).toSorted()).toEqual(pending.toSorted());
      expect(state.applyCount).toBe(model.applied.length);
      expect(state.value).toBe(model.applied.at(-1));
    };

    await waitFor("the initial drain", matchesModel, 10_000);
    for (const i of scenario.order) {
      const decision = scenario.decisions[i]!;
      if (eligible[i] || decision === "leave" || model.states[i] !== "pending") continue;
      const id = idOf.get(values[i]!)!;
      await (decision === "approve" ? ws.approveAction(id) : ws.rejectAction(id));
      model.decide(i, decision);
      await waitFor(`the ledger after ${decision} of ${values[i]}`, matchesModel, 10_000);
      await expectFixtureMatches();
    }

    // Give a drain that wrongly skips past a pending gate time to show itself. It runs out of
    // process (ctx.waitUntil), so only a real delay can show its absence.
    await sleep(300);
    const writes = await matchesModel();
    expect(writes, "ledger states after settling").not.toBeNull();
    for (const entry of writes!) {
      const i = values.indexOf(valueOf(entry));
      if (model.states[i] === "approved") expect(!!entry.autoApproved).toBe(eligible[i]);
    }
    await expectFixtureMatches();

    // A second tab deciding an already decided write must not apply it again.
    const decided = values.findIndex((_, i) => model.states[i] !== "pending");
    if (decided !== -1) {
      const id = idOf.get(values[decided]!)!;
      await expect(ws.approveAction(id)).rejects.toThrow(`Action is not pending: ${id}`);
      await expect(ws.rejectAction(id)).rejects.toThrow(`Action is not pending: ${id}`);
      await expectFixtureMatches();
    }
  }), { ...PROPERTY_RUN_OPTIONS, numRuns: 15 });
});

// ---------------------------------------------------------------------------------------------
// Chats and their attachments: create, reply and delete chats, attaching uploaded files (some
// shared across messages and chats, some sharing a filename). Every attachment id resolves, to its
// file's exact bytes, in exactly the chat that holds it, including after its chat is deleted and
// another chat takes its place.

type File = { bytes: Uint8Array; mimeType: string; name: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const file: fc.Arbitrary<File> = fc.oneof(
  fc.record({
    bytes: fc.string({ unit: "grapheme", maxLength: 200 }).map(text => new TextEncoder().encode(text)),
    mimeType: fc.constant("text/plain"),
    name: fc.constantFrom("notes.txt", "todo.txt"),
  }),
  fc.record({
    bytes: fc.uint8Array({ maxLength: 2048 }),
    mimeType: fc.constant("application/octet-stream"),
    name: fc.constantFrom("export.bin", "data.bin"),
  }),
  fc.record({
    bytes: fc.uint8Array({ maxLength: 1024 }).map(tail => new Uint8Array([...PNG_SIGNATURE, ...tail])),
    mimeType: fc.constant("image/png"),
    name: fc.constantFrom("screenshot.png", "photo.png"),
  }),
);

const attach = fc.uniqueArray(fc.nat(), { maxLength: 3 });
const message = fc.constantFrom("Here you go", "See attached", "Thoughts?", "Ünïcödé 👋");
const chatOp = fc.oneof(
  fc.record({ op: fc.constant("new" as const), text: message, attach }),
  fc.record({ op: fc.constant("send" as const), chat: fc.nat(), text: message, attach }),
  fc.record({ op: fc.constant("delete" as const), chat: fc.nat() }),
);

// A session opens with a chat carrying a file; the generated ops may then reply, delete, or start
// more. Without it, a run whose first chat carries nothing checks no attachment at all.
const opening = fc.record({
  op: fc.constant("new" as const), text: message, attach: fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 3 }),
});

type ModelMessage = { text: string; attachments: { id: string; file: number }[] };

it.concurrent("attachment ids resolve to their bytes in exactly the chat that holds them", async () => {
  await fc.assert(fc.asyncProperty(
      fc.array(file, { minLength: 1, maxLength: 4 }),
      fc.tuple(opening, fc.array(chatOp, { maxLength: 7 })).map(([first, rest]) => [first, ...rest]),
      async (files, ops) => {
    using stack = new DisposableStack();
    const { ws } = await freshWorkspace(stack, "attachments");
    const oids: string[] = [];
    for (const { bytes } of files) {
      const oid = await ws.uploadBlob(bytes);
      expect(await ws.uploadBlob(bytes.slice())).toBe(oid);
      oids.push(oid);
    }

    const live = new Map<number, ModelMessage[]>();
    const deleted = new Map<number, string[]>();
    // Send `text` with the files `picks` selects, as a new chat or into `chatId`, and record the
    // attachment ids the chat's history assigned them.
    const send = async (chatId: number | undefined, text: string, picks: number[]) => {
      const picked = [...new Set(picks.map(p => p % files.length))];
      const sent = picked.map(f => ({ oid: oids[f]!, mimeType: files[f]!.mimeType, name: files[f]!.name }));
      if (chatId === undefined) {
        chatId = await ws.newChat(text, null, undefined, sent);
        expect(live.has(chatId)).toBe(false);
        live.set(chatId, []);
      } else {
        await ws.sendChatMessage(chatId, text, null, undefined, sent);
      }
      const last = (await ws.getChatHistory(chatId)).messages.findLast(m => m.type === "message");
      if (last?.type !== "message") throw new Error(`Chat ${chatId} has no message`);
      expect(last.message).toBe(text);
      const attachments = last.attachments ?? [];
      expect(attachments.map(({ oid, mimeType, name, size }) => ({ oid, mimeType, name, size })))
          .toEqual(sent.map((handle, i) => ({ ...handle, size: files[picked[i]!]!.bytes.byteLength })));
      live.get(chatId)!.push({ text, attachments: attachments.map((a, i) => ({ id: a.id, file: picked[i]! })) });
    };

    for (const op of ops) {
      const chats = [...live.keys()];
      if (op.op === "new") {
        await send(undefined, op.text, op.attach);
      } else if (chats.length > 0) {
        const chatId = chats[op.chat % chats.length]!;
        if (op.op === "send") {
          await send(chatId, op.text, op.attach);
        } else {
          await ws.deleteChat(chatId);
          deleted.set(chatId, live.get(chatId)!.flatMap(m => m.attachments.map(a => a.id)));
          live.delete(chatId);
        }
      }
    }

    expect((await ws.listChats()).map(chat => chat.id).toSorted()).toEqual([...live.keys()].toSorted());
    const owner = new Map<string, number>();
    for (const [chatId, messages] of live) {
      const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
      expect(history.flatMap(m => m.type === "message" ? [m.message] : []))
          .toEqual(messages.map(m => m.text));
      for (const { id, file: f } of messages.flatMap(m => m.attachments)) {
        owner.set(id, chatId);
        // capnweb hands Node a Buffer; compare the bytes, not the class.
        expect(new Uint8Array(await ws.getChatAttachmentContent(chatId, id))).toEqual(files[f]!.bytes);
      }
    }
    // A chat the user starts now holds none of them: every id, live or deleted, must miss there.
    // Each live id is also tried in one other live chat, and each deleted chat's ids in its old id
    // (which a later chat may now hold) and every live chat.
    const chatIds = [...live.keys()];
    const fresh = await ws.newChat("Starting over", null);
    for (const [id, chatId] of owner) {
      await expect(ws.getChatAttachmentContent(fresh, id)).rejects.toThrow("Chat attachment not found.");
      const other = chatIds.find(c => c !== chatId);
      if (other !== undefined) {
        await expect(ws.getChatAttachmentContent(other, id)).rejects.toThrow("Chat attachment not found.");
      }
    }
    for (const [chatId, ids] of deleted) {
      if (!live.has(chatId)) expect((await ws.getChatHistory(chatId)).messages).toEqual([]);
      for (const id of ids) {
        for (const c of new Set([chatId, fresh, ...chatIds])) {
          await expect(ws.getChatAttachmentContent(c, id)).rejects.toThrow("Chat attachment not found.");
        }
      }
    }
  }), { ...PROPERTY_RUN_OPTIONS, numRuns: 15 });
});

// ---------------------------------------------------------------------------------------------
// Code-change submission: two editors type into one chat's draft, each from whatever revision of
// the change stream it had seen (up to a few behind), and retry a submission as a dropped
// connection would. However stale the base, every insertion lands exactly once, the original lines
// keep their order, a retry is acknowledged without being applied again, and accepting the draft
// commits exactly the text the change stream describes.

class ChangeRecorder extends RpcTarget implements AiChatSubscriber {
  readonly applied: { chatId: number; revision: number; change: CodeChange }[] = [];
  streamGeneration(_generation: number): void {}
  metadata(_chat: AiChatMetadata): void {}
  deleted(_chatId: number): void {}
  message(_message: AiChatMessage): void {}
  changeApplied(chatId: number, _generation: number, revision: number, _author: AiChatAuthorInfo,
                change: CodeChange): void {
    this.applied.push({ chatId, revision, change });
  }
  stream(_chatId: number, _event: AiChatStreamEvent): void {}
}

const PATH = "app.txt";
const SEED_LINES = ["alpha", "beta", "gamma", "delta"];
const linesOf = (text: string) => text.split("\n").slice(0, -1);
const textOf = (lines: string[]) => lines.map(line => `${line}\n`).join("");
const files = (gadgetId: number, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [[PATH, text]])]]);

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

const editorOp = fc.record({
  client: fc.constantFrom("left", "right"),
  lag: fc.nat({ max: 3 }),
  at: fc.nat(),
  retry: fc.boolean(),
});

it.concurrent("stale and retried edits converge, and accepting commits the converged text", async () => {
  await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: SEED_LINES.length }),
      fc.array(editorOp, { minLength: 1, maxLength: 8 }),
      async (seedCount, ops) => {
    using stack = new DisposableStack();
    const { ws } = await freshWorkspace(stack, "editors");
    const workpieces = new WorkpieceRecorder();
    const recorder = new ChangeRecorder();
    stack.use(await ws.subscribeToWorkpieces(stack.use(stubFor(workpieces))));
    stack.use(await ws.subscribeToChat(stack.use(stubFor(recorder))));
    await workpieces.loaded;

    const seedLines = SEED_LINES.slice(0, seedCount);
    const seed = textOf(seedLines);
    const gadget = stack.use(ws.createGadget("App", undefined, "APP"));
    const gadgetId = await gadget.getId();
    const empty = await headOf(workpieces, gadgetId);
    const seedChat = await ws.newChat("Seed", null);
    await ws.submitCodeChange(seedChat, {
      generation: 0, revision: 0, clientId: "seed", seq: 1,
      pins: [{ gadgetId, baseCommit: empty }], change: diffFiles(files(gadgetId), files(gadgetId, seed)),
    });
    expect(await ws.mergeChanges(seedChat)).toEqual({ outcome: "merged" });
    const head = await headOf(workpieces, gadgetId, empty);

    const chatId = await ws.newChat("Edit together", null);
    const pins = [{ gadgetId, baseCommit: head }];
    const seqs = { left: 0, right: 0 };
    const stream = (count: number) => waitFor(`${count} changes to chat ${chatId}`, async () => {
      const changes = recorder.applied.filter(c => c.chatId === chatId);
      return changes.length >= count ? changes.toSorted((a, b) => a.revision - b.revision) : null;
    });
    const textAt = (changes: { change: CodeChange }[]) => {
      const text = changes.reduce((content, { change }) => applyCodeChange(content, change),
          files(gadgetId, seed)).get(gadgetId)?.get(PATH);
      if (typeof text !== "string") throw new Error(`${PATH} is not text`);
      return text;
    };

    const markers: string[] = [];
    let revision = 0;
    for (const [i, op] of ops.entries()) {
      const base = Math.max(0, revision - op.lag);
      const before = textAt((await stream(revision)).slice(0, base));
      const lines = linesOf(before);
      const marker = `${op.client} ${i}`;
      lines.splice(op.at % (lines.length + 1), 0, marker);
      markers.push(marker);
      const submission = {
        generation: 0, revision: base, clientId: op.client, seq: ++seqs[op.client], pins,
        change: diffFiles(files(gadgetId, before), files(gadgetId, textOf(lines))),
      };
      const ack = await ws.submitCodeChange(chatId, submission);
      expect(ack).toEqual({ generation: 0, revision: ++revision });
      if (op.retry) expect(await ws.submitCodeChange(chatId, submission)).toEqual(ack);
    }

    const converged = textAt(await stream(revision));
    const lines = linesOf(converged);
    expect(lines.filter(line => !markers.includes(line))).toEqual(seedLines);
    expect(lines.filter(line => markers.includes(line)).toSorted()).toEqual(markers.toSorted());

    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    const merged = await headOf(workpieces, gadgetId, head);
    expect(await ws.readFilesAtCommit(merged, [PATH])).toEqual([[PATH, { kind: "text", text: converged }]]);
    expect(recorder.applied.filter(c => c.chatId === chatId)).toHaveLength(revision);
  }), { ...PROPERTY_RUN_OPTIONS, numRuns: 15 });
});
