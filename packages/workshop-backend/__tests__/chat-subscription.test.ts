// subscribeToChat's change-row replay and the retired-row lifecycle, over the production
// chatChanges collection (liveByChat / retiredByTimestamp indexes) on mock storage.

import { describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { Collection } from "@gadgets/typed-storage";
import type {
  AiChatMessage, AiChatMetadata, AiChatSubscriber,
} from "@gadgets/workshop-shared/api";
import { CHAT_REPLAY_PAGE_SIZE } from "../src/overseer.js";
import type { ChatChangeRecord } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import {
  FIXTURE_EPOCH, makeActionStorage, makePreIndexChatChangeStorage, openFakeOverseer,
} from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const USER = { type: "user", id: "alice@example.com", name: "Alice" } as const;

// Hand-rolled AiChatSubscriber stub. Collects delivered changes and messages; `changeApplied`
// can be overridden to gate or fail deliveries.
function makeChatSubscriber(
    changeApplied?: (chatId: number, generation: number, revision: number) => Promise<void>) {
  let changes: Array<{ chatId: number, generation: number, revision: number }> = [];
  let messages: AiChatMessage[] = [];
  let disposeCount = 0;
  let subscriber = {
    streamGeneration: async () => {},
    metadata: async (_meta: AiChatMetadata) => {},
    deleted: async () => {},
    message: async (msg: AiChatMessage) => { messages.push(msg); },
    changeApplied: changeApplied ?? (async (chatId: number, generation: number,
                                            revision: number) => {
      changes.push({ chatId, generation, revision });
    }),
    stream: async () => {},
    dup: () => subscriber,
    onRpcBroken: () => {},
    [Symbol.dispose]: () => { ++disposeCount; },
  };
  return {
    subscriber: subscriber as unknown as RpcStub<AiChatSubscriber>,
    changes, messages, disposeCount: () => disposeCount,
  };
}

// Puts one change row; timestamp defaults to FIXTURE_EPOCH + revision.
function putChange(
    storage: { chatChanges: Collection<ChatChangeRecord, string> },
    chatId: number, generation: number, revision: number,
    opts: { retired?: boolean, timestamp?: Date } = {}) {
  storage.chatChanges.put({
    chatId, generation, revision,
    timestamp: opts.timestamp ?? new Date(FIXTURE_EPOCH + revision),
    author: USER,
    change: {},
    source: "user",
    ...(opts.retired ? { retired: true as const } : {}),
  });
}

// chatMeta.byLastActive is unique, so lastActive must differ per chat.
function putMeta(storage: ReturnType<typeof makeActionStorage>, id: number,
                 opts: { hasProposedChanges?: boolean } = {}) {
  storage.chatMeta.put({
    id, title: `Chat ${id}`, started: new Date(FIXTURE_EPOCH),
    lastActive: new Date(FIXTURE_EPOCH + id),
    ...(opts.hasProposedChanges === false ? {} : { hasProposedChanges: true }),
  });
}

describe("subscribeToChat replay", () => {
  it("replays only live rows of flagged chats, in (generation, revision) order per chat",
      async () => {
    let storage = makeActionStorage();
    putMeta(storage, 1);
    putMeta(storage, 2);
    putMeta(storage, 3, { hasProposedChanges: false });
    putChange(storage, 1, 0, 1, { retired: true, timestamp: new Date() });
    putChange(storage, 1, 0, 2, { retired: true, timestamp: new Date() });
    putChange(storage, 1, 1, 1);
    putChange(storage, 1, 1, 2);
    putChange(storage, 2, 0, 1);
    putChange(storage, 3, 0, 1);  // chat not flagged: skipped
    let client = await openFakeOverseer(storage);
    let { subscriber, changes } = makeChatSubscriber();

    using _sub = await client.subscribeToChat(subscriber);
    expect(changes).toEqual([
      { chatId: 1, generation: 1, revision: 1 },
      { chatId: 1, generation: 1, revision: 2 },
      { chatId: 2, generation: 0, revision: 1 },
    ]);
  });

  it("pages the replay, awaiting each page", async () => {
    let storage = makeActionStorage();
    putMeta(storage, 1);
    let total = 2 * CHAT_REPLAY_PAGE_SIZE + 3;
    for (let rev = 1; rev <= total; rev++) putChange(storage, 1, 0, rev);
    let client = await openFakeOverseer(storage);
    let release!: () => void;
    let gate = new Promise<void>(resolve => { release = resolve; });
    let inFlight = 0, maxInFlight = 0, delivered = 0;
    let { subscriber } = makeChatSubscriber(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await gate;
      --inFlight;
      ++delivered;
    });

    let pending = client.subscribeToChat(subscriber);
    expect(maxInFlight).toBe(CHAT_REPLAY_PAGE_SIZE);  // only the first page is in flight
    release();
    using _sub = await pending;
    expect(delivered).toBe(total);
    expect(maxInFlight).toBe(CHAT_REPLAY_PAGE_SIZE);
  });

  it("swallows a mid-replay delivery failure and unsubscribes", async () => {
    let storage = makeActionStorage();
    putMeta(storage, 1);
    putChange(storage, 1, 0, 1);
    let client = await openFakeOverseer(storage);
    let { subscriber, messages, disposeCount } = makeChatSubscriber(async () => {
      throw new Error("delivery failed");
    });

    using _sub = await client.subscribeToChat(subscriber);  // resolves despite the failure
    storage.chats.put({ chatId: 1, sequence: 1, timestamp: new Date(FIXTURE_EPOCH),
                        author: USER, type: "message", message: "hi" });
    expect(messages).toEqual([]);  // already unsubscribed: no live delivery
    expect(disposeCount()).toBe(1);  // the failure tore down exactly once
  });

  it("delivers a materialization landing mid-replay via the early-attached subscription",
      async () => {
    let storage = makeActionStorage();
    putMeta(storage, 1);
    let total = CHAT_REPLAY_PAGE_SIZE + 2;  // two pages
    for (let rev = 1; rev <= total; rev++) {
      putChange(storage, 1, 0, rev, { timestamp: new Date() });
    }
    let client = await openFakeOverseer(storage);
    let release!: () => void;
    let gate = new Promise<void>(resolve => { release = resolve; });
    let revisions: number[] = [];
    let { subscriber, messages } = makeChatSubscriber(async (_chatId, _generation, revision) => {
      revisions.push(revision);
      await gate;
    });

    let pending = client.subscribeToChat(subscriber);
    // Mimic a materialization while the first page is parked: retire every row and append the
    // "changes" message that absorbed them.
    for (let row of Array.from(storage.chatChanges.list())) {
      row.retired = true;
      storage.chatChanges.put(row);
    }
    storage.chats.put({ chatId: 1, sequence: 1, timestamp: new Date(FIXTURE_EPOCH), author: USER,
        type: "changes", watermark: { changesGeneration: 0, throughRevision: total } });
    release();
    using _sub = await pending;

    expect(messages.map(m => m.type)).toEqual(["changes"]);
    expect(revisions.length).toBe(CHAT_REPLAY_PAGE_SIZE);  // the second page found nothing live
  });
});

describe("retired-row sweep", () => {
  it("expires aged retired rows at subscribe entry, keeping fresh retired and live rows",
      async () => {
    let storage = makeActionStorage();
    let aged = new Date(Date.now() - 10 * 60_000);
    putChange(storage, 1, 0, 1, { retired: true, timestamp: aged });
    putChange(storage, 1, 0, 2, { retired: true, timestamp: new Date() });
    putChange(storage, 1, 0, 3, { timestamp: aged });  // live rows never expire
    let client = await openFakeOverseer(storage);
    let { subscriber } = makeChatSubscriber();

    using _sub = await client.subscribeToChat(subscriber);
    expect([...storage.chatChanges.list()].map(r => r.revision)).toEqual([2, 3]);
  });
});

describe("chat-change index migration", () => {
  it("serves records written before the indexes existed once a rebuild backfills them", () => {
    // Mirrors the version-4 migration: rows predate the index declarations, so each index
    // starts empty until the migration's rebuild() runs.
    let mock = makeMockStorage();
    let legacy = makePreIndexChatChangeStorage(mock);
    putChange(legacy, 1, 0, 1);
    putChange(legacy, 1, 0, 2, { retired: true });
    putChange(legacy, 2, 0, 1, { retired: true });
    putChange(legacy, 2, 0, 2);

    let storage = makeActionStorage(mock);
    storage.chatChanges.liveByChat.rebuild();
    storage.chatChanges.retiredByTimestamp.rebuild();

    // The live index serves exactly the unretired rows, per chat; the retired index serves the
    // retired rows in timestamp order.
    expect([...storage.chatChanges.liveByChat.get(1)].map(r => r.revision)).toEqual([1]);
    expect([...storage.chatChanges.liveByChat.get(2)].map(r => r.revision)).toEqual([2]);
    expect([...storage.chatChanges.retiredByTimestamp.list()]
        .map(r => [r.chatId, r.revision])).toEqual([[2, 1], [1, 2]]);

    // Retiring a backfilled row must not throw on either index's update.
    let row = [...storage.chatChanges.liveByChat.get(1)][0];
    row.retired = true;
    storage.chatChanges.put(row);
    expect([...storage.chatChanges.liveByChat.get(1)]).toEqual([]);
    expect([...storage.chatChanges.retiredByTimestamp.list()].length).toBe(3);
  });
});
