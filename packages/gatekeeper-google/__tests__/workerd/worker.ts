import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { GmailForwardSnapshotStore } from "../../src/gmail-state";
import { GmailGatekeeperImpl, type GmailGatekeeperImplProps } from "../../src/gmail";
import { UserAccount } from "../../src/google";
import type {ActionKind} from "@gadgets/workshop-shared/gatekeeper";
import type {
  GmailComposeOptions, GmailDraftInput, GmailDraftPatch, GmailMessage, GmailReplyOptions,
  GmailSession,
} from "../../src/types";

export { default } from "../../src/google";
export { GmailGatekeeperImpl, UserAccount };

type StorageOperation =
  | {kind: "put"; key: string; value: unknown}
  | {kind: "delete"; key: string};

type TestGmail = GmailGatekeeperImpl & {
  applyTestStorage(operations: StorageOperation[]): void;
  readTestStorage(): Array<[string, unknown]>;
  captureTestSnapshot(bytes: Uint8Array): Promise<unknown>;
  runTestOperation(queue: unknown, operation: string, args: unknown[]): Promise<unknown>;
};

async function withMessage<T>(
    session: GmailSession, id: string, callback: (message: GmailMessage) => Promise<T>,
): Promise<T> {
  if (/^[a-f0-9]{1,256}$/i.test(id) || /^<[^<>\s@]+@[^<>\s@]+>$/.test(id)) {
    const message = await session.getMessage(id);
    try {
      return await callback(message);
    } finally {
      disposeRpc(message);
    }
  }
  const cursor = await session.listMessages();
  try {
    const entries = await cursor.next();
    const entry = entries?.find(candidate => candidate.info.id === id);
    try {
      if (!entry) throw new Error(`Test message was not found: ${id}`);
      return await callback(entry.message);
    } finally {
      for (const candidate of entries ?? []) disposeRpc(candidate.message);
    }
  } finally {
    disposeRpc(cursor);
  }
}

function disposeRpc(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  (value as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
}

class TestApprovalQueue extends RpcTarget {
  #submissions: Array<{actionId: number; description: unknown}> = [];
  #observations: unknown[] = [];
  #rejection?: string;
  #pausedTitle?: string;
  #paused?: Promise<void>;
  #markPaused?: () => void;
  #release?: Promise<void>;
  #releasePaused?: () => void;
  #pausedSubmission?: Promise<void>;
  #markSubmissionPaused?: () => void;
  #releaseSubmission?: Promise<void>;
  #releasePausedSubmission?: () => void;

  constructor(rejection?: string) {
    super();
    this.#rejection = rejection;
  }

  async authorizeObservation(description: unknown): Promise<void> {
    this.#observations.push(description);
    if (this.#pausedTitle && typeof description === "object" && description !== null &&
        "title" in description && description.title === this.#pausedTitle) {
      this.#pausedTitle = undefined;
      this.#markPaused?.();
      await this.#release;
      this.#paused = undefined;
      this.#markPaused = undefined;
      this.#release = undefined;
      this.#releasePaused = undefined;
    }
  }

  async submitAction(actionId: number, description: unknown): Promise<void> {
    this.#submissions.push({actionId, description});
    if (this.#pausedSubmission) {
      this.#markSubmissionPaused?.();
      await this.#releaseSubmission;
      this.#pausedSubmission = undefined;
      this.#markSubmissionPaused = undefined;
      this.#releaseSubmission = undefined;
      this.#releasePausedSubmission = undefined;
    }
    if (this.#rejection) throw new Error(this.#rejection);
  }

  read() {
    return {submissions: [...this.#submissions], observations: [...this.#observations]};
  }

  pauseObservation(title: string): void {
    if (this.#paused) throw new Error("A test observation is already paused.");
    this.#pausedTitle = title;
    this.#paused = new Promise(resolve => { this.#markPaused = resolve; });
    this.#release = new Promise(resolve => { this.#releasePaused = resolve; });
  }

  waitForPausedObservation(): Promise<void> {
    if (!this.#paused) throw new Error("No test observation is configured to pause.");
    return this.#paused;
  }

  releasePausedObservation(): void {
    if (!this.#releasePaused) throw new Error("The test observation has not paused yet.");
    this.#releasePaused();
  }

  pauseActionSubmission(): void {
    if (this.#pausedSubmission) throw new Error("A test action submission is already paused.");
    this.#pausedSubmission = new Promise(resolve => { this.#markSubmissionPaused = resolve; });
    this.#releaseSubmission = new Promise(resolve => { this.#releasePausedSubmission = resolve; });
  }

  waitForPausedActionSubmission(): Promise<void> {
    if (!this.#pausedSubmission) throw new Error("No test action submission is configured to pause.");
    return this.#pausedSubmission;
  }

  releasePausedActionSubmission(): void {
    if (!this.#releasePausedSubmission) throw new Error("The test action submission has not paused yet.");
    this.#releasePausedSubmission();
  }

  [Symbol.dispose](): void {}
}

/** Test-only hook that creates and drives the props-bearing Gmail facet. */
export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, TestApprovalQueue>();

  #gatekeeper(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
  ) {
    const exports = this.ctx.exports as unknown as {
      GmailGatekeeperImpl(options: {props: GmailGatekeeperImplProps}):
        DurableObjectClass<GmailGatekeeperImpl>;
    };
    return this.ctx.facets.get<GmailGatekeeperImpl>(facetName, () => ({
      id, class: exports.GmailGatekeeperImpl({props}),
    }));
  }

  async initialize(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
  ): Promise<void> {
    this.#gatekeeper(facetName, id, props);
  }

  async startSession(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      queueId: string, rejection?: string,
  ): Promise<void> {
    this.#queues.set(queueId, new TestApprovalQueue(rejection));
    this.#gatekeeper(facetName, id, props);
  }

  async applyAction(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      actionId: number,
  ): Promise<void> {
    await this.#gatekeeper(facetName, id, props).applyAction(actionId);
  }

  async getAutoApprovableActions(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
  ): Promise<ActionKind[]> {
    return this.#gatekeeper(facetName, id, props).getAutoApprovableActions();
  }

  async describe(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
  ) {
    return this.#gatekeeper(facetName, id, props).describe();
  }

  async rejectAction(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      actionId: number,
  ): Promise<void> {
    await this.#gatekeeper(facetName, id, props).rejectAction(actionId);
  }

  async runSessionOperation(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      queueId: string, operation: string, args: unknown[],
  ): Promise<unknown> {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    const queueStub = new RpcStub(queue);
    try {
      return await (this.#gatekeeper(facetName, id, props) as unknown as TestGmail)
        .runTestOperation(queueStub, operation, args);
    } finally {
      queueStub[Symbol.dispose]();
    }
  }

  async readQueue(queueId: string): Promise<{
    submissions: Array<{actionId: number; description: unknown}>;
    observations: unknown[];
  }> {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    return queue.read();
  }

  pauseObservation(queueId: string, title: string): void {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    queue.pauseObservation(title);
  }

  waitForPausedObservation(queueId: string): Promise<void> {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    return queue.waitForPausedObservation();
  }

  releasePausedObservation(queueId: string): void {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    queue.releasePausedObservation();
  }

  pauseActionSubmission(queueId: string): void {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    queue.pauseActionSubmission();
  }

  waitForPausedActionSubmission(queueId: string): Promise<void> {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    return queue.waitForPausedActionSubmission();
  }

  releasePausedActionSubmission(queueId: string): void {
    const queue = this.#queues.get(queueId);
    if (!queue) throw new Error(`Unknown test approval queue: ${queueId}`);
    queue.releasePausedActionSubmission();
  }

  async applyStorage(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      operations: StorageOperation[],
  ): Promise<void> {
    (this.#gatekeeper(facetName, id, props) as unknown as TestGmail)
      .applyTestStorage(operations);
  }

  async readStorage(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
  ): Promise<Array<[string, unknown]>> {
    return (this.#gatekeeper(facetName, id, props) as unknown as TestGmail).readTestStorage();
  }

  async captureForwardSnapshot(
      facetName: string, id: string, props: GmailGatekeeperImplProps, bytes: Uint8Array,
  ): Promise<unknown> {
    return (this.#gatekeeper(facetName, id, props) as unknown as TestGmail)
      .captureTestSnapshot(bytes);
  }
}

const testGmailPrototype = GmailGatekeeperImpl.prototype as TestGmail;

type TestDurableObjectState = {ctx: {storage: DurableObjectStorage}};

function testStorage(instance: GmailGatekeeperImpl): DurableObjectStorage {
  return (instance as unknown as TestDurableObjectState).ctx.storage;
}

// These helpers are installed only in this test Worker. The exported class remains the production
// implementation, including its real capnweb-validated RPC surface.
testGmailPrototype.applyTestStorage = function(operations: StorageOperation[]): void {
  const storage = testStorage(this);
  for (const operation of operations) {
    if (operation.kind === "put") storage.kv.put(operation.key, operation.value);
    else storage.kv.delete(operation.key);
  }
};

testGmailPrototype.readTestStorage = function(): Array<[string, unknown]> {
  return [...testStorage(this).kv.list()];
};

testGmailPrototype.captureTestSnapshot = function(bytes: Uint8Array) {
  return new GmailForwardSnapshotStore(testStorage(this)).capture(bytes);
};

testGmailPrototype.runTestOperation = async function(
    queue: unknown, operation: string, args: unknown[],
): Promise<unknown> {
  const session = await this.startSession(queue as never) as GmailSession;
  const [id, value, extra, options] = args;
  try {
    switch (operation) {
  case "session.hasMailboxMethods":
    return ["send", "createDraft", "listLabels", "createLabel", "renameLabel", "deleteLabel"]
      .every(method => method in session);
  case "session.getMailboxAddress":
    return await session.getMailboxAddress();
  case "session.send":
    return await session.send(id as string[], value as string, extra as string, options as GmailComposeOptions);
  case "session.listThreads": {
    const cursor = await session.listThreads();
    try {
      const entries = await cursor.next();
      const result = entries?.map(entry => entry.info) ?? null;
      for (const entry of entries ?? []) disposeRpc(entry.thread);
      return result;
    } finally {
      disposeRpc(cursor);
    }
  }
  case "session.listMessages": {
    const cursor = await session.listMessages();
    try {
      const entries = await cursor.next();
      const result = entries?.map(entry => entry.info) ?? null;
      for (const entry of entries ?? []) disposeRpc(entry.message);
      return result;
    } finally {
      disposeRpc(cursor);
    }
  }
  case "session.listDrafts": {
    const cursor = await session.listDrafts();
    try {
      const entries = await cursor.next();
      const result = entries?.map(entry => entry.info) ?? null;
      for (const entry of entries ?? []) disposeRpc(entry.draft);
      return result;
    } finally {
      disposeRpc(cursor);
    }
  }
  case "session.listDraftPages": {
    const cursor = await session.listDrafts();
    const pages = [];
    try {
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const entries = await cursor.next();
        if (!entries) return pages;
        pages.push(entries.map(entry => entry.info));
        for (const entry of entries) disposeRpc(entry.draft);
      }
      throw new Error("Test draft cursor did not terminate.");
    } finally {
      disposeRpc(cursor);
    }
  }
  case "session.getMessage":
    disposeRpc(await session.getMessage(id as string));
    return undefined;
  case "session.getThread":
    disposeRpc(await session.getThread(id as string));
    return undefined;
  case "session.getDraft":
    disposeRpc(await session.getDraft(id as string));
    return undefined;
  case "session.createDraft": {
    const draft = await session.createDraft(id as GmailDraftInput);
    try {
      return await draft.getMetadata();
    } finally {
      disposeRpc(draft);
    }
  }
  case "session.createLabel":
    return await session.createLabel(id as string);
  case "session.renameLabel":
    return await session.renameLabel(id as never, value as string);
  case "session.deleteLabel":
    return await session.deleteLabel(id as never);
  case "message.getMetadata":
    return await withMessage(session, id as string, message => message.getMetadata());
  case "message.getHeaders":
    return await withMessage(session, id as string, message => message.getHeaders());
  case "message.getMetadataTwice":
    return await withMessage(session, id as string, async message => ({
      first: await message.getMetadata(),
      second: await message.getMetadata(),
    }));
  case "message.markReadAndRefresh":
    return await withMessage(session, id as string, async message => {
      const before = await message.getMetadata();
      await message.markRead();
      await this.applyAction(value as number);
      return {before, after: await message.getMetadata()};
    });
  case "message.thread":
    return await withMessage(session, id as string, async message => {
      const thread = await message.thread();
      try {
        return await thread.getMetadata();
      } finally {
        disposeRpc(thread);
      }
    });
  case "message.reply":
    return await withMessage(session, id as string, message =>
      message.reply(value as string, extra as GmailReplyOptions));
  case "message.replyAll":
    return await withMessage(session, id as string, message =>
      message.replyAll(value as string, extra as GmailReplyOptions));
  case "message.forward":
    return await withMessage(session, id as string, message => message.forward(
      value as string[], extra as string, options as GmailComposeOptions));
  case "message.archive":
    return await withMessage(session, id as string, message => message.archive());
  case "message.createReplyDraft": {
    return await withMessage(session, id as string, async message => {
      const draft = await message.createReplyDraft(value as string, extra as GmailReplyOptions);
      try {
        return await draft.getMetadata();
      } finally {
        disposeRpc(draft);
      }
    });
  }
  case "message.createReplyAllDraft": {
    return await withMessage(session, id as string, async message => {
      const draft = await message.createReplyAllDraft(value as string, extra as GmailReplyOptions);
      try {
        return await draft.getMetadata();
      } finally {
        disposeRpc(draft);
      }
    });
  }
  case "message.createForwardDraft": {
    return await withMessage(session, id as string, async message => {
      const draft = await message.createForwardDraft(
        value as string[], extra as string, options as GmailComposeOptions);
      try {
        return await draft.getMetadata();
      } finally {
        disposeRpc(draft);
      }
    });
  }
  case "message.applyLabel":
    return await withMessage(session, id as string, message => message.applyLabel(value as never));
  case "message.removeLabel":
    return await withMessage(session, id as string, message => message.removeLabel(value as never));
  case "thread.getMetadata": {
    const thread = await session.getThread(id as string);
    try {
      return await thread.getMetadata();
    } finally {
      disposeRpc(thread);
    }
  }
  case "thread.getMetadataTwice": {
    const thread = await session.getThread(id as string);
    try {
      return {first: await thread.getMetadata(), second: await thread.getMetadata()};
    } finally {
      disposeRpc(thread);
    }
  }
  case "thread.messages": {
    const thread = await session.getThread(id as string);
    try {
      const messages = await thread.messages();
      try {
        return await Promise.all(messages.map(message => message.getMetadata()));
      } finally {
        for (const message of messages) disposeRpc(message);
      }
    } finally {
      disposeRpc(thread);
    }
  }
  case "thread.messagesVisibleTo": {
    const thread = await session.getThread(id as string);
    try {
      const messages = await thread.messagesVisibleTo(value as string);
      try {
        return await Promise.all(messages.map(message => message.getMetadata()));
      } finally {
        for (const message of messages) disposeRpc(message);
      }
    } finally {
      disposeRpc(thread);
    }
  }
  case "draft.getMetadata": {
    const draft = await session.getDraft(id as string);
    try {
      return await draft.getMetadata();
    } finally {
      disposeRpc(draft);
    }
  }
  case "draft.getContent": {
    const draft = await session.getDraft(id as string);
    try {
      return await draft.getContent();
    } finally {
      disposeRpc(draft);
    }
  }
  case "draft.attachments": {
    const draft = await session.getDraft(id as string);
    try {
      const entries = await draft.attachments();
      try {
        return await Promise.all(entries.map(async entry => ({
          info: entry.info,
          content: entry.info.readable ? await entry.attachment.getContent() : undefined,
        })));
      } finally {
        for (const entry of entries) disposeRpc(entry.attachment);
      }
    } finally {
      disposeRpc(draft);
    }
  }
  case "draft.update": {
    const draft = await session.getDraft(id as string);
    try {
      return await draft.update(value as GmailDraftPatch);
    } finally {
      disposeRpc(draft);
    }
  }
  case "draft.send": {
    const draft = await session.getDraft(id as string);
    try {
      return await draft.send();
    } finally {
      disposeRpc(draft);
    }
  }
  case "draft.delete": {
    const draft = await session.getDraft(id as string);
    try {
      return await draft.delete();
    } finally {
      disposeRpc(draft);
    }
  }
    default:
      throw new Error(`Unknown test Gmail operation: ${operation}`);
    }
  } finally {
    disposeRpc(session);
  }
};
