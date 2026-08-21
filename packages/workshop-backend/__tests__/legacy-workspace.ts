// Shared fixture for the git-migration test suites: a synthetic pre-git-storage workspace whose
// code log is written the way the legacy system wrote it, plus a content-fidelity oracle
// (`expectHeadsMatchDoc`) that checks migrated gadget heads against an independent replay of the
// recorded Yjs update log. Used both by the unit suite (git-migration.test.ts, over mock
// storage) and by the DO-level integration tests (git-migration-do.test.ts, over a real
// Durable Object's storage).

import { expect } from "vitest";
import * as Y from "yjs";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiChatMessage, ChatCodeBase, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { applyCodeChange, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { makeMockStorage } from "./mock-storage";
import { makeOverseerStorage, type OverseerStorage } from "../src/overseer";
import { GitStore } from "../src/git-store";
import type { GitMigrationHost } from "../src/git-migration";

export const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
export const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
export const OWNER = { name: "Alice", email: "alice@example.com" };

export const T0 = Date.UTC(2024, 0, 1);
export const MINUTE = 60_000;

/**
 * Builds a synthetic pre-git-storage workspace: a legacy code log written the way the old
 * updateCode() wrote it (incremental V2 updates against one workspace-wide doc, versions drawn
 * from the shared change counter -- so `skipVersions` models the gaps that non-code changes
 * left), plus gadget records, chats (with legacy Yjs-update messages and drafts), and blueprint
 * records. Defaults to mock storage; pass a real DO's storage to seed the workspace in place.
 */
export class LegacyWorkspace {
  readonly storage: OverseerStorage;
  readonly gitStore: GitStore;

  #doc = new Y.Doc();
  #version = 0;
  #updates: Uint8Array[] = [];
  #timestamp = 0;

  constructor(storage: OverseerStorage = makeOverseerStorage(makeMockStorage())) {
    this.storage = storage;
    this.gitStore = new GitStore(storage.gitObjects);
    // Legacy workspaces always wrote an (often empty) version 1 at initialization.
    this.edit(T0, () => {});
  }

  /** Applies `fn` to the mainline doc and records the resulting update as the next version. */
  edit(timestampMs: number, fn: (doc: Y.Doc) => void): number {
    let captured: Uint8Array[] = [];
    let handler = (update: Uint8Array) => captured.push(update);
    this.#doc.on("updateV2", handler);
    this.#doc.transact(() => fn(this.#doc));
    this.#doc.off("updateV2", handler);
    let update = captured.length > 0
        ? Y.mergeUpdatesV2(captured) : Y.encodeStateAsUpdateV2(new Y.Doc());
    this.#updates.push(update);
    let version = ++this.#version;
    this.storage.code.put({ version, timestamp: new Date(timestampMs), update });
    return version;
  }

  /** Models non-code changes consuming versions from the shared counter (binding edits etc.). */
  skipVersions(count: number): void {
    this.#version += count;
  }

  /** A fresh doc replaying the recorded log through `version` ("current" = all of it). */
  docAt(version: number | "current"): Y.Doc {
    let doc = new Y.Doc();
    let count = version === "current" ? this.#updates.length : version;
    for (let update of this.#updates.slice(0, count)) {
      Y.applyUpdateV2(doc, update);
    }
    return doc;
  }

  addGadget(id: number, bindingName: string,
            pending?: { chatId: number, sequence?: number }): void {
    this.storage.gadgets.put({
      id, title: bindingName, created: new Date(T0), bindingName, bindings: {},
      ...(pending !== undefined ? { pending } : {}),
    });
  }

  addChat(id: number): void {
    this.storage.chatMeta.put(
        { id, title: "Chat", started: new Date(T0), lastActive: new Date(T0 + id) });
  }

  addMessage(chatId: number, author: AiChatAuthorInfo, body: object): number {
    // Sequences come from the real counter collection, exactly as the legacy system allocated
    // them (the migration's conversion message continues the same counter).
    let sequence = this.storage.nextChatSequences.get(chatId)?.nextSequence ?? 0;
    this.storage.nextChatSequences.put({ chatId, nextSequence: sequence + 1 });
    // Legacy bodies (e.g. merge messages without `commits`, changes messages carrying a retired
    // Yjs `update`) are exactly what the migration consumes, so this deliberately bypasses the
    // current wire type.
    this.storage.chats.put({
      chatId, sequence, timestamp: new Date(T0 + ++this.#timestamp), author, ...body,
    } as AiChatMessage);
    return sequence;
  }

  /** Records a legacy live draft (see ChatDraftUpdateRecord in overseer.ts). */
  addDraft(chatId: number, update: Uint8Array): void {
    this.storage.chatDraftUpdates.put({
      chatId, timestamp: new Date(T0 + ++this.#timestamp), author: USER, update,
    });
  }

  host(defaultGadgetId?: number): GitMigrationHost {
    return {
      storage: this.storage,
      gitStore: this.gitStore,
      ownerIdentity: OWNER,
      defaultGadgetId,
      createDefaultGadget: () => {
        // Mirrors OverseerImpl.ensureDefaultGadget(undefined): allocate from the real counter,
        // record the default (so gadgetRootName below maps it to ""), leave the head to the
        // migration. A fixed `created` keeps synthesized empty-tree commits deterministic.
        let id = this.storage.nextGatekeeperId.get();
        this.storage.nextGatekeeperId.put(id + 1);
        this.storage.defaultGadgetId.put(id);
        defaultGadgetId = id;
        this.storage.gadgets.put({
          id, title: "Workspace", created: new Date(T0), bindingName: "GADGET", bindings: {},
        });
        return id;
      },
      gadgetRootName: (id) => id === defaultGadgetId ? "" : `${id}`,
      getActiveChatCompaction: (chatId) => {
        let compactedTo = this.storage.chatMeta.get(chatId)?.compactedTo;
        return compactedTo === undefined ? undefined
            : this.storage.chatCompactions.get(
                `${keyString(chatId)}.${keyString(compactedTo)}`);
      },
      // The shared counter keeps conversion timestamps unique against every message's (the
      // chats collection's byTimestamp index is unique), like the real getChatTimestamp().
      getChatTimestamp: () => new Date(T0 + ++this.#timestamp),
    };
  }

  mergeMessages(chatId: number): Extract<AiChatMessage, { type: "merge" }>[] {
    return [...this.storage.chats.list({ prefix: `${keyString(chatId)}.` })]
        .filter(msg => msg.type === "merge");
  }

  messages(chatId: number): AiChatMessage[] {
    return [...this.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
  }

  conversionMessage(chatId: number): Extract<AiChatMessage, { type: "changes" }> {
    let found = this.messages(chatId).filter(
        msg => msg.type === "changes" && msg.conversionBoundary);
    expect(found).toHaveLength(1);
    return found[0] as Extract<AiChatMessage, { type: "changes" }>;
  }

  codeBase(chatId: number): ChatCodeBase | undefined {
    return this.storage.chatMeta.get(chatId)?.codeBase;
  }

  /** The chat's converted content: the pin bases with the conversion change applied on top. */
  async convertedContent(chatId: number): Promise<CodeContent> {
    let conversion = this.conversionMessage(chatId);
    let content: CodeContent = new Map();
    for (let pin of conversion.pins ?? []) {
      content.set(pin.gadgetId, await this.gitStore.readCommitFiles(pin.baseCommit));
    }
    return conversion.change !== undefined ? applyCodeChange(content, conversion.change) : content;
  }
}

export function setFile(doc: Y.Doc, root: string, name: string, text: string): void {
  doc.getMap<Y.Text>(root).set(name, new Y.Text(text));
}

/**
 * Captures the update of one edit made against `doc` (a chat-local edit, never applied to the
 * mainline log).
 */
export function captureEdit(doc: Y.Doc, fn: (doc: Y.Doc) => void): Uint8Array {
  let captured: Uint8Array[] = [];
  let handler = (update: Uint8Array) => captured.push(update);
  doc.on("updateV2", handler);
  doc.transact(() => fn(doc));
  doc.off("updateV2", handler);
  return Y.mergeUpdatesV2(captured);
}

/**
 * `name -> text` snapshot of one root map of a legacy code doc, mirroring git-migration.ts's
 * private reader of the same name.
 */
export function readDocFiles(doc: Y.Doc, rootName: string): Map<string, string> {
  let files = new Map<string, string>();
  for (let [name, text] of doc.getMap<Y.Text>(rootName)) {
    files.set(name, text.toString());
  }
  return files;
}

/**
 * The content-fidelity oracle: asserts every non-pending gadget's migrated head tree equals the
 * legacy doc's content for that gadget's root ("" for the default gadget), and that pending
 * gadgets got no head. Callers pass an independently replayed doc (e.g. `ws.docAt("current")`),
 * so this checks the full log-replay -> commit-point -> tree-write pipeline against the recorded
 * update log rather than against the migration's own doc.
 */
export async function expectHeadsMatchDoc(
    storage: Pick<OverseerStorage, "gadgets">, gitStore: GitStore, doc: Y.Doc,
    defaultGadgetId?: WorkpieceId): Promise<void> {
  for (let gadget of storage.gadgets.list()) {
    if (gadget.pending !== undefined) {
      expect(gadget.commitId).toBeUndefined();
      continue;
    }
    let root = gadget.id === defaultGadgetId ? "" : `${gadget.id}`;
    expect(gadget.commitId).toBeDefined();
    expect(await gitStore.readCommitFiles(gadget.commitId!)).toEqual(readDocFiles(doc, root));
  }
}
