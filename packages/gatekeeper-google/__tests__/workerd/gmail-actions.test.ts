import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {
  ActionDescription, ActionField, ActionKind, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  base64UrlDecodedByteLength, buildEncodedEmail, decodeBase64UrlToBytes, extractRfc822Attachments,
  GmailApi, GmailOutboundSpec, parseMimeMessage,
} from "../../src/google-api";
import {
  GmailDraftState, GmailForwardSnapshotReference,
  gmailDraftStateFingerprint,
} from "../../src/gmail-state";
import type {GmailGatekeeperImpl, GmailGatekeeperImplProps} from "../../src/gmail";
import type {
  EmailContent, GmailAttachmentInfo, GmailComposeOptions, GmailCustomLabel, GmailDraftInfo,
  GmailDraftInput, GmailDraftPatch, GmailMessageInfo, GmailReplyOptions, GmailThreadInfo,
} from "../../src/types";
import {containsBytes} from "../gmail-test-utils";

// The field an approver reads under `label`, from a submitted description.
function fieldOf(description: unknown, label: string): ActionField | undefined {
  return (description as ActionDescription).fields?.find(field => field.label === label);
}

type TestHooks = {
  initialize(
      facetName: string, id: string, props: GmailGatekeeperImplProps): Promise<void>;
  startSession(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      queueId: string, rejection?: string): Promise<void>;
  applyAction(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      actionId: number): Promise<void>;
  getAutoApprovableActions(
      facetName: string, id: string, props: GmailGatekeeperImplProps): Promise<ActionKind[]>;
  describe(
      facetName: string, id: string, props: GmailGatekeeperImplProps): Promise<ResourceDescription>;
  rejectAction(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      actionId: number): Promise<void>;
  runSessionOperation(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      queueId: string, operation: string, args: unknown[]): Promise<unknown>;
  readQueue(queueId: string): Promise<{
    submissions: Array<{actionId: number; description: unknown}>;
    observations: unknown[];
  }>;
  pauseObservation(queueId: string, title: string): void;
  waitForPausedObservation(queueId: string): Promise<void>;
  releasePausedObservation(queueId: string): void;
  pauseActionSubmission(queueId: string): void;
  waitForPausedActionSubmission(queueId: string): Promise<void>;
  releasePausedActionSubmission(queueId: string): void;
  applyStorage(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      operations: StorageOperation[]): Promise<void>;
  readStorage(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
  ): Promise<Array<[string, unknown]>>;
  captureForwardSnapshot(
      facetName: string, id: string, props: GmailGatekeeperImplProps, bytes: Uint8Array,
  ): Promise<GmailForwardSnapshotReference>;
};

const testEnv = env as unknown as {
  GmailGatekeeperImpl: DurableObjectNamespace<GmailGatekeeperImpl>;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace;
};

const TEST_DRAFT_DATE = "Thu, 1 Jan 1970 00:00:00 +0000";

function runHook<T>(
    hook: DurableObjectStub,
    callback: (instance: TestHooks) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(hook, callback as never);
}

type StorageOperation =
  | {kind: "put"; key: string; value: unknown}
  | {kind: "delete"; key: string};

type TestStorage = {
  target: DurableObjectStub;
  facetName?: string;
  id?: string;
  props?: GmailGatekeeperImplProps;
  pending: Promise<void>[];
  kv: {
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

function testStorage(
    target: DurableObjectStub,
    facet?: {name: string; id: string; props: GmailGatekeeperImplProps},
): TestStorage {
  const pending: Promise<void>[] = [];
  let tail = Promise.resolve();
  const enqueue = (operation: StorageOperation): Promise<void> => {
    const result = tail.then(async () => {
      if (facet?.name !== undefined && facet.id !== undefined && facet.props !== undefined) {
        await runHook(target, instance =>
          instance.applyStorage(facet.name, facet.id, facet.props!, [operation]));
      } else {
        await runInDurableObject(target, (_instance: unknown, state: DurableObjectState) => {
          if (operation.kind === "put") state.storage.kv.put(operation.key, operation.value);
          else state.storage.kv.delete(operation.key);
        });
      }
    });
    tail = result.catch(() => undefined);
    pending.push(result);
    return result;
  };
  const kv = {
    put<T>(key: string, value: T): Promise<void> { return enqueue({kind: "put", key, value}); },
    delete(key: string): Promise<void> { return enqueue({kind: "delete", key}); },
  };
  return {
    target,
    ...(facet ? {facetName: facet.name, id: facet.id, props: facet.props} : {}),
    pending,
    kv,
  };
}

async function flushStorage(storage: TestStorage): Promise<void> {
  if (storage.pending.length === 0) return;
  await Promise.all(storage.pending.splice(0));
}

async function readStorageEntries(storage: TestStorage): Promise<Array<[string, unknown]>> {
  await flushStorage(storage);
  if (storage.facetName !== undefined && storage.id !== undefined && storage.props !== undefined) {
    return runHook(storage.target, instance =>
      instance.readStorage(storage.facetName!, storage.id!, storage.props!));
  }
  return runInDurableObject(storage.target, (_instance: unknown, state: DurableObjectState) =>
    [...state.storage.kv.list()]);
}

function storageValues(storage: TestStorage) {
  return {
    get<T>(key: string): Promise<T | undefined> {
      return readStorageEntries(storage).then(entries => entries.find(([entryKey]) => entryKey === key)?.[1] as T | undefined);
    },
    has(key: string): Promise<boolean> {
      return readStorageEntries(storage).then(entries => entries.some(([entryKey]) => entryKey === key));
    },
    keys(): Promise<string[]> {
      return readStorageEntries(storage).then(entries => entries.map(([key]) => key));
    },
    entries(): Promise<Array<[string, unknown]>> {
      return readStorageEntries(storage);
    },
    set<T>(key: string, value: T): Promise<void> {
      return storage.kv.put(key, value).then(() => flushStorage(storage));
    },
    delete(key: string): Promise<void> {
      return storage.kv.delete(key).then(() => flushStorage(storage));
    },
  };
}

type SessionCall = (operation: string, args?: unknown[]) => Promise<unknown>;

class TestCursor<T> {
  constructor(private readonly nextPage: () => Promise<T[] | null>) {}
  next(): Promise<T[] | null> { return this.nextPage(); }
}

class TestAttachment {
  constructor(
      private readonly info: GmailAttachmentInfo,
      private readonly content: ArrayBuffer | undefined,
  ) {}

  getMetadata(): Promise<GmailAttachmentInfo> { return Promise.resolve(this.info); }

  getContent(): Promise<ArrayBuffer> {
    if (this.content === undefined) throw new Error("This Gmail attachment is not readable.");
    return Promise.resolve(this.content.slice(0));
  }
}

class TestDraft {
  constructor(private readonly call: SessionCall, private readonly id: string) {}

  getMetadata(): Promise<GmailDraftInfo> {
    return this.call("draft.getMetadata", [this.id]) as Promise<GmailDraftInfo>;
  }

  getContent(): Promise<EmailContent> {
    return this.call("draft.getContent", [this.id]) as Promise<EmailContent>;
  }

  async attachments(): Promise<Array<{info: GmailAttachmentInfo; attachment: TestAttachment}>> {
    const entries = await this.call("draft.attachments", [this.id]) as Array<{
      info: GmailAttachmentInfo; content?: ArrayBuffer;
    }>;
    return entries.map(entry => ({
      info: entry.info, attachment: new TestAttachment(entry.info, entry.content),
    }));
  }

  update(patch: GmailDraftPatch): Promise<void> {
    return this.call("draft.update", [this.id, patch]) as Promise<void>;
  }

  send(): Promise<string> { return this.call("draft.send", [this.id]) as Promise<string>; }
  delete(): Promise<void> { return this.call("draft.delete", [this.id]) as Promise<void>; }
}

class TestMessage {
  constructor(
      private readonly call: SessionCall, private readonly id: string,
      private readonly initialMetadata?: GmailMessageInfo,
  ) {}

  getMetadata(): Promise<GmailMessageInfo> {
    if (this.initialMetadata !== undefined) return Promise.resolve(this.initialMetadata);
    return this.call("message.getMetadata", [this.id]) as Promise<GmailMessageInfo>;
  }

  getHeaders(): Promise<Array<{name: string; value: string}>> {
    return this.call("message.getHeaders", [this.id]) as Promise<Array<{name: string; value: string}>>;
  }

  markReadAndRefresh(actionId: number): Promise<{
    before: GmailMessageInfo;
    pending: GmailMessageInfo;
    after: GmailMessageInfo;
  }> {
    return this.call("message.markReadAndRefresh", [this.id, actionId]) as Promise<{
      before: GmailMessageInfo;
      pending: GmailMessageInfo;
      after: GmailMessageInfo;
    }>;
  }

  getContent(): Promise<EmailContent> {
    return this.call("message.getContent", [this.id]) as Promise<EmailContent>;
  }

  attachments(): Promise<Array<{info: GmailAttachmentInfo; content?: ArrayBuffer}>> {
    return this.call("message.attachments", [this.id]) as Promise<Array<{
      info: GmailAttachmentInfo; content?: ArrayBuffer;
    }>>;
  }

  readAcrossDecision(actionId: number, decision: "apply" | "reject"): Promise<{
    before: GmailMessageInfo; after?: GmailMessageInfo; error?: string;
  }> {
    return this.call("message.readAcrossDecision", [this.id, actionId, decision]) as Promise<{
      before: GmailMessageInfo; after?: GmailMessageInfo; error?: string;
    }>;
  }

  async thread(): Promise<TestThread> {
    const info = await this.call("message.thread", [this.id]) as GmailThreadInfo;
    return new TestThread(this.call, info.id, info);
  }

  threadMessages(): Promise<GmailMessageInfo[]> {
    return this.call("message.threadMessages", [this.id]) as Promise<GmailMessageInfo[]>;
  }

  threadArchive(lastMessageId?: string): Promise<void> {
    return this.call("message.threadArchive", [this.id, lastMessageId]) as Promise<void>;
  }

  reply(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.call("message.reply", [this.id, body, options]) as Promise<string>;
  }

  replyAll(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.call("message.replyAll", [this.id, body, options]) as Promise<string>;
  }

  forward(to: string[], body?: string, options?: GmailComposeOptions): Promise<string> {
    return this.call("message.forward", [this.id, to, body, options]) as Promise<string>;
  }

  archive(): Promise<void> { return this.call("message.archive", [this.id]) as Promise<void>; }

  mutate(operation: string): Promise<void> {
    return this.call("message.mutate", [this.id, operation]) as Promise<void>;
  }

  async createReplyDraft(body: string, options?: GmailReplyOptions): Promise<TestDraft> {
    const info = await this.call("message.createReplyDraft", [this.id, body, options]) as GmailDraftInfo;
    return new TestDraft(this.call, info.id);
  }

  async createForwardDraft(
      to: string[], body?: string, options?: GmailComposeOptions,
  ): Promise<TestDraft> {
    const info = await this.call("message.createForwardDraft", [this.id, to, body, options]) as GmailDraftInfo;
    return new TestDraft(this.call, info.id);
  }

  applyLabel(label: unknown): Promise<void> {
    return this.call("message.applyLabel", [this.id, label]) as Promise<void>;
  }

  removeLabel(label: unknown): Promise<void> {
    return this.call("message.removeLabel", [this.id, label]) as Promise<void>;
  }
}

class TestThread {
  constructor(
      private readonly call: SessionCall, private readonly id: string,
      private readonly initialMetadata?: GmailThreadInfo,
  ) {}

  getMetadata(): Promise<GmailThreadInfo> {
    if (this.initialMetadata !== undefined) return Promise.resolve(this.initialMetadata);
    return this.call("thread.getMetadata", [this.id]) as Promise<GmailThreadInfo>;
  }

  async messages(): Promise<TestMessage[]> {
    const infos = await this.call("thread.messages", [this.id]) as GmailMessageInfo[];
    return infos.map(info => new TestMessage(this.call, info.id, info));
  }

  async messagesVisibleTo(address: string): Promise<TestMessage[]> {
    const infos = await this.call("thread.messagesVisibleTo", [this.id, address]) as GmailMessageInfo[];
    return infos.map(info => new TestMessage(this.call, info.id, info));
  }

  mutate(operation: string, lastMessageId?: string, label?: unknown): Promise<void> {
    return this.call("thread.mutate", [this.id, operation, lastMessageId, label]) as Promise<void>;
  }
}

class TestSession {
  constructor(
      private readonly call: SessionCall, private readonly restricted: boolean,
  ) {}

  hasMailboxMethods(): Promise<boolean> {
    return this.call("session.hasMailboxMethods") as Promise<boolean>;
  }

  getMailboxAddress(): Promise<{address: string; name?: string}> {
    return this.call("session.getMailboxAddress") as Promise<{address: string; name?: string}>;
  }

  listThreads(): Promise<TestCursor<{info: GmailThreadInfo; thread: TestThread}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.listThreads") as GmailThreadInfo[] | null;
      return infos?.map(info => ({info, thread: new TestThread(this.call, info.id)})) ?? null;
    }));
  }

  listMessages(): Promise<TestCursor<{info: GmailMessageInfo; message: TestMessage}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.listMessages") as GmailMessageInfo[] | null;
      return infos?.map(info => ({info, message: new TestMessage(this.call, info.id, info)})) ?? null;
    }));
  }

  searchThreads(query: string): Promise<TestCursor<{info: GmailThreadInfo; thread: TestThread}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.searchThreads", [query]) as GmailThreadInfo[] | null;
      return infos?.map(info => ({info, thread: new TestThread(this.call, info.id)})) ?? null;
    }));
  }

  searchMessages(query: string): Promise<TestCursor<{info: GmailMessageInfo; message: TestMessage}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.searchMessages", [query]) as GmailMessageInfo[] | null;
      return infos?.map(info => ({info, message: new TestMessage(this.call, info.id, info)})) ?? null;
    }));
  }

  listedThreadAfterArchivingMessage(id: string): Promise<{
    listed: GmailThreadInfo; afterwards: GmailThreadInfo;
  }> {
    return this.call("session.listedThreadAfterArchivingMessage", [id]) as Promise<{
      listed: GmailThreadInfo; afterwards: GmailThreadInfo;
    }>;
  }

  getThreadMetadataTwice(id: string): Promise<{first: GmailThreadInfo; second: GmailThreadInfo}> {
    return this.call("thread.getMetadataTwice", [id]) as Promise<{
      first: GmailThreadInfo; second: GmailThreadInfo;
    }>;
  }

  getMessageMetadataTwice(id: string): Promise<{first: GmailMessageInfo; second: GmailMessageInfo}> {
    return this.call("message.getMetadataTwice", [id]) as Promise<{
      first: GmailMessageInfo; second: GmailMessageInfo;
    }>;
  }

  listDrafts(): Promise<TestCursor<{info: GmailDraftInfo; draft: TestDraft}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.listDrafts") as GmailDraftInfo[] | null;
      return infos?.map(info => ({info, draft: new TestDraft(this.call, info.id)})) ?? null;
    }));
  }

  listDraftPages(): Promise<GmailDraftInfo[][]> {
    return this.call("session.listDraftPages") as Promise<GmailDraftInfo[][]>;
  }

  send(
      to: string[], subject: string, body: string, options?: GmailComposeOptions,
  ): Promise<string> {
    return this.call("session.send", [to, subject, body, options]) as Promise<string>;
  }

  async getMessage(id: string): Promise<TestMessage> {
    if (!this.restricted && /^[a-f0-9]{1,256}$/i.test(id)) {
      return new TestMessage(this.call, id);
    }
    await this.call("session.getMessage", [id]);
    return new TestMessage(this.call, id);
  }

  async getThread(id: string): Promise<TestThread> {
    if (this.restricted || !/^[a-f0-9]{1,256}$/i.test(id)) {
      await this.call("session.getThread", [id]);
    }
    return new TestThread(this.call, id);
  }

  async getDraft(id: string): Promise<TestDraft> {
    await this.call("session.getDraft", [id]);
    return new TestDraft(this.call, id);
  }

  async createDraft(draft: GmailDraftInput): Promise<TestDraft> {
    const info = await this.call("session.createDraft", [draft]) as GmailDraftInfo;
    return new TestDraft(this.call, info.id);
  }

  createLabel(name: string): Promise<GmailCustomLabel> {
    return this.call("session.createLabel", [name]) as Promise<GmailCustomLabel>;
  }

  renameLabel(label: GmailCustomLabel, name: string): Promise<GmailCustomLabel> {
    return this.call("session.renameLabel", [label, name]) as Promise<GmailCustomLabel>;
  }

  deleteLabel(label: GmailCustomLabel): Promise<void> {
    return this.call("session.deleteLabel", [label]) as Promise<void>;
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

type FetchCall = {url: URL; init: RequestInit};

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise(resolve => setTimeout(resolve, 1));
}

function actionHarness(
    gmailFetch: (url: URL, init: RequestInit) => Response | Promise<Response>,
    options: {
      searchQuery?: string;
      labelName?: string;
      userInfo?: () => {sub: string; email: string};
    } = {}) {
  const {searchQuery, labelName, userInfo = () => ({
    sub: "account-subject", email: "me@example.com",
  })} = options;
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push({url, init});
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
      return json(userInfo());
    }
    return gmailFetch(url, init);
  });
  const name = `gmail-test-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const id = testEnv.GmailGatekeeperImpl.idFromName(name).toString();
  const facetName = `gmail-${name}`;
  const gmailProps: GmailGatekeeperImplProps = {
    userObjectId: testEnv.UserAccount.idFromName(name).toString(),
    ...(searchQuery !== undefined ? {searchQuery} : {}),
    ...(labelName !== undefined ? {labelName} : {}),
  };
  const storage = testStorage(hook, {name: facetName, id, props: gmailProps});
  const userObject = testEnv.UserAccount.get(testEnv.UserAccount.idFromName(name));
  const userStorage = testStorage(userObject);
  userStorage.kv.put("refreshToken", "refresh-token");
  userStorage.kv.put("accessToken", {
    token: "access-token", expires: new Date(Date.now() + 60 * 60 * 1000),
  });
  const initialization = runHook(hook, instance =>
    instance.initialize(facetName, id, gmailProps));
  const invoke = (
      queueId: string, operation: string, args: unknown[] = [],
  ): Promise<unknown> => initialization
    .then(() => flushStorage(userStorage)).then(() => flushStorage(storage))
    .then(() => runHook(hook, instance =>
      instance.runSessionOperation(facetName, id, gmailProps, queueId, operation, args)));
  const gatekeeper = {
    describe(): Promise<ResourceDescription> {
      return initialization.then(() => runHook(hook, instance =>
        instance.describe(facetName, id, gmailProps)));
    },
    getAutoApprovableActions(): Promise<ActionKind[]> {
      return initialization.then(() => runHook(hook, instance =>
        instance.getAutoApprovableActions(facetName, id, gmailProps)));
    },
    startSession(approval: ApprovalQueueHandle): Promise<TestSession> {
      approval.read = () => runHook(hook, instance => instance.readQueue(approval.id));
      approval.pauseObservation = title =>
        runHook(hook, instance => instance.pauseObservation(approval.id, title));
      approval.waitForPausedObservation = () =>
        runHook(hook, instance => instance.waitForPausedObservation(approval.id));
      approval.releasePausedObservation = () =>
        runHook(hook, instance => instance.releasePausedObservation(approval.id));
      approval.pauseActionSubmission = () =>
        runHook(hook, instance => instance.pauseActionSubmission(approval.id));
      approval.waitForPausedActionSubmission = () =>
        runHook(hook, instance => instance.waitForPausedActionSubmission(approval.id));
      approval.releasePausedActionSubmission = () =>
        runHook(hook, instance => instance.releasePausedActionSubmission(approval.id));
      return initialization.then(() => flushStorage(userStorage)).then(() => flushStorage(storage))
        .then(() => runHook(hook, instance =>
          instance.startSession(facetName, id, gmailProps, approval.id, approval.rejection)))
        .then(() => new TestSession(
           (operation, args = []) => invoke(approval.id, operation, args),
          searchQuery !== undefined || labelName !== undefined,
        ));
    },
    applyAction(actionId: number): Promise<void> {
      return initialization.then(() => flushStorage(userStorage)).then(() => flushStorage(storage))
        .then(() => runHook(hook, instance =>
          instance.applyAction(facetName, id, gmailProps, actionId)));
    },
    rejectAction(actionId: number): Promise<void> {
      return initialization.then(() => flushStorage(userStorage)).then(() => flushStorage(storage))
        .then(() => runHook(hook, instance =>
          instance.rejectAction(facetName, id, gmailProps, actionId)));
    },
  };
  return {calls, gatekeeper, storage, values: storageValues(storage)};
}

type ApprovalQueueHandle = {
  id: string;
  rejection?: string;
  read?: () => Promise<{
    submissions: Array<{actionId: number; description: unknown}>;
    observations: unknown[];
  }>;
  pauseObservation?: (title: string) => Promise<void>;
  waitForPausedObservation?: () => Promise<void>;
  releasePausedObservation?: () => Promise<void>;
  pauseActionSubmission?: () => Promise<void>;
  waitForPausedActionSubmission?: () => Promise<void>;
  releasePausedActionSubmission?: () => Promise<void>;
};

function approvalQueue(rejection?: string): ApprovalQueueHandle {
  return {id: `queue-${crypto.randomUUID()}`, rejection};
}

function draftFull(
    providerId: string, messageId: string, threadId: string,
    state: GmailDraftState) {
  const body = new TextEncoder().encode(state.text);
  let binary = "";
  for (const byte of body) binary += String.fromCharCode(byte);
  return {
    id: providerId,
    message: {
      id: messageId,
      threadId,
      internalDate: "1",
      sizeEstimate: body.byteLength,
      payload: {
        mimeType: "text/plain",
        headers: [
          {name: "From", value: state.from},
          {name: "To", value: state.to.join(", ")},
          {name: "Date", value: state.date ?? TEST_DRAFT_DATE},
          {name: "Subject", value: state.subject},
          {name: "Message-ID", value: state.rfcMessageId!},
        ],
        body: {
          size: body.byteLength,
          data: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
        },
      },
    },
  };
}

function messageMetadata(
    id: string, threadId: string, rfcMessageId: string | null = "<message@example.com>",
    labelIds: string[] = []) {
  return {
    id,
    threadId,
    internalDate: "1",
    labelIds,
    payload: {headers: [
      {name: "From", value: "sender@example.com"},
      {name: "To", value: "me@example.com"},
      {name: "Subject", value: "Known message"},
      ...(rfcMessageId ? [{name: "Message-ID", value: rfcMessageId}] : []),
    ]},
  };
}

function threadMinimal(id: string, messageIds: string[]) {
  return {id, messages: messageIds.map(messageId => ({id: messageId}))};
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function outboundSpec(messageId = "<forward@gadgets.invalid>"): GmailOutboundSpec {
  return {
    from: "me@example.com",
    replyTo: [],
    to: ["to@example.com"],
    cc: [],
    bcc: [],
    date: TEST_DRAFT_DATE,
    subject: "Fwd: Subject",
    text: "Forwarded message attached.",
    messageId,
    attachments: [],
  };
}

async function seedForwardSend(
    storage: TestStorage, bytes: Uint8Array, actionId = 1) {
  const snapshot = await captureForwardSnapshot(storage, bytes);
  storage.kv.put(`pending:action:${actionId}`, {
    type: "send",
    mode: "forward",
    spec: outboundSpec(),
    sourceMessageId: "source-message",
    sourceAttachment: {
      ...snapshot,
      messageId: "source-message",
      description: "Complete original message",
    },
  });
  return snapshot;
}

function forwardDraftState(
    snapshot: GmailForwardSnapshotReference, logicalId = "provisional-draft"): GmailDraftState {
  return {
    logicalId,
    from: "me@example.com",
    replyTo: [],
    to: ["to@example.com"],
    cc: [],
    bcc: [],
    date: TEST_DRAFT_DATE,
    subject: "Fwd: Subject",
    text: "Forwarded message attached.",
    rfcMessageId: "<forward-draft@gadgets.invalid>",
    timestamp: 1,
    source: {kind: "forward", messageId: "source-message"},
    attachments: [{
      key: "forward-source",
      info: {
        filename: "forwarded-message.eml",
        mimeType: "message/rfc822",
        size: snapshot.size,
        disposition: "attachment",
        readable: true,
      },
      contentDigest: snapshot.digest,
    }],
    version: 0,
  };
}

async function seedForwardDraft(storage: TestStorage, bytes: Uint8Array, actionId = 1) {
  const snapshot = await captureForwardSnapshot(storage, bytes);
  const state = forwardDraftState(snapshot);
  storage.kv.put(`gmail:draft:${state.logicalId}`, {
    logicalId: state.logicalId,
    source: state.source,
    createdAt: 1,
    status: "active",
    version: 0,
  });
  storage.kv.put(`pending:action:${actionId}`, {
    type: "draftCreate",
    draft: state,
    sourceAttachment: {
      ...snapshot,
      messageId: "source-message",
      description: "Complete original message",
    },
  });
  return {snapshot, state};
}

async function captureForwardSnapshot(
    storage: TestStorage, bytes: Uint8Array): Promise<GmailForwardSnapshotReference> {
  await flushStorage(storage);
  if (storage.facetName === undefined || storage.id === undefined || storage.props === undefined) {
    throw new Error("Forward snapshots require a Gmail Durable Object storage target.");
  }
  return runHook(storage.target, instance =>
    instance.captureForwardSnapshot(storage.facetName!, storage.id!, storage.props!, bytes));
}

afterEach(() => vi.unstubAllGlobals());

describe("Gmail session API surface", () => {
  it("advertises scoped and mailbox session types according to the binding", async () => {
    const mailbox = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const search = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "is:unread"});
    const label = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {labelName: "Important"});

    await expect(mailbox.gatekeeper.describe()).resolves.toMatchObject({
      tsType: "GmailSession",
    });
    await expect(search.gatekeeper.describe()).resolves.toMatchObject({
      tsType: "GmailScopedSession",
    });
    await expect(label.gatekeeper.describe()).resolves.toMatchObject({
      tsType: "GmailScopedSession",
    });

    const mailboxSession = await mailbox.gatekeeper.startSession(approvalQueue());
    const searchSession = await search.gatekeeper.startSession(approvalQueue());
    await expect(mailboxSession.hasMailboxMethods()).resolves.toBe(true);
    await expect(searchSession.hasMailboxMethods()).resolves.toBe(false);
  });

  it("authorizes and returns the connected mailbox address through a restricted binding", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {
      searchQuery: "is:unread",
      userInfo: () => ({sub: "account-subject", email: "owner@example.com"}),
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    await expect(session.getMailboxAddress()).resolves.toEqual({address: "owner@example.com"});
    await expect(queue.read!()).resolves.toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({title: "Read Gmail mailbox address"}),
      ]),
    });
  });

  it("resolves a returned Message-ID after the send is applied", async () => {
    let rfcMessageId = "";
    let searches = 0;
    const {gatekeeper, values} = actionHarness(async (url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        searches++;
        return json({messages: [{id: "colliding-message", threadId: "colliding-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        const raw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        rfcMessageId = (await parseMimeMessage(raw)).messageId ?? "";
        return json({id: "abc123", threadId: "def456"});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        return json(messageMetadata("abc123", "def456", rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    const messageId = await session.send(["to@example.com"], "Subject", "Body");
    expect(messageId).toMatch(/^<[-0-9a-f]+@gadgets\.invalid>$/);
    // The same ID opens the message before Gmail has it.
    await expect((await session.getMessage(messageId)).getMetadata())
      .resolves.toMatchObject({id: messageId, subject: "Subject"});

    await gatekeeper.applyAction(1);

    const resumedSession = await gatekeeper.startSession(approvalQueue());
    const message = await resumedSession.getMessage(messageId);
    await expect(message.getMetadata()).resolves.toMatchObject({id: "abc123", threadId: "def456"});
    await expect((await resumedSession.getMessage("abc123")).getMetadata())
      .resolves.toMatchObject({id: "abc123", threadId: "def456"});
    expect(searches).toBe(0);
    await expect(values.get(`gmail:sentAlias:${messageId.slice(1, -1)}`)).resolves.toMatchObject({
      rfcMessageId: messageId, providerId: "abc123", threadId: "def456",
    });
    await expect(values.get("gmail:sentProvider:abc123")).resolves.toMatchObject({
      rfcMessageId: messageId, providerId: "abc123", threadId: "def456",
    });
    for (const key of ["pending:action:1", "gmail:applying:1", "gmail:sendFingerprint:1"]) {
      await expect(values.has(key)).resolves.toBe(false);
    }
  });

  it("fails legacy outbound actions closed without writing", async () => {
    const {calls, gatekeeper, storage, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const actions = [
      {type: "send", to: ["to@example.com"], subject: "Subject", body: "Body"},
      {
        type: "reply", sourceMessageId: "source", threadId: "source-thread",
        body: "Legacy reply", replyAll: true,
      },
      {type: "forward", sourceMessageId: "source", to: ["target@example.com"], body: "Forward"},
    ];
    actions.forEach((action, index) => storage.kv.put(`pending:action:${index + 1}`, action));

    for (let id = 1; id <= actions.length; id++) {
      await expect(gatekeeper.applyAction(id)).rejects.toThrow(/cannot be retried safely/);
      expect(await values.get(`pending:action:${id}`)).toEqual(actions[id - 1]);
      expect(await values.has(`gmail:applying:${id}`)).toBe(false);
      await gatekeeper.rejectAction(id);
      expect(await values.has(`pending:action:${id}`)).toBe(false);
    }

    expect(calls.some(call => call.url.hostname === "gmail.googleapis.com")).toBe(false);
  });

  it("does not migrate a legacy standalone send through a restricted binding", async () => {
    const {calls, gatekeeper, storage} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "is:unread"});
    storage.kv.put("pending:action:1", {
      type: "send", to: ["to@example.com"], subject: "Subject", body: "Body",
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/cannot be retried safely/);

    expect(calls.some(call => call.url.pathname === "/gmail/v1/users/me/messages/send")).toBe(false);
  });

  it("rejects a colliding Message-ID while reconciling an uncertain send", async () => {
    let messageId = "";
    let delivered = false;
    let writes = 0;
    const {gatekeeper, values} = actionHarness(async (url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: delivered ? [{id: "abc123", threadId: "def456"}] : []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        if (url.searchParams.get("format") === "metadata") {
          return json(messageMetadata("abc123", "def456", messageId, ["SENT"]));
        }
        return json({
          id: "abc123",
          threadId: "def456",
          internalDate: "1",
          raw: buildEncodedEmail({...outboundSpec(messageId), subject: "Collision", text: "Other"}),
        });
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        writes++;
        messageId = (await parseMimeMessage(
          (JSON.parse(String(init.body)) as {raw: string}).raw)).messageId ?? "";
        delivered = true;
        throw new Error("connection lost after write");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    await session.send(["to@example.com"], "Subject", "Body");

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/connection lost/);
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/different content/);

    expect(writes).toBe(1);
    expect(await values.has("pending:action:1")).toBe(true);
    expect(await values.has(`gmail:sentAlias:${messageId.slice(1, -1)}`)).toBe(false);
  });

  it("admits a sent message created through a restricted binding", async () => {
    const sourceId = "abc123";
    let sentMessageId = "";
    let searches = 0;
    const {gatekeeper} = actionHarness(async (url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        searches++;
        return json({messages: [{id: sourceId, threadId: "source-thread"}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${sourceId}` && !init.method) {
        return json(messageMetadata(sourceId, "source-thread", "<source@example.com>"));
      }
      if (url.pathname === "/gmail/v1/users/me/threads/source-thread" && !init.method) {
        return json(threadMinimal("source-thread", [sourceId, "def789"]));
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        const raw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        sentMessageId = (await parseMimeMessage(raw)).messageId ?? "";
        return json({id: "def789", threadId: "source-thread"});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/def789" && !init.method) {
        return json(messageMetadata("def789", "source-thread", sentMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:someone-else@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());
    const source = await session.getMessage(sourceId);
    const messageId = await source.reply("Reply body");

    await gatekeeper.applyAction(1);

    const searchesBeforeOpeningSentMessage = searches;
    const sentMessageByProviderId = await session.getMessage("def789");
    await expect(sentMessageByProviderId.getMetadata()).resolves.toMatchObject({
      id: "def789",
      threadId: "source-thread",
    });
    expect(searches).toBe(searchesBeforeOpeningSentMessage);

    const sentMessage = await session.getMessage(messageId);
    expect(searches).toBe(searchesBeforeOpeningSentMessage);
    await expect((await sentMessage.thread()).getMetadata()).resolves.toMatchObject({
      id: "source-thread",
      messageCount: 2,
    });
  });
});

describe("Gmail auto-approval eligibility", () => {
  it("advertises and annotates distinct non-send actions", async () => {
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        return json(messageMetadata("abc123", "def456"));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    expect(await gatekeeper.getAutoApprovableActions()).toEqual([
      {tag: "archive", label: "Archive messages"},
      {tag: "trash", label: "Trash messages"},
      {tag: "markRead", label: "Mark messages as read"},
      {tag: "markUnread", label: "Mark messages as unread"},
      {tag: "star", label: "Star messages"},
      {tag: "unstar", label: "Unstar messages"},
      {tag: "applyLabel", label: "Apply labels to messages"},
      {tag: "removeLabel", label: "Remove labels from messages"},
      {tag: "draftCreate", label: "Create drafts"},
      {tag: "draftUpdate", label: "Update drafts"},
      {tag: "draftDelete", label: "Delete drafts"},
      {tag: "labelCreate", label: "Create labels"},
      {tag: "labelRename", label: "Rename labels"},
      {tag: "labelDelete", label: "Delete labels"},
    ]);

    const draft = await session.createDraft({
      to: ["to@example.com"], subject: "Subject", text: "Body",
    });
    await draft.update({subject: "Updated subject"});
    await draft.delete();
    await (await session.getMessage("abc123")).archive();
    const label = await session.createLabel("Agent label");
    const renamed = await session.renameLabel(label, "Renamed agent label");
    await session.deleteLabel(renamed);

    const descriptions = (await queue.read!()).submissions.map(submission => submission.description);
    expect(descriptions).toMatchObject([
      {actionKind: {tag: "draftCreate", label: "Create drafts"}, autoApprovable: true},
      {actionKind: {tag: "draftUpdate", label: "Update drafts"}, autoApprovable: true},
      {actionKind: {tag: "draftDelete", label: "Delete drafts"}, autoApprovable: true},
      {actionKind: {tag: "archive", label: "Archive messages"}, autoApprovable: true},
      {actionKind: {tag: "labelCreate", label: "Create labels"}, autoApprovable: true},
      {actionKind: {tag: "labelRename", label: "Rename labels"}, autoApprovable: true},
      {actionKind: {tag: "labelDelete", label: "Delete labels"}, autoApprovable: true},
    ]);
    // Later reads simulate each of these, so none stops the caller to wait for a decision.
    for (const description of descriptions) {
      expect(description).not.toHaveProperty("awaitDecision");
    }
  });

  it("records no observations for reads that only prepare an action", async () => {
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        return json(messageMetadata("abc123", "def456"));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    const draft = await session.createDraft({
      to: ["to@example.com"], subject: "Subject", text: "Body",
    });
    await draft.update({subject: "Updated subject"});
    await draft.delete();
    await (await session.getMessage("abc123")).archive();
    const label = await session.createLabel("Agent label");
    const renamed = await session.renameLabel(label, "Renamed agent label");
    await session.deleteLabel(renamed);

    const {observations, submissions} = await queue.read!();
    expect(submissions).toHaveLength(7);
    // The only read that returns data is the harness's createDraft(), which returns the draft's
    // metadata. Reopening a draft or message by its opaque ID is not an observation.
    expect((observations as Array<{title: string}>).map(({title}) => title)).toEqual([
      "Read Gmail draft: Subject",
    ]);
  });

  it.each([
    ["applyLabel", "TRASH", "trash"],
    ["removeLabel", "INBOX", "archive"],
    ["applyLabel", "UNREAD", "markUnread"],
    ["removeLabel", "UNREAD", "markRead"],
    ["applyLabel", "STARRED", "star"],
    ["removeLabel", "STARRED", "unstar"],
  ] as const)("requires %s(%s) to use %s()", async (operation, labelId, method) => {
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        return json(messageMetadata("abc123", "def456"));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: labelId, name: labelId, type: "system"}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage("abc123");
    const label = {id: labelId, name: labelId, type: "system"} as const;

    const mutation = operation === "applyLabel"
      ? message.applyLabel(label)
      : message.removeLabel(label);
    await expect(mutation).rejects.toThrow(`Use ${method}()`);
    expect((await queue.read!()).submissions).toHaveLength(0);
  });

  it("keeps non-alias system label mutations auto-approvable", async () => {
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        return json(messageMetadata("abc123", "def456"));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: ["IMPORTANT", "INBOX", "TRASH", "CATEGORY_UPDATES"].map(id => ({
          id, name: id, type: "system",
        }))});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage("abc123");

    await message.applyLabel({id: "IMPORTANT", name: "IMPORTANT", type: "system"});
    await message.applyLabel({id: "INBOX", name: "INBOX", type: "system"});
    await message.removeLabel({id: "TRASH", name: "TRASH", type: "system"});
    await message.applyLabel({
      id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system",
    });

    expect((await queue.read!()).submissions.map(submission => submission.description))
      .toMatchObject([
        {actionKind: {tag: "applyLabel"}, autoApprovable: true},
        {actionKind: {tag: "applyLabel"}, autoApprovable: true},
        {actionKind: {tag: "removeLabel"}, autoApprovable: true},
        {actionKind: {tag: "applyLabel"}, autoApprovable: true},
      ]);
  });

  it("keeps every email delivery path ineligible", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "sender@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      messageId: "<source@gadgets.invalid>",
      attachments: [],
    });
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "abc123", threadId: "def456", internalDate: "1", raw: sourceRaw});
        }
        return json({
          ...messageMetadata("abc123", "def456", "<source@gadgets.invalid>"),
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage("abc123");

    const sendId = await session.send(["to@example.com"], "New message", "Body");
    const replyId = await message.reply("Reply body");
    const replyAllId = await message.replyAll("Reply-all body");
    const forwardId = await message.forward(["to@example.com"], "Forward body");
    const draft = await session.createDraft({
      to: ["to@example.com"], subject: "Draft", text: "Draft body",
    });
    const draftSendId = await draft.send();

    const messageIds = [sendId, replyId, replyAllId, forwardId, draftSendId];
    for (const id of messageIds) {
      expect(id).toMatch(/^<[^<>\s]+@gadgets\.invalid>$/);
    }
    expect(new Set(messageIds).size).toBe(messageIds.length);
    await expect(values.get("pending:action:1")).resolves.toMatchObject({
      type: "send", spec: {messageId: sendId},
    });
    await expect(values.get("pending:action:2")).resolves.toMatchObject({
      type: "send", spec: {messageId: replyId},
    });
    await expect(values.get("pending:action:3")).resolves.toMatchObject({
      type: "send", spec: {messageId: replyAllId},
    });
    await expect(values.get("pending:action:4")).resolves.toMatchObject({
      type: "send", spec: {messageId: forwardId},
    });
    await expect(values.get("pending:action:6")).resolves.toMatchObject({
      type: "draftSend", messageId: draftSendId,
    });

    const descriptions = (await queue.read!()).submissions.map(submission =>
      submission.description as {actionKind?: ActionKind; autoApprovable?: boolean});
    expect(descriptions).toHaveLength(6);
    for (const index of [0, 1, 2, 3, 5]) {
      expect(descriptions[index]).not.toHaveProperty("actionKind");
      expect(descriptions[index]).not.toHaveProperty("autoApprovable");
    }
    // Later reads show each message as sent, so no send stops the caller to wait for a decision.
    for (const description of descriptions) {
      expect(description).not.toHaveProperty("awaitDecision");
    }
    expect(descriptions[4]).toMatchObject({
      actionKind: {tag: "draftCreate", label: "Create drafts"},
      autoApprovable: true,
    });
  });
});

describe("Gmail forward action snapshots", () => {
  it("keeps large outbound bodies complete in approval descriptions", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    const body = `${"x".repeat(64 * 1024 - 16)}complete-marker`;
    await session.send(["to@example.com"], "Subject", body);

    const description = (await queue.read!()).submissions[0]?.description as ActionDescription;
    expect(description.descriptionIsComplete).toBe(true);
    expect(fieldOf(description, "Plain text")).toEqual({label: "Plain text", kind: "text", value: body});
  });

  it("submits an oversize forward without the completeness flag", async () => {
    // An outbound body is capped well under the description budget, but an inline forward quotes
    // the whole source message, which is not.
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "x".repeat(100 * 1024),
      messageId: "<oversize-source@gadgets.invalid>",
      attachments: [],
    });
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return url.searchParams.has("q")
          ? json({messages: []})
          : json({messages: [{id: "source-message", threadId: "source-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/source-message" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "source-message", threadId: "source-thread", internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1",
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw), labelIds: ["INBOX"],
          payload: {headers: [
            {name: "From", value: "source@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<oversize-source@gadgets.invalid>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const messages = await (await session.listMessages()).next();

    await messages![0].message.forward(["to@example.com"], "Intro");
    // The approver sees the truncated rendering; the missing flag tells them it is partial.
    const {submissions} = await queue.read!();
    expect(submissions).toHaveLength(1);
    const description = submissions[0].description as
      {description: string; descriptionIsComplete?: true};
    expect(description.descriptionIsComplete).toBeUndefined();
    const truncated = (description as ActionDescription).fields?.find(field => field.truncated);
    expect(truncated?.truncated?.shownBytes).toBeLessThan(truncated!.truncated!.totalBytes);
  });

  it("shows a draft body with an undisplayable character exactly, as JSON", async () => {
    const {gatekeeper, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    // A bell character renders as nothing as text, so the body is shown escaped.
    await session.createDraft({to: ["to@example.com"], subject: "Subject", text: "a\u0007b"});
    const {submissions} = await queue.read!();
    expect(submissions).toHaveLength(1);
    const description = submissions[0].description as ActionDescription;
    expect(description.descriptionIsComplete).toBe(true);
    expect(fieldOf(description, "Plain text")).toEqual(
      {label: "Plain text", kind: "json", value: '"a\\u0007b"'});
    // The staged action and its draft are kept for the approver to decide on.
    const keys = await values.keys();
    expect(keys.some(key => key.startsWith("pending:action:"))).toBe(true);
    expect(keys.some(key => key.startsWith("gmail:draft:"))).toBe(true);
  });

  it("sends a new forward inline with ordinary source attachments", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: `${"x".repeat(70 * 1024)}\nSource body`,
      html: "<p>Source <strong>HTML</strong></p>",
      messageId: "<source@gadgets.invalid>",
      attachments: [{
        filename: "source.txt",
        contentType: "text/plain",
        data: btoa("source attachment"),
        disposition: "attachment",
        description: "source attachment",
      }],
    });
    let sentRaw: string | undefined;
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return url.searchParams.has("q")
          ? json({messages: []})
          : json({messages: [{id: "source-message", threadId: "source-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/source-message" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "source-message", threadId: "source-thread", internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1",
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw), labelIds: ["INBOX"],
          payload: {headers: [
            {name: "From", value: "source@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<source@gadgets.invalid>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const messages = await (await session.listMessages()).next();

    await messages![0].message.forward(
      ["recipient@example.com"], "Intro", {html: "<p>Intro</p>"});
    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(sentRaw!);
    expect(parsed.text).toContain("Intro");
    expect(parsed.text).toContain("---------- Forwarded message ---------");
    expect(parsed.text).toContain("Source body");
    expect(parsed.html).toContain("Source <strong>HTML</strong>");
    expect(parsed.attachments.map(attachment => attachment.filename)).toEqual(["source.txt"]);
  });

  it("describes reconstructed inline-forward content when approving a draft send", async () => {
    const sourceId = "abc123";
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      html: "<p>Source <strong>HTML</strong></p>",
      messageId: "<source-approval@gadgets.invalid>",
      attachments: [{
        filename: "source.txt",
        contentType: "text/plain",
        data: btoa("source attachment"),
        disposition: "attachment",
        description: "source attachment",
      }],
    });
    const queue = approvalQueue();
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${sourceId}` && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: sourceId, threadId: "abc124", internalDate: "1", raw: sourceRaw});
        }
        return json({
          ...messageMetadata(sourceId, "abc124", "<source-approval@gadgets.invalid>"),
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(queue);
    const source = await session.getMessage(sourceId);
    const draft = await source.createForwardDraft(
      ["recipient@example.com"], "Intro", {html: "<p>Intro</p>"});

    await draft.send();

    const description = (await queue.read!()).submissions[1]?.description as ActionDescription;
    const text = fieldOf(description, "Plain text") as {value: string};
    expect(text.value).toContain("Intro");
    expect(text.value).toContain("Source body");
    expect((fieldOf(description, "HTML") as {value: string}).value)
      .toContain("Source <strong>HTML</strong>");
    expect(description.fields).toContainEqual(expect.objectContaining(
      {kind: "file", name: "source.txt", mediaType: "text/plain", origin: "provider"}));
  });

  it("shows every identifier a reply and a reply draft are written with", async () => {
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/abc123" && !init.method) {
        const metadata = messageMetadata("abc123", "def456", "<parent@example.com>");
        return json({...metadata, payload: {headers: [
          ...metadata.payload.headers,
          {name: "References", value: "<root@example.com> <middle@example.com>"},
        ]}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage("abc123");

    // Overridden recipients receive the source message's identifiers all the same.
    const replyId = await message.reply("Reply body", {to: ["other@example.com"]});
    await message.createReplyDraft("Draft reply body");

    const [reply, draft] = (await queue.read!()).submissions.map(submission =>
      submission.description as ActionDescription);
    const references = {
      label: "References", kind: "list",
      items: ["<root@example.com>", "<middle@example.com>", "<parent@example.com>"],
    };
    const inline = (label: string, value: string) => ({label, kind: "inline", value});
    expect(reply?.descriptionIsComplete).toBe(true);
    expect(reply?.fields).toEqual(expect.arrayContaining([
      inline("Message-ID", replyId),
      inline("In-Reply-To", "<parent@example.com>"),
      references,
      inline("Thread ID", "def456"),
    ]));
    expect(draft?.descriptionIsComplete).toBe(true);
    expect((fieldOf(draft, "Message-ID") as {value: string}).value)
      .toMatch(/^<[^<>\s]+@gadgets\.invalid>$/);
    expect((fieldOf(draft, "Date") as {value: string}).value).toMatch(/ GMT$/);
    expect(draft?.fields).toEqual(expect.arrayContaining([
      inline("In-Reply-To", "<parent@example.com>"),
      references,
      inline("Thread ID", "def456"),
    ]));
  });

  it("shows each forwarded attachment's disposition and Content-ID", async () => {
    const sourceId = "abc123";
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      html: "<p><img src=\"cid:logo@example.com\"></p>",
      messageId: "<source-parts@gadgets.invalid>",
      attachments: [{
        filename: "logo.png",
        contentType: "image/png",
        data: btoa("png bytes"),
        disposition: "inline",
        contentId: "logo@example.com",
        description: "logo",
      }, {
        filename: "notes.txt",
        contentType: "text/plain",
        data: btoa("notes"),
        disposition: "attachment",
        description: "notes",
      }],
    });
    const queue = approvalQueue();
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${sourceId}` && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: sourceId, threadId: "abc124", internalDate: "1", raw: sourceRaw});
        }
        return json({
          ...messageMetadata(sourceId, "abc124", "<source-parts@gadgets.invalid>"),
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(queue);
    await (await session.getMessage(sourceId)).forward(["recipient@example.com"], "Intro");

    const description = (await queue.read!()).submissions[0]?.description as ActionDescription;
    expect(description.descriptionIsComplete).toBe(true);
    const sha256 = expect.stringMatching(/^[0-9a-f]{64}$/);
    const labels = description.fields?.map(field => field.label) ?? [];
    const attachment = (name: string) => labels[description.fields!.findIndex(field =>
      field.kind === "file" && field.name === name)]!;
    const logo = attachment("logo.png");
    const notes = attachment("notes.txt");
    expect(fieldOf(description, logo)).toEqual({
      label: logo, kind: "file", name: "logo.png", mediaType: "image/png", size: 9, sha256,
      origin: "provider",
    });
    expect(fieldOf(description, `${logo} disposition`))
      .toEqual({label: `${logo} disposition`, kind: "inline", value: "inline"});
    expect(fieldOf(description, `${logo} Content-ID`))
      .toEqual({label: `${logo} Content-ID`, kind: "inline", value: "<logo@example.com>"});
    expect(fieldOf(description, notes)).toEqual({
      label: notes, kind: "file", name: "notes.txt", mediaType: "text/plain", size: 5, sha256,
      origin: "provider",
    });
    expect(fieldOf(description, `${notes} disposition`))
      .toEqual({label: `${notes} disposition`, kind: "inline", value: "attachment"});
    expect(fieldOf(description, `${notes} Content-ID`)).toBeUndefined();
  });

  it("shows a body's line breaks as the CRLF it is sent with, and stays complete", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    await session.send(["to@example.com"], "Subject", "line one\nline two", {
      html: "<p>one</p>\n<p>two</p>",
    });

    const description = (await queue.read!()).submissions[0]?.description as ActionDescription;
    expect(description.descriptionIsComplete).toBe(true);
    expect(fieldOf(description, "Plain text"))
      .toEqual({label: "Plain text", kind: "text", value: "line one\r\nline two"});
    expect(fieldOf(description, "HTML")).toEqual(
      {label: "HTML", kind: "text", value: "<p>one</p>\r\n<p>two</p>", syntax: "html"});
  });

  it("creates an inline forward draft from the captured source snapshot", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      messageId: "<source-draft@gadgets.invalid>",
      attachments: [],
    });
    let createdRaw: string | undefined;
    let sentRaw: string | undefined;
    let providerMessageId = "provider-message";
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: "source-message", threadId: "source-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/source-message" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "source-message", threadId: "source-thread", internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1", sizeEstimate: 100,
          labelIds: ["INBOX"], payload: {headers: [
            {name: "From", value: "source@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<source-draft@gadgets.invalid>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: "provider-message"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: providerMessageId, threadId: "provider-thread", internalDate: "1", raw: createdRaw,
          },
        });
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && init.method === "PUT") {
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        providerMessageId = "provider-message-2";
        return json({id: "provider-draft", message: {id: providerMessageId}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const messages = await (await session.listMessages()).next();
    const draft = await messages![0].message.createForwardDraft(["recipient@example.com"], "Intro");

    await expect(draft.getContent()).resolves.toMatchObject({
      text: expect.stringContaining("---------- Forwarded message ---------"),
    });
    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(createdRaw!);
    expect(parsed.text).toContain("Intro");
    expect(parsed.text).toContain("Source body");
    expect(parsed.attachments).toHaveLength(0);

    await draft.update({text: "Updated intro", subject: "Custom forward subject"});
    await gatekeeper.applyAction(2);
    const updated = await parseMimeMessage(createdRaw!);
    expect(updated.text).toContain("Updated intro");
    expect(updated.text).toContain("Source body");
    expect(updated.subject).toBe("Custom forward subject");

    await draft.send();
    await gatekeeper.applyAction(3);
    expect(await parseMimeMessage(sentRaw!)).toMatchObject({text: expect.stringContaining("Source body")});
    expect((await values.keys()).some(key => key.startsWith("gmail:forwardSnapshot:") &&
      !key.endsWith("totalBytes"))).toBe(false);
  });

  it("sends the initially captured bytes without a second source GET and cleans up", async () => {
    const initial = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody");
    let sentRaw: string | undefined;
    const {calls, gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      if (url.pathname.includes("source-message")) {
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1", raw: "ZGlmZmVyZW50",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, initial);

    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(sentRaw!);
    expect(parsed.attachments[0].mimeType).toBe("message/rfc822");
    expect(containsBytes(decodeBase64UrlToBytes(sentRaw!), initial)).toBe(true);
    expect(calls.some(call => call.url.pathname.includes("source-message"))).toBe(false);
    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
    expect(await values.has("pending:action:1")).toBe(false);
  });

  it("preserves the attachment type of a partially migrated legacy forward", async () => {
    const source = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody");
    let sentRaw: string | undefined;
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await captureForwardSnapshot(storage, source);
    storage.kv.put("pending:action:1", {
      type: "send",
      mode: "forward",
      spec: outboundSpec(),
      sourceMessageId: "source-message",
      sourceAttachment: {
        ...snapshot,
        messageId: "source-message",
        description: "Complete original message approved by a legacy Gmail forward action.",
        contentType: "application/octet-stream",
      },
    });

    await gatekeeper.applyAction(1);

    expect((await parseMimeMessage(sentRaw!)).attachments[0].mimeType)
      .toBe("application/octet-stream");
  });

  it("fails corrupt chunks before a Gmail write", async () => {
    let writes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      if (init.method === "POST") writes++;
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, new Uint8Array([1, 2, 3]));
    const chunkKey = (await values.keys()).find(key =>
      key.includes(snapshot.handle) && key.includes(":chunk:"))!;
    const chunk = (await values.get<Uint8Array>(chunkKey))!.slice();
    chunk[0] ^= 0xff;
    await values.set(chunkKey, chunk);

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/incomplete or corrupted/);
    expect(writes).toBe(0);
  });

  it("retains an ambiguous snapshot and reconciles before trying to materialize it", async () => {
    let delivered = false;
    let sentRaw: string | undefined;
    let writes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: delivered ? [{id: "sent-message", threadId: "sent-thread"}] : []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/sent-message" && !init.method) {
        return url.searchParams.get("format") === "metadata"
          ? json(messageMetadata(
            "sent-message", "sent-thread", "<forward@gadgets.invalid>", ["SENT"]))
          : json({id: "sent-message", threadId: "sent-thread", internalDate: "1", raw: sentRaw});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        writes++;
        sentRaw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        throw new Error("connection lost after write");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody"));

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/connection lost/);
    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(true);
    expect(await values.has("gmail:applying:1")).toBe(true);
    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/uncertain provider outcome/);
    expect(await values.has("pending:action:1")).toBe(true);

    const chunkKey = (await values.keys()).find(key =>
      key.includes(snapshot.handle) && key.includes(":chunk:"))!;
    await values.delete(chunkKey);
    delivered = true;
    await gatekeeper.applyAction(1);

    expect(writes).toBe(1);
    await expect(values.get("gmail:sentAlias:forward@gadgets.invalid")).resolves.toMatchObject({
      rfcMessageId: "<forward@gadgets.invalid>",
      providerId: "sent-message",
      threadId: "sent-thread",
    });
    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
    expect(await values.has("pending:action:1")).toBe(false);
  });

  it("cleans up a rejected direct forward snapshot", async () => {
    const {gatekeeper, storage, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, new Uint8Array([7, 7, 7]));

    await gatekeeper.rejectAction(1);

    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
    expect(await values.has("pending:action:1")).toBe(false);
  });

  it("fails old pending snapshot shapes closed after reconciliation", async () => {
    let writes = 0;
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      if (init.method === "POST") writes++;
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "send",
      mode: "forward",
      spec: outboundSpec(),
      sourceMessageId: "source-message",
      sourceAttachment: {
        messageId: "source-message", size: 3, digest: "0".repeat(64), description: "Legacy",
      },
    });
    storage.kv.put("gmail:applying:1", Date.now());

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/reject and resubmit/i);
    expect(writes).toBe(0);
  });

  it("fails old forward-draft snapshot shapes closed", async () => {
    const {gatekeeper, storage} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const digest = "0".repeat(64);
    const state = forwardDraftState({handle: crypto.randomUUID(), size: 3, digest});
    storage.kv.put(`gmail:draft:${state.logicalId}`, {
      logicalId: state.logicalId,
      source: state.source,
      createdAt: 1,
      status: "active",
      version: 0,
    });
    storage.kv.put("pending:action:1", {
      type: "draftCreate",
      draft: state,
      sourceAttachment: {
        messageId: "source-message", size: 3, digest, description: "Legacy",
      },
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/reject and resubmit/i);
  });

  it("creates a forward draft from captured bytes without refetching the source", async () => {
    const initial = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody");
    let createdRaw: string | undefined;
    const {calls, gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: "provider-message"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw: createdRaw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const {snapshot, state} = await seedForwardDraft(storage, initial);

    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(createdRaw!);
    expect(parsed.attachments[0].mimeType).toBe("message/rfc822");
    expect(containsBytes(decodeBase64UrlToBytes(createdRaw!), initial)).toBe(true);
    expect(calls.some(call => call.url.pathname.includes("source-message"))).toBe(false);
    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
    expect(await values.get(`gmail:draft:${state.logicalId}`)).toMatchObject({
      logicalId: state.logicalId,
      providerId: "provider-draft",
    });
  });

  it("preserves exact forwarded message bytes through draft update and send", async () => {
    const source = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nExact body");
    let providerRaw: string | undefined;
    let providerMessageId = "provider-message-1";
    let sentRaw: string | undefined;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        providerRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: providerMessageId}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        if (url.searchParams.get("format") === "full") {
          return json(draftFull("provider-draft", providerMessageId, "provider-thread", {
            ...forwardDraftState({handle: "unused", size: source.length, digest: "unused"}),
            text: "Updated body",
          }));
        }
        return json({
          id: "provider-draft",
          message: {
            id: providerMessageId,
            threadId: "provider-thread",
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && init.method === "PUT") {
        providerMessageId = "provider-message-2";
        providerRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: providerMessageId}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const {state} = await seedForwardDraft(storage, source);
    storage.kv.put("pending:nextActionId", 2);

    await gatekeeper.applyAction(1);
    expect(extractRfc822Attachments(providerRaw!)[0].bytes).toEqual(source);
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.getDraft(state.logicalId);
    await draft.update({text: "Updated body"});
    await gatekeeper.applyAction(2);
    expect(extractRfc822Attachments(providerRaw!)[0].bytes).toEqual(source);
    const sentMessageId = await draft.send();
    await gatekeeper.applyAction(3);

    expect(extractRfc822Attachments(sentRaw!)[0].bytes).toEqual(source);
    await expect(values.get(`gmail:sentAlias:${sentMessageId.slice(1, -1)}`)).resolves.toMatchObject({
      rfcMessageId: sentMessageId,
      providerId: "sent-message",
      threadId: "sent-thread",
    });
    await expect(values.get(`gmail:draft:${state.logicalId}`)).resolves.toMatchObject({status: "sent"});
    for (const key of ["pending:action:3", "gmail:applying:3", "gmail:sendFingerprint:3"]) {
      await expect(values.has(key)).resolves.toBe(false);
    }
  });

  it("cleans up a rejected forward draft snapshot", async () => {
    const {gatekeeper, storage, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const {snapshot, state} = await seedForwardDraft(storage, new Uint8Array([10, 11]));

    await gatekeeper.rejectAction(1);

    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
    expect(await values.get(`gmail:draft:${state.logicalId}`)).toMatchObject({status: "rejected"});
  });

  it("reconciles an ambiguous draft create without writing it twice", async () => {
    let createdRaw: string | undefined;
    let visible = false;
    let creates = 0;
    let messageRfcId: string | undefined;
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        throw new Error("connection lost after draft create");
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: visible ? [{id: "provider-message", threadId: "provider-thread"}] : []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/provider-message" && !init.method) {
        return json(messageMetadata("provider-message", "provider-thread", messageRfcId!));
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: "provider-draft", message: {id: "provider-message"}}]});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw: createdRaw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.createDraft({to: ["to@example.com"], subject: "Subject", text: "Body"});
    const {id: logicalId} = await draft.getMetadata();
    const action = await values.get<{draft: GmailDraftState}>("pending:action:1");
    if (!action) throw new Error("Missing staged draft action.");
    messageRfcId = action.draft.rfcMessageId;

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/connection lost/);
    visible = true;
    await gatekeeper.applyAction(1);

    expect(creates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({providerId: "provider-draft"});
  });

  it("allows rejection when an ambiguously created draft was edited externally", async () => {
    let visible = false;
    let creates = 0;
    let messageRfcId: string | undefined;
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        throw new Error("connection lost after draft create");
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: visible ? [{id: "provider-message", threadId: "provider-thread"}] : []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/provider-message" && !init.method) {
        return json(messageMetadata("provider-message", "provider-thread", messageRfcId!));
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: "provider-draft", message: {id: "provider-message"}}]});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: "provider-message",
            threadId: "provider-thread",
            internalDate: "1",
            raw: new GmailApi("me@example.com", async () => "token").buildOutbound({
              ...outboundSpec(messageRfcId), subject: "Subject", text: "Externally edited",
            }).raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.createDraft({
      to: ["to@example.com"], subject: "Subject", text: "Body",
    });
    const {id: logicalId} = await draft.getMetadata();
    const action = await values.get<{draft: GmailDraftState}>("pending:action:1");
    if (!action) throw new Error("Missing staged draft action.");
    messageRfcId = action.draft.rfcMessageId;

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/connection lost/);
    visible = true;
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/no longer matches/);

    expect(creates).toBe(1);
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: "provider-draft",
      messageId: "provider-message",
      threadId: "provider-thread",
      unverified: true,
    });
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    await gatekeeper.rejectAction(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:applying:1")).toBe(false);
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({
      providerId: "provider-draft", status: "active",
    });
  });

  it("reads the initially captured bytes through a provisional attachment capability", async () => {
    const initial = new Uint8Array([0, 17, 34, 128, 255]);
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await seedForwardDraft(storage, initial);
    const session = await gatekeeper.startSession(approvalQueue());
    const cursor = await session.listDrafts();
    const entries = await cursor.next();

    expect(entries).toHaveLength(1);
    const attachments = await entries![0].draft.attachments();
    expect(attachments).toHaveLength(1);
    expect(new Uint8Array(await attachments[0].attachment.getContent())).toEqual(initial);
  });

  it("cleans direct and draft snapshots when approval submission fails", async () => {
    const sourceId = "source-message";
    const threadId = "source-thread";
    const sourceRaw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      from: "sender@example.com",
      replyTo: [],
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      messageId: "<source@example.com>",
      attachments: [],
    }).raw;
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: sourceId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${sourceId}` && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: sourceId, threadId, internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: sourceId,
          threadId,
          internalDate: "1",
          sizeEstimate: 100,
          labelIds: ["INBOX"],
          payload: {headers: [
            {name: "From", value: "sender@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<source@example.com>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue("approval queue unavailable");
    const session = await gatekeeper.startSession(queue);
    const messages = await (await session.listMessages()).next();
    const message = messages![0].message;

    await expect(message.forward(["to@example.com"])).rejects.toThrow(/approval queue unavailable/);
    await expect(message.createForwardDraft(["to@example.com"]))
      .rejects.toThrow(/approval queue unavailable/);

    expect((await queue.read!()).submissions).toHaveLength(2);
    expect((await values.keys()).some(key =>
      key.startsWith("gmail:forwardSnapshot:") && !key.endsWith("totalBytes"))).toBe(false);
    expect((await values.keys()).some(key =>
      key.startsWith("gmail:forwardSnapshotAllocation:") && !key.endsWith("totalBytes")))
      .toBe(false);
    expect((await values.entries()).find(([key]) => key.endsWith("totalBytes"))?.[1]).toBe(0);
    expect((await values.keys()).some(key => key.startsWith("gmail:draft:"))).toBe(false);
    expect((await values.keys()).some(key => key.startsWith("pending:action:"))).toBe(false);
  });
});

describe("Gmail draft lookup", () => {
  it("assigns a stable query-safe Message-ID when sending an imported draft without one", async () => {
    const providerId = "provider-draft";
    let providerMessageId = "provider-message";
    const threadId = "provider-thread";
    const raw = [
      "From: me@example.com",
      "To: to@example.com",
      "Subject: Imported",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n");
    const {gatekeeper, values, storage} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (url.searchParams.get("format") === "full") {
          return json({
            id: providerId,
            message: {
              id: providerMessageId,
              threadId,
              internalDate: "1",
              sizeEstimate: raw.length,
              payload: {
                mimeType: "text/plain",
                headers: [
                  {name: "From", value: "me@example.com"},
                  {name: "To", value: "to@example.com"},
                  {name: "Subject", value: "Imported"},
                ],
                body: {data: base64Url("Body"), size: 4},
              },
            },
          });
        }
        return json({
          id: providerId,
          message: {id: providerMessageId, threadId, internalDate: "1", raw: base64Url(raw)},
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.getDraft(providerId);

    const sentMessageId = await draft.send();

    const action = await values.get<{messageId: string; approved: GmailDraftState}>("pending:action:1");
    if (!action) throw new Error("Missing staged draft-send action.");
    expect(action.messageId).toMatch(/^<[-0-9a-f]+@gadgets\.invalid>$/);
    expect(sentMessageId).toBe(action.messageId);
    expect(action.approved.rfcMessageId).toBe(action.messageId);
    // The message is read back under the send's own Message-ID before Gmail has it.
    await expect((await session.getMessage(sentMessageId)).getHeaders())
      .resolves.toContainEqual({name: "Message-ID", value: sentMessageId});
  });

  it("replaces an imported Message-ID with the send action identity used for reconciliation", async () => {
    const providerId = "provider-draft";
    const providerMessageId = "provider-message";
    const threadId = "provider-thread";
    const importedMessageId = "<already-delivered@example.com>";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: providerMessageId,
      threadId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Imported",
      text: "Body",
      rfcMessageId: importedMessageId,
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = buildEncodedEmail({
      from: state.from,
      to: state.to,
      cc: [],
      bcc: [],
      subject: state.subject,
      text: state.text,
      messageId: importedMessageId,
      attachments: [],
    });
    let sentRaw: string | undefined;
    let reconciliationMessageId = "";
    let delivered = false;
    let sends = 0;
    const searches: string[] = [];
    const {gatekeeper, values, storage} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (delivered) return json({error: "draft consumed"}, 404);
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, providerMessageId, threadId, state))
          : json({
              id: providerId,
              message: {id: providerMessageId, threadId, internalDate: "1", raw},
            });
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: providerMessageId}}]});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/send" && init.method === "POST") {
        sends++;
        delivered = true;
        sentRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        throw new Error("connection lost after draft send");
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        searches.push(url.searchParams.get("q") ?? "");
        return json({
          messages: delivered ? [{id: "sent-message", threadId}] : [],
        });
      }
      if (url.pathname === "/gmail/v1/users/me/messages/sent-message" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "sent-message", threadId, internalDate: "1", raw: sentRaw});
        }
        return json(messageMetadata("sent-message", threadId, reconciliationMessageId, ["SENT"]));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.getDraft(providerId);

    await draft.send();

    const action = await values.get<{messageId: string; approved: GmailDraftState}>("pending:action:1");
    if (!action) throw new Error("Missing staged draft-send action.");
    expect(action.messageId).not.toBe(importedMessageId);
    expect(action.approved.rfcMessageId).toBe(action.messageId);
    reconciliationMessageId = action.messageId;

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/connection lost/);
    await expect(draft.getMetadata()).rejects.toThrow(/uncertain send outcome/);
    await expect((await session.listDrafts()).next()).resolves.toBeNull();
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "active"});
    await gatekeeper.applyAction(1);

    expect((await parseMimeMessage(sentRaw!)).messageId).toBe(action.messageId);
    expect(searches).toEqual([
      `in:anywhere -in:drafts rfc822msgid:${action.messageId.slice(1, -1)}`,
    ]);
    expect(sends).toBe(1);
    await expect(values.get(`gmail:sentAlias:${action.messageId.slice(1, -1)}`)).resolves.toMatchObject({
      rfcMessageId: action.messageId,
      providerId: "sent-message",
      threadId,
    });
  });

  it("preserves an encoded nested message and calendar method through draft update", async () => {
    const providerId = "provider-draft";
    const threadId = "provider-thread";
    const nested = [
      "From: nested@example.com",
      "To: me@example.com",
      "Subject: Nested",
      "Message-ID: <nested@example.com>",
      "",
      "Nested body",
    ].join("\r\n");
    const calendar = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:invite@example.com",
      "SUMMARY:Review",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const initialMime = [
      "From: me@example.com",
      "To: to@example.com",
      "Subject: Imported MIME",
      "Message-ID: <imported-mime@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "Body",
      "--outer",
      'Content-Type: message/rfc822; name="nested.eml"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="nested.eml"',
      "",
      btoa(nested),
      "--outer",
      'Content-Type: text/calendar; method=REQUEST; name="invite.ics"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="invite.ics"',
      "",
      btoa(calendar),
      "--outer--",
      "",
    ].join("\r\n");
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Imported MIME",
      text: "Body",
      rfcMessageId: "<imported-mime@example.com>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    let providerMessageId = "provider-message-1";
    let providerRaw = base64Url(initialMime);
    let updatedRaw: string | undefined;
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (url.searchParams.get("format") === "full") {
          const full = draftFull(providerId, providerMessageId, threadId, state);
          full.message.sizeEstimate = base64UrlDecodedByteLength(providerRaw);
          return json(full);
        }
        return json({
          id: providerId,
          message: {id: providerMessageId, threadId, internalDate: "1", raw: providerRaw},
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updatedRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        providerRaw = updatedRaw;
        providerMessageId = "provider-message-2";
        return json({id: providerId, message: {id: providerMessageId}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.getDraft(providerId);

    await draft.update({subject: "Updated MIME"});
    await gatekeeper.applyAction(1);

    const nestedAttachments = extractRfc822Attachments(updatedRaw!);
    expect(nestedAttachments).toHaveLength(1);
    expect(new TextDecoder().decode(nestedAttachments[0].bytes)).toBe(`${nested}\r\n`);
    const parsed = await parseMimeMessage(updatedRaw!);
    expect(parsed.attachments.find(attachment => attachment.filename === "invite.ics"))
      .toMatchObject({mimeType: "text/calendar", method: "REQUEST"});
  });

  it("reopens a stable logical ID with pending updates overlaid", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const created = await session.createDraft({
      to: ["to@example.com"], subject: "Initial subject", text: "Body",
    });
    const {id} = await created.getMetadata();
    await created.update({subject: "Updated subject"});

    const reopened = await session.getDraft(id);

    await expect(reopened.getMetadata()).resolves.toMatchObject({
      id,
      subject: "Updated subject",
    });
  });

  it.each([
    {to: ["Cc Person <CC@EXAMPLE.COM>"]},
    {cc: ["To Person <TO@EXAMPLE.COM>"]},
    {bcc: ["to@example.com"]},
    {to: ["duplicate@example.com"], cc: ["Duplicate <DUPLICATE@example.com>"]},
  ] satisfies GmailDraftPatch[])(
    "rejects a recipient patch that duplicates a mailbox across fields: %j",
    async patch => {
      const {gatekeeper, values} = actionHarness(url => {
        throw new Error(`Unexpected request: ${url}`);
      });
      const session = await gatekeeper.startSession(approvalQueue());
      const draft = await session.createDraft({
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        subject: "Subject",
        text: "Body",
      });

      await expect(draft.update(patch)).rejects.toThrow(/cannot appear in more than one/);

      expect(await values.has("pending:action:2")).toBe(false);
      expect((await values.keys()).filter(key => key.startsWith("pending:action:"))).toEqual([
        "pending:action:1",
      ]);
    },
  );

  it("preserves omitted recipient fields in a unique draft recipient patch", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await session.createDraft({
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      subject: "Subject",
      text: "Body",
    });

    await draft.update({to: ["new@example.com"]});

    await expect(draft.getMetadata()).resolves.toMatchObject({
      to: [{address: "new@example.com"}],
      cc: [{address: "cc@example.com"}],
    });
  });

  it.each(["update", "delete", "send"] as const)(
    "restores a draft version when %s approval submission fails",
    async operation => {
      const logicalId = "provisional-draft";
      const state: GmailDraftState = {
        logicalId,
        from: "me@example.com",
        replyTo: [],
        to: ["to@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject",
        text: "Body",
        rfcMessageId: "<submission-failure@gadgets.invalid>",
        timestamp: 1,
        attachments: [],
        version: 0,
      };
      const {gatekeeper, storage, values} = actionHarness(url => {
        throw new Error(`Unexpected request: ${url}`);
      });
      storage.kv.put(`gmail:draft:${logicalId}`, {
        logicalId, createdAt: 1, status: "active", version: 0,
      });
      storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
      storage.kv.put("pending:nextActionId", 2);
      const session = await gatekeeper.startSession(approvalQueue("approval queue unavailable"));
      const draft = await session.getDraft(logicalId);

      const result = operation === "update"
        ? draft.update({subject: "Changed"})
        : operation === "delete" ? draft.delete() : draft.send();
      await expect(result).rejects.toThrow(/approval queue unavailable/);

      expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({version: 0});
      expect(await values.has("pending:action:2")).toBe(false);
    },
  );

  it("keeps the draft generation when a dependency applies during failed submission", async () => {
    const providerId = "provider-draft";
    const before: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Before",
      rfcMessageId: "<submission-race@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const firstUpdate: GmailDraftState = {...before, text: "First update", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    const beforeRaw = api.buildOutbound({
      ...outboundSpec(before.rfcMessageId), subject: before.subject, text: before.text,
    }).raw;
    const firstUpdateRaw = api.buildOutbound({
      ...outboundSpec(firstUpdate.rfcMessageId),
      subject: firstUpdate.subject,
      text: firstUpdate.text,
    }).raw;
    let providerMessageId = before.messageId!;
    let providerRaw = beforeRaw;
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (url.searchParams.get("format") === "full") {
          return json(draftFull(
            providerId, providerMessageId, before.threadId!,
            providerMessageId === before.messageId ? before : firstUpdate));
        }
        return json({
          id: providerId,
          message: {
            id: providerMessageId,
            threadId: before.threadId,
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        providerMessageId = "provider-message-2";
        providerRaw = firstUpdateRaw;
        return json({id: providerId, message: {id: providerMessageId}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after: firstUpdate,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: before.messageId,
      dependsOn: [],
    });
    storage.kv.put("pending:nextActionId", 2);
    const queue = approvalQueue("approval queue unavailable");
    const session = await gatekeeper.startSession(queue);
    const draft = await session.getDraft(providerId);
    await queue.pauseActionSubmission!();

    const updateExpectation = expect(draft.update({text: "Second update"}))
      .rejects.toThrow(/approval queue unavailable/);
    await queue.waitForPausedActionSubmission!();
    await gatekeeper.applyAction(1);
    await queue.releasePausedActionSubmission!();
    await updateExpectation;

    expect(updates).toBe(1);
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({version: 2});
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("pending:action:2")).toBe(false);
  });

  it("sends an imported HTML-only draft but keeps local drafts plain-text-required", async () => {
    const providerId = "provider-draft";
    const providerMessageId = "provider-message";
    const threadId = "provider-thread";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: providerMessageId,
      threadId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "HTML only",
      text: "",
      html: "<p>Visible body</p>",
      rfcMessageId: "<html-only@example.com>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId),
      subject: state.subject,
      text: "",
      html: state.html,
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, providerMessageId, threadId, state))
          : json({
              id: providerId,
              message: {id: providerMessageId, threadId, internalDate: "1", raw},
            });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect((await session.getDraft(providerId)).send())
      .resolves.toMatch(/^<[-0-9a-f]+@gadgets\.invalid>$/);
    await expect(values.get("pending:action:1")).resolves.toMatchObject({type: "draftSend"});

    const local = await session.createDraft({to: ["to@example.com"], html: "<p>Local</p>"});
    await expect(local.send()).rejects.toThrow(/plain-text body/);
  });

  it("does not reopen an unscoped draft through a restricted binding", async () => {
    const {gatekeeper, storage} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    storage.kv.put("gmail:draft:provider-draft", {
      logicalId: "provider-draft",
      providerId: "provider-draft",
      createdAt: 1,
      status: "active",
      version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getDraft("provider-draft")).rejects.toThrow(/restricted binding/);
  });

  it("tombstones a missing restricted draft and returns a later valid draft", async () => {
    const validState: GmailDraftState = {
      logicalId: "bbb",
      providerId: "bbb",
      messageId: "eee",
      threadId: "fff",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Later draft",
      text: "Body",
      rfcMessageId: "<later-draft@example.com>",
      timestamp: 1,
      source: {kind: "reply", messageId: "ddd"},
      attachments: [],
      version: 0,
    };
    const {calls, gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "Label_1", name: "Review", type: "user"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [
          {id: "ccc", threadId: "fff"},
          {id: "ddd", threadId: "fff"},
        ]});
      }
      if ((url.pathname === "/gmail/v1/users/me/messages/ccc" ||
           url.pathname === "/gmail/v1/users/me/messages/ddd") && !init.method) {
        const id = url.pathname.endsWith("ccc") ? "ccc" : "ddd";
        return json(messageMetadata(id, "fff", `<${id}@example.com>`, ["Label_1"]));
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/aaa" && !init.method) {
        return json({error: "missing"}, 404);
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/bbb" && !init.method) {
        return json(draftFull("bbb", "eee", "fff", validState));
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {labelName: "Review"});
    const snapshot = await captureForwardSnapshot(storage, new Uint8Array([1, 2, 3]));
    storage.kv.put("gmail:draft:aaa", {
      logicalId: "aaa",
      providerId: "aaa",
      source: {kind: "forward", messageId: "ccc", format: "inline"},
      forwardSnapshot: snapshot,
      createdAt: 1,
      status: "active",
      version: 0,
    });
    storage.kv.put("gmail:draft:bbb", {
      logicalId: "bbb",
      providerId: "bbb",
      source: validState.source,
      createdAt: 1,
      status: "active",
      version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());

    const entries = await (await session.listDrafts()).next();

    expect(entries?.map(entry => entry.info.id)).toEqual(["bbb"]);
    expect(calls.filter(call =>
      call.url.pathname === "/gmail/v1/users/me/messages")).toHaveLength(1);
    expect(await values.get("gmail:draft:aaa")).toMatchObject({status: "deleted"});
    expect((await values.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
  });

  it("skips an uncertain missing restricted draft without tombstoning it", async () => {
    const providerId = "abc123";
    const messageId = "def456";
    const threadId = "abc456";
    const sourceMessageId = "def123";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId,
      threadId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<uncertain-restricted-draft@gadgets.invalid>",
      timestamp: 1,
      source: {kind: "reply", messageId: sourceMessageId},
      attachments: [],
      version: 0,
    };
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: sourceMessageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({error: "draft consumed"}, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId,
      providerId,
      source: state.source,
      createdAt: 1,
      status: "active",
      version: 0,
    });
    storage.kv.put("pending:action:1", {
      type: "draftSend",
      draftId: providerId,
      approved: state,
      expectedSnapshot: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: messageId,
      messageId: state.rfcMessageId,
      dependsOn: [],
    });
    storage.kv.put("gmail:applying:1", Date.now());
    const session = await gatekeeper.startSession(approvalQueue());

    await expect((await session.listDrafts()).next()).resolves.toBeNull();
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "active"});
  });

  it("reports the verification limit when a restricted draft source walk exhausts its cap", async () => {
    let pages = 0;
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        pages++;
        return json({
          messages: [{id: pages.toString(16), threadId: "fff"}],
          nextPageToken: String(pages),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    storage.kv.put("gmail:draft:provider-draft", {
      logicalId: "provider-draft",
      source: {kind: "reply", messageId: "abc123"},
      createdAt: 1,
      status: "active",
      version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect((await session.listDrafts()).next())
      .rejects.toThrow(/too many messages to verify this capability/);
    expect(pages).toBe(20);
  });

  it("rejects malformed and unknown logical IDs", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getDraft("not/a/draft")).rejects.toThrow(/Invalid Gmail draft ID/);
    await expect(session.getDraft("unknown-draft")).rejects.toThrow(/Unknown Gmail draft ID/);
  });
});

describe("Gmail message lookup", () => {
  const messageId = "1a03a1e31ecc5e7f";
  const threadId = "1a03a1e31ecc5e70";

  it.each(["message", "thread"] as const)(
    "loads overlaid labels once for a %s cursor page",
    async kind => {
      const ids = ["1a03a1e31ecc5e71", "1a03a1e31ecc5e72"];
      let labelReads = 0;
      const {gatekeeper} = actionHarness((url, init) => {
        if (url.pathname === `/gmail/v1/users/me/${kind}s` && !init.method) {
          const entries = ids.map(id => kind === "message"
            ? {id, threadId}
            : {id, snippet: `Snippet ${id}`});
          return json(kind === "message" ? {messages: entries} : {threads: entries});
        }
        const messageIndex = ids.indexOf(url.pathname.split("/").at(-1) ?? "");
        if (kind === "message" && messageIndex >= 0 && !init.method) {
          return json(messageMetadata(ids[messageIndex], threadId, null, ["INBOX", "Label_1"]));
        }
        const threadIndex = ids.indexOf(url.pathname.split("/").at(-1) ?? "");
        if (kind === "thread" && threadIndex >= 0 && !init.method) {
          return json({
            id: ids[threadIndex],
            messages: [messageMetadata(
              `1a03a1e31ecc5e8${threadIndex}`, ids[threadIndex], null, ["INBOX", "Label_1"])],
          });
        }
        if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
          labelReads++;
          return json({labels: [{id: "Label_1", name: "Page label", type: "user"}]});
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const session = await gatekeeper.startSession(approvalQueue());

      const entries = kind === "message"
        ? await (await session.listMessages()).next()
        : await (await session.listThreads()).next();

      expect(entries).toHaveLength(2);
      const labels = [
        {id: "INBOX", name: "INBOX", type: "system"},
        {id: "Label_1", name: "Page label", type: "custom"},
      ];
      expect(entries?.map(entry => entry.info.labels)).toEqual([labels, labels]);
      expect(labelReads).toBe(1);
    },
  );

  it("returns rich thread summaries without reading message bodies", async () => {
    const first = messageMetadata(messageId, threadId, "<first@example.com>", [
      "INBOX", "UNREAD", "Label_1",
    ]);
    first.internalDate = "1000";
    first.payload.headers = [
      {name: "From", value: "Alice <alice@example.com>"},
      {name: "To", value: "owner@example.com, Team <team@example.com>"},
      {name: "Subject", value: "Project update"},
    ];
    const second = messageMetadata("1a03a1e31ecc5e71", threadId, "<second@example.com>", [
      "INBOX", "SENT",
    ]);
    second.internalDate = "2000";
    second.payload.headers = [
      {name: "From", value: "owner@example.com"},
      {name: "To", value: "Bob <bob@example.com>, alice@example.com"},
      {name: "Subject", value: "Re: Project update"},
    ];
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/threads" && !init.method) {
        return json({threads: [{id: threadId, snippet: "Latest reply"}]});
      }
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json({id: threadId, snippet: "Thread snippet", messages: [first, second]});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [
          {id: "INBOX", name: "INBOX", type: "system"},
          {id: "UNREAD", name: "UNREAD", type: "system"},
          {id: "SENT", name: "SENT", type: "system"},
          {id: "Label_1", name: "Project", type: "user"},
        ]});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {userInfo: () => ({sub: "account-subject", email: "owner@example.com"})});
    const session = await gatekeeper.startSession(approvalQueue());

    const entries = await (await session.listThreads()).next();

    expect(entries).toHaveLength(1);
    expect(entries![0].info).toEqual({
      id: threadId,
      snippet: "Latest reply",
      subject: "Project update",
      messageCount: 2,
      latestMessageId: "1a03a1e31ecc5e71",
      timestamp: new Date(2000),
      participants: [
        {address: "alice@example.com", name: "Alice"},
        {address: "owner@example.com"},
        {address: "team@example.com", name: "Team"},
        {address: "bob@example.com", name: "Bob"},
      ],
      unread: true,
      labels: [
        {id: "INBOX", name: "INBOX", type: "system"},
        {id: "UNREAD", name: "UNREAD", type: "system"},
        {id: "Label_1", name: "Project", type: "custom"},
        {id: "SENT", name: "SENT", type: "system"},
      ],
    });
  });

  it("opens a known message by ID without scanning the mailbox", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    const message = await session.getMessage(messageId);
    await expect(message.getMetadata()).resolves.toMatchObject({
      id: messageId,
      threadId,
      subject: "Known message",
    });

    expect(calls.filter(call =>
      call.url.pathname === "/gmail/v1/users/me/messages")).toHaveLength(0);
    expect(calls.filter(call =>
      call.url.pathname === `/gmail/v1/users/me/messages/${messageId}`)).toHaveLength(2);
  });

  it("bounds ordered message headers before authorizing their return", async () => {
    let headers = [
      {name: "Received", value: "first"},
      {name: "Received", value: "second"},
    ];
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        const metadata = messageMetadata(messageId, threadId);
        metadata.payload.headers = headers;
        return json(metadata);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage(messageId);

    await expect(message.getHeaders()).resolves.toEqual(headers);
    const headerObservations = () => queue.read!().then(result => result.observations.filter(
      observation => typeof observation === "object" && observation !== null &&
        "title" in observation && observation.title === "Read Gmail message headers"));
    expect(await headerObservations()).toHaveLength(1);
    headers = Array.from({length: 257}, (_, index) => ({name: `X-${index}`, value: "value"}));

    await expect(message.getHeaders()).rejects.toThrow(/more than 256 headers/);
    expect(await headerObservations()).toHaveLength(1);
  });

  it("shows a mark-read on one message capability before and after it is approved", async () => {
    let unread = true;
    let metadataReads = 0;
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        metadataReads++;
        return json(messageMetadata(
          messageId, threadId, "<refresh@example.com>", unread ? ["UNREAD"] : []));
      }
      if (url.pathname === "/gmail/v1/users/me/messages/batchModify" && init.method === "POST") {
        unread = false;
        return new Response(null, {status: 204});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const message = await session.getMessage(messageId);

    const {before, pending, after} = await message.markReadAndRefresh(1);

    expect(before.labels).toContainEqual({id: "UNREAD", name: "UNREAD", type: "system"});
    expect(pending.labels).not.toContainEqual({id: "UNREAD", name: "UNREAD", type: "system"});
    expect(after.labels).not.toContainEqual({id: "UNREAD", name: "UNREAD", type: "system"});
    expect(metadataReads).toBe(5);
  });

  it("refreshes externally renamed provider labels on one production session capability", async () => {
    let labelReads = 0;
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, "<labels@example.com>", ["Label_1"]));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        const name = labelReads++ === 0 ? "Before" : "After";
        return json({labels: [{id: "Label_1", name, type: "user"}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessageMetadataTwice(messageId)).resolves.toMatchObject({
      first: {labels: [{id: "Label_1", name: "Before", type: "custom"}]},
      second: {labels: [{id: "Label_1", name: "After", type: "custom"}]},
    });
    expect(labelReads).toBe(2);
  });

  it("refreshes a thread summary after its initial capability snapshot", async () => {
    let reads = 0;
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        reads++;
        const metadata = messageMetadata(messageId, threadId);
        metadata.payload.headers = [
          {name: "From", value: "sender@example.com"},
          {name: "To", value: "me@example.com"},
          {name: "Subject", value: reads === 1 ? "Before" : "After"},
        ];
        return json({id: threadId, messages: [metadata]});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getThreadMetadataTwice(threadId)).resolves.toMatchObject({
      first: {subject: "Before"},
      second: {subject: "After"},
    });
    expect(reads).toBe(2);
  });

  it("allows an empty direct reply", async () => {
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, undefined, ["INBOX"]));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const entries = await (await session.listMessages()).next();

    await entries![0].message.reply("");

    expect(await values.get("pending:action:1")).toMatchObject({
      type: "send",
      mode: "reply",
      spec: {text: ""},
    });
  });

  it("allows an empty reply draft to be sent", async () => {
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, undefined, ["INBOX"]));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const entries = await (await session.listMessages()).next();
    const draft = await entries![0].message.createReplyDraft("");

    const sentMessageId = await draft.send();
    expect(sentMessageId).toMatch(/^<[-0-9a-f]+@gadgets\.invalid>$/);

    expect(await values.get("pending:action:2")).toMatchObject({
      type: "draftSend",
      approved: {text: ""},
      messageId: sentMessageId,
    });
  });

  it("checks the immutable binding restriction before fetching a known message", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, "<restricted@example.com>"));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage(messageId)).rejects.toThrow(/restricted binding/);
    const scopeCheck = calls.find(call => call.url.pathname === "/gmail/v1/users/me/messages");
    expect(scopeCheck?.url.searchParams.get("q")).toBe("from:sender@example.com");
    expect(calls.some(call =>
      call.url.pathname === `/gmail/v1/users/me/messages/${messageId}`)).toBe(false);
  });

  it("falls back to the immutable binding query for a query-unsafe Message-ID", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, "<x@x)OR(is:unread>"));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage(messageId)).rejects.toThrow(/restricted binding/);
    const scopeCheck = calls.find(call => call.url.pathname === "/gmail/v1/users/me/messages");
    expect(scopeCheck?.url.searchParams.get("q")).toBe("from:sender@example.com");
    expect(scopeCheck?.url.searchParams.get("maxResults")).toBe("500");
  });

  it("matches the exact provider ID through the binding query when Message-ID is missing", async () => {
    const decoyId = "1a03a1e31ecc5e71";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, null));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: decoyId, threadId}, {id: messageId, threadId}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage(messageId)).resolves.toBeDefined();
    const scopeCheck = calls.find(call => call.url.pathname === "/gmail/v1/users/me/messages");
    expect(scopeCheck?.url.searchParams.get("q")).toBe("from:sender@example.com");
  });

  it("opens a message admitted by a search restriction", async () => {
    const rfcMessageId = "<admitted@example.com>";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage(messageId)).resolves.toBeDefined();
  });

  it("reports out-of-scope and stale restricted message IDs uniformly", async () => {
    const absentId = "1a03a1e31ecc5e71";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json({error: "missing"}, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());
    const errors: string[] = [];

    for (const id of [messageId, absentId]) {
      try {
        await session.getMessage(id);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }

    expect(errors).toEqual([
      "This Gmail message is not available through this restricted binding.",
      "This Gmail message is not available through this restricted binding.",
    ]);
    expect(calls.filter(call =>
      call.url.pathname.startsWith("/gmail/v1/users/me/messages/"))).toHaveLength(1);
  });

  it("reports out-of-scope and stale restricted thread IDs uniformly", async () => {
    const absentThreadId = "1a03a1e31ecc5e71";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json({error: "missing"}, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());
    const errors: string[] = [];

    for (const id of [threadId, absentThreadId]) {
      try {
        await session.getThread(id);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }

    expect(errors).toEqual([
      "This Gmail thread is not available through this restricted binding.",
      "This Gmail thread is not available through this restricted binding.",
    ]);
    expect(calls.filter(call =>
      call.url.pathname.startsWith("/gmail/v1/users/me/threads/"))).toHaveLength(1);
  });

  it("opens a known thread by ID without scanning the thread list", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json({
          id: threadId,
          messages: [{payload: {headers: [{name: "Subject", value: "Known thread"}]}}],
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    const thread = await session.getThread(threadId);
    await expect(thread.getMetadata()).resolves.toMatchObject({
      id: threadId,
      subject: "Known thread",
      messageCount: 1,
    });

    expect(calls.filter(call => call.url.pathname === "/gmail/v1/users/me/threads")).toHaveLength(0);
    expect(calls.filter(call =>
      call.url.pathname === `/gmail/v1/users/me/threads/${threadId}`)).toHaveLength(1);
  });

  it("matches a display-name participant against a bare message address", async () => {
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        if (url.searchParams.get("format") === "minimal") {
          return json(threadMinimal(threadId, [messageId]));
        }
        return json({
          id: threadId,
          messages: [{payload: {headers: [{name: "Subject", value: "Participant thread"}]}}],
        });
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        const metadata = messageMetadata(messageId, threadId, "<participant@example.com>");
        metadata.payload.headers = [
          {name: "From", value: "sender@example.com"},
          {name: "To", value: "person@example.com"},
          {name: "Subject", value: "Participant message"},
          {name: "Message-ID", value: "<participant@example.com>"},
        ];
        return json(metadata);
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const thread = await session.getThread(threadId);

    const visible = await thread.messagesVisibleTo("Person <PERSON@example.com>");

    expect(visible).toHaveLength(1);
    await expect(visible[0].getMetadata()).resolves.toMatchObject({id: messageId});
  });

  it("summarizes only messages admitted by a restricted thread capability", async () => {
    const excludedMessageId = "excluded-message";
    const admitted = messageMetadata(messageId, threadId, "<admitted@example.com>", ["INBOX"]);
    admitted.internalDate = "1000";
    admitted.payload.headers = [
      {name: "From", value: "Allowed <allowed@example.com>"},
      {name: "To", value: "owner@example.com"},
      {name: "Subject", value: "Visible subject"},
    ];
    const excluded = messageMetadata(
      excludedMessageId, threadId, "<excluded@example.com>", ["UNREAD", "Label_secret"]);
    excluded.internalDate = "9999";
    excluded.payload.headers = [
      {name: "From", value: "Secret <secret@example.com>"},
      {name: "To", value: "owner@example.com"},
      {name: "Subject", value: "Hidden subject"},
    ];
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId, excludedMessageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(admitted);
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${excludedMessageId}` && !init.method) {
        return json(excluded);
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [
          {id: "INBOX", name: "INBOX", type: "system"},
          {id: "UNREAD", name: "UNREAD", type: "system"},
          {id: "Label_secret", name: "Secret", type: "user"},
        ]});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {
      searchQuery: "from:allowed@example.com",
      userInfo: () => ({sub: "account-subject", email: "owner@example.com"}),
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const thread = await session.getThread(threadId);

    await expect(thread.getMetadata()).resolves.toEqual({
      id: threadId,
      subject: "Visible subject",
      messageCount: 1,
      // The newer excluded message must not leak through the cutoff hint.
      latestMessageId: messageId,
      timestamp: new Date(1000),
      participants: [
        {address: "allowed@example.com", name: "Allowed"},
        {address: "owner@example.com"},
      ],
      unread: false,
      labels: [{id: "INBOX", name: "INBOX", type: "system"}],
    });
  });

  it("limits a search-scoped thread to its admitted messages", async () => {
    const excludedMessageId = "excluded-message";
    const admittedRfcMessageId = "<admitted-thread@example.com>";
    const excludedRfcMessageId = "<excluded-thread@example.com>";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId, excludedMessageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, admittedRfcMessageId));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${excludedMessageId}` && !init.method) {
        return json(messageMetadata(excludedMessageId, threadId, excludedRfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    const thread = await session.getThread(threadId);
    await expect(thread.messages()).resolves.toHaveLength(1);
    const scopeChecks = calls.filter(call =>
      call.url.pathname === "/gmail/v1/users/me/messages" && !call.init.method);
    // The test proxy reopens the thread capability for messages(), so each operation walks the
    // binding query once rather than once per thread message.
    expect(scopeChecks).toHaveLength(2);
    expect(scopeChecks.map(call => call.url.searchParams.get("q")))
      .toEqual(["from:sender@example.com", "from:sender@example.com"]);
  });

  it("keeps proved thread matches when a broad binding query reaches its page budget", async () => {
    const excludedMessageId = "excluded-message";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId, excludedMessageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, null));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${excludedMessageId}` && !init.method) {
        return json(messageMetadata(excludedMessageId, threadId, null));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        const page = Number(url.searchParams.get("pageToken") ?? "0");
        return json({
          messages: page === 0 ? [{id: messageId, threadId}] : [{id: `decoy-${page}`, threadId}],
          nextPageToken: String(page + 1),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "after:1970/01/01"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getThread(threadId)).resolves.toBeDefined();

    const scopeChecks = calls.filter(call =>
      call.url.pathname === "/gmail/v1/users/me/messages" && !call.init.method);
    expect(scopeChecks).toHaveLength(20);
    expect(scopeChecks.every(call => call.url.searchParams.get("q") === "after:1970/01/01"))
      .toBe(true);
  });

  it("rejects a thread with no messages admitted by the binding", async () => {
    const rfcMessageId = "<outside-thread@example.com>";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getThread(threadId)).rejects.toThrow(/restricted binding/);
    expect(calls.some(call =>
      call.url.pathname === `/gmail/v1/users/me/threads/${threadId}`)).toBe(false);
  });

  it("limits a label-scoped thread to messages carrying the bound label", async () => {
    const admittedMessageId = "admitted-label-message";
    const excludedMessageId = "excluded-label-message";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "Label_1", name: "Team", type: "user"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [
          {id: messageId, threadId},
          {id: admittedMessageId, threadId},
        ]});
      }
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId, admittedMessageId, excludedMessageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, "<labeled@example.com>", ["Label_1"]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${admittedMessageId}` && !init.method) {
        return json(messageMetadata(
          admittedMessageId, threadId, "<also-labeled@example.com>", ["Label_1"]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${excludedMessageId}` && !init.method) {
        return json(messageMetadata(excludedMessageId, threadId, "<unlabeled@example.com>"));
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {labelName: "Team"});
    const session = await gatekeeper.startSession(approvalQueue());

    const thread = await session.getThread(threadId);
    await expect(thread.messages()).resolves.toHaveLength(2);

    const messageThread = await (await session.getMessage(messageId)).thread();
    const messageThreadEntries = await messageThread.messages();
    const messageThreadIds = await Promise.all(
      messageThreadEntries.map(async message => (await message.getMetadata()).id));
    expect(messageThreadIds).toEqual([messageId, admittedMessageId]);
  });

  it("reports a non-mutable system label as a domain error", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "SENT", name: "SENT", type: "system"}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage(messageId);

    await expect(message.applyLabel({id: "SENT", name: "SENT", type: "system"} as never))
      .rejects.toThrow(/not mutable/);

    expect((await queue.read!()).submissions).toHaveLength(0);
    expect(calls.some(call => call.url.pathname.endsWith("/modify"))).toBe(false);
  });

  it("rejects malformed message IDs before contacting Gmail", async () => {
    const {calls, gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage("INVALID_MSG_ID_12345"))
      .rejects.toThrow(/Invalid Gmail message ID/);
    expect(calls.some(call => call.url.pathname.startsWith("/gmail/v1/users/me/messages/"))).toBe(false);
  });

  it("rejects malformed thread IDs before contacting Gmail", async () => {
    const {calls, gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getThread("INVALID_THREAD_ID_12345"))
      .rejects.toThrow(/Invalid Gmail thread ID/);
    expect(calls.some(call => call.url.pathname.startsWith("/gmail/v1/users/me/threads/"))).toBe(false);
  });
});

describe("Gmail account identity", () => {
  it("adopts and persists a changed Workspace email for the same Google subject", async () => {
    let email = "old@example.com";
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {userInfo: () => ({sub: "stable-subject", email})});
    const firstSession = await gatekeeper.startSession(approvalQueue());
    await (await firstSession.listMessages()).next();

    email = "new@example.com";
    const secondSession = await gatekeeper.startSession(approvalQueue());
    await secondSession.send(["to@example.com"], "Subject", "Body");

    expect(await values.get("gmail:accountSubject")).toBe("stable-subject");
    expect(await values.get("selfEmail")).toBe("new@example.com");
    expect(await values.get("pending:action:1")).toMatchObject({
      type: "send", spec: {from: "new@example.com"},
    });
  });

  it("rejects a mismatching email on a legacy binding without a pinned subject", async () => {
    const {gatekeeper, storage, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {userInfo: () => ({sub: "current-subject", email: "new@example.com"})});
    storage.kv.put("selfEmail", "old@example.com");
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.send(["to@example.com"], "Subject", "Body"))
      .rejects.toThrow(/different Google account/);

    expect(await values.get("selfEmail")).toBe("old@example.com");
    expect(await values.has("gmail:accountSubject")).toBe(false);
    expect(await values.has("pending:action:1")).toBe(false);
  });
});

describe("Gmail message mutations", () => {
  const batchModifyPath = "/gmail/v1/users/me/messages/batchModify";
  type BatchBody = {ids: string[]; addLabelIds: string[]; removeLabelIds: string[]};
  const batchBodies = (calls: FetchCall[]) => calls
    .filter(call => call.url.pathname === batchModifyPath && call.init.method === "POST")
    .map(call => JSON.parse(String(call.init.body)) as BatchBody);

  // A whole-mailbox thread whose message list can grow between calls, like a live inbox.
  function liveThreadHarness(threadMessages: string[]) {
    const harness = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/threads/abc" && !init.method) {
        if (url.searchParams.get("format") === "minimal") {
          return json(threadMinimal("abc", threadMessages));
        }
        return json({id: "abc", messages: threadMessages.map((id, i) => ({
          ...messageMetadata(id, "abc"), internalDate: String(i + 1),
        }))});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "Label_1", name: "Done", type: "user"}]});
      }
      if (url.pathname === batchModifyPath && init.method === "POST") {
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    return harness;
  }

  it("reports the newest message as latestMessageId", async () => {
    const {gatekeeper} = liveThreadHarness(["a1", "a2", "a3"]);
    const session = await gatekeeper.startSession(approvalQueue());
    await expect((await session.getThread("abc")).getMetadata())
      .resolves.toMatchObject({messageCount: 3, latestMessageId: "a3"});
  });

  it("leaves messages after lastMessageId untouched, even ones arriving before approval", async () => {
    const threadMessages = ["a1", "a2"];
    const {calls, gatekeeper} = liveThreadHarness(threadMessages);
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const thread = await session.getThread("abc");
    const {latestMessageId} = await thread.getMetadata();

    threadMessages.push("a3"); // Arrives after the user saw the thread.
    await thread.mutate("archive", latestMessageId);
    threadMessages.push("a4"); // Arrives while the action awaits approval.
    await gatekeeper.applyAction(1);

    expect(batchBodies(calls)).toEqual([
      {ids: ["a1", "a2"], addLabelIds: [], removeLabelIds: ["INBOX"]},
    ]);
    const [submission] = (await queue.read!()).submissions;
    expect(fieldOf(submission.description, "Message IDs")).toMatchObject({items: ["a1", "a2"]});
    expect(calls.some(call => call.url.pathname.startsWith("/gmail/v1/users/me/threads/abc/")))
      .toBe(false);
  });

  it("fixes the message set at submission when lastMessageId is omitted", async () => {
    const threadMessages = ["a1", "a2"];
    const {calls, gatekeeper} = liveThreadHarness(threadMessages);
    const session = await gatekeeper.startSession(approvalQueue());

    await (await session.getThread("abc")).mutate("markRead");
    threadMessages.push("a3");
    await gatekeeper.applyAction(1);

    expect(batchBodies(calls)).toEqual([
      {ids: ["a1", "a2"], addLabelIds: [], removeLabelIds: ["UNREAD"]},
    ]);
  });

  it("applies a label through lastMessageId", async () => {
    const {calls, gatekeeper} = liveThreadHarness(["a1", "a2", "a3"]);
    const session = await gatekeeper.startSession(approvalQueue());

    await (await session.getThread("abc")).mutate(
      "applyLabel", "a2", {id: "Label_1", name: "Done", type: "custom"});
    await gatekeeper.applyAction(1);

    expect(batchBodies(calls)).toEqual([
      {ids: ["a1", "a2"], addLabelIds: ["Label_1"], removeLabelIds: []},
    ]);
  });

  it("rejects a lastMessageId that is not in the thread", async () => {
    const {gatekeeper} = liveThreadHarness(["a1"]);
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    await expect((await session.getThread("abc")).mutate("trash", "ffff"))
      .rejects.toThrow(/lastMessageId/);
    expect((await queue.read!()).submissions).toHaveLength(0);
  });

  it("limits a restricted thread cutoff to its admitted messages", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: "a3", threadId: "abc"}, {id: "a1", threadId: "abc"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/threads/abc" && !init.method) {
        return json(threadMinimal("abc", ["a1", "a2", "a3", "a4"]));
      }
      if (/^\/gmail\/v1\/users\/me\/messages\/a[1-4]$/.test(url.pathname) && !init.method) {
        const id = url.pathname.split("/").pop()!;
        return json({...messageMetadata(id, "abc"), internalDate: id.slice(1)});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      if (url.pathname === batchModifyPath && init.method === "POST") {
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());
    const thread = await session.getThread("abc");

    await expect(thread.getMetadata()).resolves.toMatchObject({latestMessageId: "a3"});
    await expect(thread.mutate("star", "a2")).rejects.toThrow(/lastMessageId/);
    await thread.mutate("star", "a3");
    await gatekeeper.applyAction(1);

    expect(batchBodies(calls)).toEqual([
      {ids: ["a1", "a3"], addLabelIds: ["STARRED"], removeLabelIds: []},
    ]);
  });

  it.each([
    ["archive", undefined, {addLabelIds: [], removeLabelIds: ["INBOX"]}],
    ["trash", undefined, {addLabelIds: ["TRASH"], removeLabelIds: []}],
    ["markRead", undefined, {addLabelIds: [], removeLabelIds: ["UNREAD"]}],
    ["markUnread", undefined, {addLabelIds: ["UNREAD"], removeLabelIds: []}],
    ["star", undefined, {addLabelIds: ["STARRED"], removeLabelIds: []}],
    ["unstar", undefined, {addLabelIds: [], removeLabelIds: ["STARRED"]}],
    ["applyLabel", "TRASH", {addLabelIds: ["TRASH"], removeLabelIds: []}],
    ["removeLabel", "TRASH", {addLabelIds: [], removeLabelIds: ["TRASH"]}],
  ] as const)("applies %s as one batchModify call", async (operation, labelId, body) => {
    const {calls, gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === batchModifyPath && init.method === "POST") {
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "messageMutation",
      operation,
      target: {kind: "messages", messageIds: ["aaa", "bbb"]},
      ...(labelId ? {labelId} : {}),
    });

    await gatekeeper.applyAction(1);

    expect(batchBodies(calls)).toEqual([{ids: ["aaa", "bbb"], ...body}]);
  });

  it("splits more than 1000 messages across batchModify calls", async () => {
    const {calls, gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === batchModifyPath && init.method === "POST") {
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const messageIds = Array.from({length: 1001}, (_, i) => `m${i}`);
    storage.kv.put("pending:action:1", {
      type: "messageMutation", operation: "archive", target: {kind: "messages", messageIds},
    });

    await gatekeeper.applyAction(1);

    expect(batchBodies(calls).map(body => body.ids)).toEqual([
      messageIds.slice(0, 1000), messageIds.slice(1000),
    ]);
  });

  it.each([
    ["archive", undefined, "/modify", {addLabelIds: [], removeLabelIds: ["INBOX"]}],
    ["markUnread", undefined, "/modify", {addLabelIds: ["UNREAD"], removeLabelIds: []}],
    ["trash", undefined, "/trash", undefined],
    ["applyLabel", "TRASH", "/trash", undefined],
    ["removeLabel", "TRASH", "/untrash", undefined],
  ] as const)("still applies a legacy thread-wide %s action", async (
      operation, labelId, suffix, body) => {
    const {calls, gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/thread${suffix}` && init.method === "POST") {
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "messageMutation",
      operation,
      target: {kind: "thread", threadId: "thread"},
      ...(labelId ? {labelId} : {}),
    });

    await gatekeeper.applyAction(1);

    const call = calls.find(item => item.url.pathname.includes("/threads/thread"));
    expect(call?.url.pathname).toBe(`/gmail/v1/users/me/threads/thread${suffix}`);
    if (body) expect(JSON.parse(String(call?.init.body))).toEqual(body);
  });

  it("keeps a partially applied multi-chunk mutation unrejectable until retry succeeds", async () => {
    let rejectSecond = true;
    const writes: string[] = [];
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === batchModifyPath && init.method === "POST") {
        const first = (JSON.parse(String(init.body)) as BatchBody).ids[0];
        writes.push(first);
        if (first === "m1000" && rejectSecond) {
          rejectSecond = false;
          return json({error: "invalid mutation"}, 400);
        }
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "messageMutation",
      operation: "markRead",
      target: {kind: "messages", messageIds: Array.from({length: 1001}, (_, i) => `m${i}`)},
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/messages\.batchModify failed/);

    expect(await values.has("gmail:applying:1")).toBe(true);
    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/uncertain provider outcome/);

    await gatekeeper.applyAction(1);

    expect(writes).toEqual(["m0", "m1000", "m0", "m1000"]);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:applying:1")).toBe(false);
  });

  it("allows rejection when the first batchModify gets a definitive 400", async () => {
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === batchModifyPath && init.method === "POST") {
        return json({error: "invalid mutation"}, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "messageMutation",
      operation: "markRead",
      target: {kind: "messages", messageIds: ["aaa", "bbb"]},
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/messages\.batchModify failed/);

    expect(await values.has("gmail:applying:1")).toBe(false);
    await expect(gatekeeper.rejectAction(1)).resolves.toBeUndefined();
    expect(await values.has("pending:action:1")).toBe(false);
  });

  it("skips messages deleted since the first attempt while reconciling", async () => {
    const batches: string[][] = [];
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === batchModifyPath && init.method === "POST") {
        const {ids} = JSON.parse(String(init.body)) as BatchBody;
        batches.push(ids);
        return ids.includes("aaa") ? json({error: "missing"}, 404) : new Response(null, {status: 204});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/aaa" && !init.method) {
        return json({error: "missing"}, 404);
      }
      if (url.pathname === "/gmail/v1/users/me/messages/bbb" && !init.method) {
        return json(messageMetadata("bbb", "thread"));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "messageMutation",
      operation: "markRead",
      target: {kind: "messages", messageIds: ["aaa", "bbb"]},
    });
    storage.kv.put("gmail:applying:1", Date.now());

    await gatekeeper.applyAction(1);

    expect(batches).toEqual([["aaa", "bbb"], ["bbb"]]);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:applying:1")).toBe(false);
  });
});

const systemLabel = (id: string) => ({id, name: id, type: "system"});

const entryIds = (entries: Array<{info: {id: string}}> | null) =>
  entries?.map(entry => entry.info.id) ?? null;

const infoIds = (infos: Array<{id: string}>) => infos.map(info => info.id);

/** The IDs a thread's message capabilities report, in the order the thread returned them. */
async function memberIds(messages: Promise<TestMessage[]>): Promise<string[]> {
  return infoIds(await Promise.all((await messages).map(message => message.getMetadata())));
}

const headerNamed = (headers: Array<{name: string; value: string}>, name: string) =>
  headers.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())?.value;

const decodeText = (content: ArrayBuffer | undefined) => new TextDecoder().decode(content);

/** A message as a fake mailbox keeps it: the MIME it was given, and what Gmail adds to it. */
type FakeMail = {
  id: string; threadId: string; labelIds: string[]; internalDate: number; from: string;
  raw: string;
};

// Gmail returns header values decoded, which matters for the subject's encoded-word form.
async function fakeMailHeaders(mail: FakeMail): Promise<Array<{name: string; value: string}>> {
  const parsed = await parseMimeMessage(mail.raw);
  return parsed.headers.map(candidate => ({
    name: candidate.originalKey ?? candidate.key,
    value: candidate.key === "subject" ? parsed.subject ?? "" : candidate.value,
  }));
}

const fakeMailRaw = (mail: FakeMail) => ({
  id: mail.id, threadId: mail.threadId, internalDate: String(mail.internalDate),
  labelIds: mail.labelIds, raw: mail.raw,
});

describe("Gmail pending label changes", () => {
  type FakeMessage = {id: string; threadId: string; labelIds: string[]};
  const teamLabel = {id: "Label_1", name: "Team", type: "custom"};

  // A mailbox that answers every read from its own labels, as Gmail does. Nothing in it changes
  // until an action is applied, so whatever a read shows beyond it is the simulation.
  function mailboxHarness(
      mailbox: FakeMessage[], options: {
        searchQuery?: string;
        labelName?: string;
        /** Runs ahead of each request, which waits for it. */
        beforeRequest?: (url: URL, init: RequestInit) => Promise<void>;
        /** Runs once the mailbox has acted on a request, which waits for it before answering. */
        beforeResponse?: (url: URL, init: RequestInit) => Promise<void>;
      } = {}) {
    const userLabels = [{id: "Label_1", name: "Team", type: "user"}];
    const metadata = (message: FakeMessage) => ({
      ...messageMetadata(message.id, message.threadId, null, message.labelIds),
      internalDate: String(mailbox.indexOf(message) + 1),
    });
    const listed = (url: URL) => {
      const labelIds = url.searchParams.getAll("labelIds");
      const query = url.searchParams.get("q") ?? "";
      const spamTrash = url.searchParams.get("includeSpamTrash") === "true";
      return mailbox.filter(message =>
        labelIds.every(id => message.labelIds.includes(id)) &&
        (spamTrash || !message.labelIds.some(id => id === "TRASH" || id === "SPAM")) &&
        (!query.includes("is:unread") || message.labelIds.includes("UNREAD")));
    };
    const respond = (url: URL, init: RequestInit): Response => {
      const [collection, id] = url.pathname.replace("/gmail/v1/users/me/", "").split("/");
      if (collection === "labels" && !init.method) {
        return json({labels: [
          ...["INBOX", "UNREAD", "STARRED", "TRASH"].map(systemLabel), ...userLabels,
        ]});
      }
      if (collection === "labels" && init.method === "POST") {
        const {name} = JSON.parse(String(init.body)) as {name: string};
        userLabels.push({id: `Label_${userLabels.length + 1}`, name, type: "user"});
        return json(userLabels.at(-1));
      }
      if (collection === "messages" && id === "batchModify" && init.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          ids: string[]; addLabelIds: string[]; removeLabelIds: string[];
        };
        for (const message of mailbox.filter(candidate => body.ids.includes(candidate.id))) {
          message.labelIds = [
            ...message.labelIds.filter(label =>
              !body.removeLabelIds.includes(label) && !body.addLabelIds.includes(label)),
            ...body.addLabelIds,
          ];
        }
        return new Response(null, {status: 204});
      }
      if (init.method) throw new Error(`Unexpected request: ${init.method} ${url}`);
      if (collection === "messages" && id === undefined) {
        return json({messages: listed(url).map(message => ({
          id: message.id, threadId: message.threadId,
        }))});
      }
      if (collection === "threads" && id === undefined) {
        return json({threads: [...new Set(listed(url).map(message => message.threadId))]
          .map(threadId => ({id: threadId}))});
      }
      const message = mailbox.find(candidate => candidate.id === id);
      if (collection === "messages" && message) return json(metadata(message));
      const thread = mailbox.filter(candidate => candidate.threadId === id);
      if (collection === "threads" && thread.length) {
        return json(url.searchParams.get("format") === "minimal"
          ? threadMinimal(id, thread.map(candidate => candidate.id))
          : {id, messages: thread.map(metadata)});
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    return actionHarness(async (url, init) => {
      await options.beforeRequest?.(url, init);
      const response = respond(url, init);
      await options.beforeResponse?.(url, init);
      return response;
    }, options);
  }

  it("shows a pending mark-read in message and thread metadata until it is decided", async () => {
    const mailbox = [{id: "a1", threadId: "aa", labelIds: ["INBOX", "UNREAD"]}];
    const {gatekeeper} = mailboxHarness(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());
    const read = async () => ({
      message: await (await session.getMessage("a1")).getMetadata(),
      thread: await (await session.getThread("aa")).getMetadata(),
    });

    await (await session.getMessage("a1")).mutate("markRead");

    // Gmail still has the message unread; only the reads have moved on.
    expect(mailbox[0].labelIds).toEqual(["INBOX", "UNREAD"]);
    let shown = await read();
    expect(shown.message.labels).toEqual([systemLabel("INBOX")]);
    expect(shown.thread).toMatchObject({unread: false, labels: [systemLabel("INBOX")]});

    await gatekeeper.rejectAction(1);
    shown = await read();
    expect(shown.message.labels).toEqual([systemLabel("INBOX"), systemLabel("UNREAD")]);
    expect(shown.thread).toMatchObject({unread: true, labels: [systemLabel("INBOX"), systemLabel("UNREAD")]});

    await (await session.getMessage("a1")).mutate("markRead");
    await gatekeeper.applyAction(2);
    expect(mailbox[0].labelIds).toEqual(["INBOX"]);
    shown = await read();
    expect(shown.message.labels).toEqual([systemLabel("INBOX")]);
    expect(shown.thread).toMatchObject({unread: false, labels: [systemLabel("INBOX")]});
  });

  it("applies opposing pending changes in the order they were submitted", async () => {
    const mailbox = [{id: "a1", threadId: "aa", labelIds: ["INBOX"]}];
    const {gatekeeper} = mailboxHarness(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());
    const message = await session.getMessage("a1");

    await message.mutate("star");
    await message.mutate("unstar");
    await expect(message.getMetadata()).resolves.toMatchObject({labels: [systemLabel("INBOX")]});

    await message.mutate("star");
    await expect(message.getMetadata()).resolves.toMatchObject({
      labels: [systemLabel("INBOX"), systemLabel("STARRED")],
    });
  });

  it.each([
    ["shows the label once", false],
    ["honors a removal queued behind them", true],
  ])("%s when a label's creation and application are approved during a read", async (_, removal) => {
    const mailbox = [{id: "a1", threadId: "aa", labelIds: ["INBOX"]}];
    // Holds one metadata fetch open while actions apply. Flags rather than promises, because
    // workerd refuses to resume a promise resolved by another Durable Object.
    const pause = {countdown: 0, reached: false, released: false};
    const {gatekeeper} = mailboxHarness(mailbox, {
      async beforeRequest(url, init) {
        if (url.pathname.endsWith("/messages/a1") && !init.method && pause.countdown > 0 &&
            --pause.countdown === 0) {
          pause.reached = true;
          await until(() => pause.released);
        }
      },
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const label = await session.createLabel("New");
    const message = await session.getMessage("a1");
    await message.applyLabel(label);
    if (removal) await message.removeLabel(label);

    // The read opens the message, loads the pending actions, then fetches its metadata again.
    // Gmail answers that second fetch only after it has the label and has put it on the message.
    pause.countdown = 2;
    const read = message.getMetadata();
    await until(() => pause.reached);
    await gatekeeper.applyAction(1);
    await gatekeeper.applyAction(2);
    expect(mailbox[0].labelIds).toEqual(["INBOX", "Label_2"]);
    pause.released = true;

    expect((await read).labels).toEqual(removal
      ? [systemLabel("INBOX")]
      : [systemLabel("INBOX"), {id: label.id, name: "New", type: "custom"}]);
  });

  it.each([
    ["message", false], ["message", true], ["thread", false], ["thread", true],
  ] as const)(
    "renders a %s page consistently when a label's creation lands mid-read (removal queued: %s)",
    async (kind, removal) => {
      const mailbox = [{id: "a1", threadId: "aa", labelIds: ["INBOX"]}];
      // Flags rather than promises, as above.
      const creation = {reached: false, released: false};
      const metadata = {armed: false, reached: false, released: false};
      const metadataPath = kind === "message" ? "/messages/a1" : "/threads/aa";
      const {gatekeeper} = mailboxHarness(mailbox, {
        async beforeRequest(url, init) {
          if (metadata.armed && !init.method && url.pathname.endsWith(metadataPath)) {
            metadata.armed = false;
            metadata.reached = true;
            await until(() => metadata.released);
          }
        },
        async beforeResponse(url, init) {
          if (init.method === "POST" && url.pathname.endsWith("/labels")) {
            creation.reached = true;
            await until(() => creation.released);
          }
        },
      });
      const session = await gatekeeper.startSession(approvalQueue());
      const label = await session.createLabel("New");
      const message = await session.getMessage("a1");
      await message.applyLabel(label);
      if (removal) await message.removeLabel(label);

      // Gmail now has the label, but the gatekeeper has yet to learn the ID Gmail gave it. A
      // label list read here names the label twice: Gmail's record, and the provisional one.
      const creating = gatekeeper.applyAction(1);
      await until(() => creation.reached);
      // The page's read starts in that state, and is held at its metadata fetch while the
      // creation and the application finish. Gmail answers with the label on the message.
      metadata.armed = true;
      const page = kind === "message"
        ? (await session.listMessages()).next()
        : (await session.listThreads()).next();
      await until(() => metadata.reached);
      creation.released = true;
      await creating;
      await gatekeeper.applyAction(2);
      expect(mailbox[0].labelIds).toEqual(["INBOX", "Label_2"]);
      metadata.released = true;

      expect((await page)?.map(entry => entry.info.labels)).toEqual([removal
        ? [systemLabel("INBOX")]
        : [systemLabel("INBOX"), {id: label.id, name: "New", type: "custom"}]]);
    },
  );

  it("recomputes a listed thread's summary after an action changes one of its messages", async () => {
    const mailbox = [{id: "a1", threadId: "aa", labelIds: ["INBOX", "UNREAD"]}];
    const {gatekeeper} = mailboxHarness(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());

    const {listed, afterwards} = await session.listedThreadAfterArchivingMessage("aa");

    expect(listed.labels).toEqual([systemLabel("INBOX"), systemLabel("UNREAD")]);
    // The capability carried the summary from the list, which predates the archive.
    expect(afterwards.labels).toEqual([systemLabel("UNREAD")]);
  });

  it("accepts more than 100 pending label changes", async () => {
    const mailbox = [{id: "a1", threadId: "aa", labelIds: ["INBOX"]}];
    const {gatekeeper, storage, values} = mailboxHarness(mailbox);
    for (let id = 1; id <= 100; id++) {
      storage.kv.put(`pending:action:${id}`, {
        type: "messageMutation",
        operation: id % 2 ? "star" : "unstar",
        target: {kind: "messages", messageIds: ["a1"]},
      });
    }
    storage.kv.put("pending:nextActionId", 101);
    const session = await gatekeeper.startSession(approvalQueue());
    const message = await session.getMessage("a1");

    await message.mutate("archive");

    const pending = (await values.keys()).filter(key => key.startsWith("pending:action:"));
    expect(pending).toHaveLength(101);
    // All of them show: the hundredth unstarred the message, the newest archived it.
    await expect(message.getMetadata()).resolves.toMatchObject({labels: []});
  });

  it("drops archived mail from the inbox lists", async () => {
    const mailbox = [
      {id: "a1", threadId: "aa", labelIds: ["INBOX"]},
      {id: "b1", threadId: "bb", labelIds: ["INBOX"]},
      {id: "b2", threadId: "bb", labelIds: ["INBOX"]},
    ];
    const before = structuredClone(mailbox);
    const {gatekeeper} = mailboxHarness(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());
    const threads = async () => (await session.listThreads()).next();
    const messages = async () => entryIds(await (await session.listMessages()).next());
    expect(entryIds(await threads())).toEqual(["aa", "bb"]);

    await (await session.getThread("aa")).mutate("archive");
    expect(entryIds(await threads())).toEqual(["bb"]);
    expect(await messages()).toEqual(["b1", "b2"]);

    // A thread stays listed while any of its messages is still in the inbox.
    await (await session.getMessage("b1")).mutate("archive");
    expect(await threads()).toMatchObject([{info: {id: "bb", labels: [systemLabel("INBOX")]}}]);
    expect(await messages()).toEqual(["b2"]);

    await (await session.getMessage("b2")).mutate("archive");
    expect(await threads()).toBeNull();
    expect(await messages()).toBeNull();
    expect(mailbox).toEqual(before);
  });

  it("drops trashed mail from search results unless the search includes trash", async () => {
    const mailbox = [
      {id: "a1", threadId: "aa", labelIds: ["INBOX"]},
      {id: "b1", threadId: "bb", labelIds: []},
    ];
    const {gatekeeper} = mailboxHarness(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());
    const query = "from:sender@example.com";
    expect(entryIds(await (await session.searchMessages(query)).next())).toEqual(["a1", "b1"]);

    await (await session.getMessage("a1")).mutate("trash");

    expect(entryIds(await (await session.searchMessages(query)).next())).toEqual(["b1"]);
    expect(entryIds(await (await session.searchThreads(query)).next())).toEqual(["bb"]);
    expect(await (await session.searchMessages(`in:anywhere ${query}`)).next()).toMatchObject([
      {info: {id: "a1", labels: [systemLabel("INBOX"), systemLabel("TRASH")]}},
      {info: {id: "b1", labels: []}},
    ]);
  });

  it("empties an is:unread search once each result has been marked read", async () => {
    const mailbox = [
      {id: "a1", threadId: "aa", labelIds: ["INBOX", "UNREAD"]},
      {id: "a2", threadId: "aa", labelIds: ["INBOX"]},
      {id: "b1", threadId: "bb", labelIds: ["INBOX", "UNREAD"]},
      {id: "b2", threadId: "bb", labelIds: ["INBOX", "UNREAD"]},
    ];
    const before = structuredClone(mailbox);
    const {gatekeeper} = mailboxHarness(mailbox);
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const unread = async () => (await session.searchThreads("is:unread")).next();

    // A thread matches while any of its messages still does.
    await (await session.getMessage("b1")).mutate("markRead");
    expect(await unread()).toMatchObject([
      {info: {id: "aa", unread: true}}, {info: {id: "bb", unread: true}},
    ]);
    expect(entryIds(await (await session.searchMessages("is:unread")).next())).toEqual(["a1", "b2"]);

    // An agent working through unread mail: search, mark each result read, search again.
    let rounds = 0;
    for (let page = await unread(); page; page = await unread()) {
      expect(++rounds).toBe(1);
      for (const {thread} of page) await thread.mutate("markRead");
    }
    expect(rounds).toBe(1);
    expect((await queue.read!()).submissions).toHaveLength(3);
    expect(await (await session.searchMessages("is:unread")).next()).toBeNull();
    expect(await (await session.searchMessages("-is:read")).next()).toBeNull();

    // A query the gatekeeper cannot evaluate keeps Gmail's results, with their labels patched.
    expect(await (await session.searchThreads("is:unread OR is:starred")).next()).toMatchObject([
      {info: {id: "aa", unread: false}}, {info: {id: "bb", unread: false}},
    ]);
    expect(mailbox).toEqual(before);
  });

  it("drops a message from a label binding's lists once the label is removed from it", async () => {
    const mailbox = [
      {id: "a1", threadId: "aa", labelIds: ["Label_1"]},
      {id: "a2", threadId: "aa", labelIds: ["Label_1"]},
      {id: "b1", threadId: "bb", labelIds: ["INBOX", "Label_1"]},
      {id: "c1", threadId: "cc", labelIds: ["INBOX"]},
    ];
    const before = structuredClone(mailbox);
    const {gatekeeper} = mailboxHarness(mailbox, {labelName: "Team"});
    const session = await gatekeeper.startSession(approvalQueue());
    const threads = async () => (await session.listThreads()).next();
    const messages = async () => entryIds(await (await session.listMessages()).next());
    expect(await messages()).toEqual(["a1", "a2", "b1"]);

    await (await session.getMessage("a1")).removeLabel(teamLabel);
    expect(await messages()).toEqual(["a2", "b1"]);
    // The thread narrows to the messages still carrying the label.
    expect(await threads()).toMatchObject([
      {info: {id: "aa", messageCount: 1, latestMessageId: "a2"}},
      {info: {id: "bb", messageCount: 1}},
    ]);

    await (await session.getMessage("a2")).removeLabel(teamLabel);
    expect(await messages()).toEqual(["b1"]);
    expect(entryIds(await threads())).toEqual(["bb"]);
    expect(mailbox).toEqual(before);
  });

  it("drops a message from a search binding's lists once it no longer matches", async () => {
    const mailbox = [
      {id: "a1", threadId: "aa", labelIds: ["INBOX", "UNREAD"]},
      {id: "b1", threadId: "bb", labelIds: ["UNREAD"]},
    ];
    const {gatekeeper} = mailboxHarness(mailbox, {searchQuery: "is:unread"});
    const session = await gatekeeper.startSession(approvalQueue());
    expect(entryIds(await (await session.listMessages()).next())).toEqual(["a1", "b1"]);

    await (await session.getMessage("a1")).mutate("markRead");

    expect(entryIds(await (await session.listMessages()).next())).toEqual(["b1"]);
    expect(entryIds(await (await session.listThreads()).next())).toEqual(["bb"]);
    expect(entryIds(await (await session.searchMessages("from:sender@example.com")).next()))
      .toEqual(["b1"]);
  });

  it("shows a label moved onto a message without adding the message to a list", async () => {
    const mailbox = [
      {id: "a1", threadId: "aa", labelIds: ["INBOX"]},
      {id: "b1", threadId: "bb", labelIds: []},
    ];
    const {gatekeeper} = mailboxHarness(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());
    const archived = await session.getMessage("b1");

    await archived.applyLabel(systemLabel("INBOX"));

    await expect(archived.getMetadata()).resolves.toMatchObject({labels: [systemLabel("INBOX")]});
    // Gmail does not list it in the inbox yet, and the gatekeeper never adds to Gmail's results.
    expect(entryIds(await (await session.listMessages()).next())).toEqual(["a1"]);
    expect(entryIds(await (await session.listThreads()).next())).toEqual(["aa"]);
  });

  it("drops a result Gmail's index returns after it stopped matching", async () => {
    // No pending action: the listed message's own labels already contradict the list.
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: "a1", threadId: "aa"}, {id: "b1", threadId: "bb"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/a1" && !init.method) {
        return json(messageMetadata("a1", "aa", null, ["INBOX"]));
      }
      if (url.pathname === "/gmail/v1/users/me/messages/b1" && !init.method) {
        return json(messageMetadata("b1", "bb", null, []));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [systemLabel("INBOX")]});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());

    expect(entryIds(await (await session.listMessages()).next())).toEqual(["a1"]);
  });
});

describe("Gmail pending sends", () => {
  const ME = "me@example.com";
  const SENDER = "sender@example.com";
  const batchModifyPath = "/gmail/v1/users/me/messages/batchModify";
  // The messages each submitted mutation names, in submission order.
  const mutationTargets = async (queue: ApprovalQueueHandle) =>
    (await queue.read!()).submissions.flatMap(({description}) => {
      const field = fieldOf(description, "Message IDs") as {items: string[]} | undefined;
      return field ? [field.items] : [];
    });

  // A mailbox that keeps every message as the MIME it was given and answers each read from it,
  // as Gmail does. Only a send, a draft write or a label change that reaches Gmail alters it, so
  // whatever a read shows beyond it is the simulation.
  function mailHarness(options: {
    searchQuery?: string;
    /** What a search matches. Defaults to everything. */
    matches?: (mail: FakeMail) => boolean;
  } = {}) {
    const mailbox: FakeMail[] = [];
    const drafts = new Map<string, FakeMail>();
    let lastId = 0;
    // Hex, as Gmail's own IDs are.
    const newId = (prefix: string) => `${prefix}${(++lastId).toString(16).padStart(3, "0")}`;
    const deliver = (mail: Partial<FakeMail> & {raw: string}): FakeMail => {
      const stored = {
        id: newId("a"),
        threadId: mail.threadId ?? newId("c"),
        labelIds: mail.labelIds ?? ["INBOX", "UNREAD"],
        internalDate: mail.internalDate ?? Date.now(),
        from: mail.from ?? SENDER,
        raw: mail.raw,
      };
      mailbox.push(stored);
      return stored;
    };
    /** A message from someone else, already in the mailbox when the test starts. */
    const receive = (spec: Partial<GmailOutboundSpec> = {}, mail: Partial<FakeMail> = {}) => {
      const from = spec.from ?? SENDER;
      return deliver({
        internalDate: mailbox.length + 1,
        from,
        ...mail,
        raw: buildEncodedEmail({
          from,
          to: [ME],
          cc: [],
          bcc: [],
          subject: "Quarterly report",
          text: "Source body",
          messageId: `<source-${mailbox.length + 1}@example.com>`,
          attachments: [],
          ...spec,
        }),
      });
    };
    /** A draft written in Gmail itself, which this binding has not seen. */
    const saveDraft = (spec: Partial<GmailOutboundSpec>) => {
      const mail = deliver({
        labelIds: ["DRAFT"],
        from: ME,
        internalDate: mailbox.length + 1,
        raw: buildEncodedEmail({
          from: ME, to: ["to@example.com"], cc: [], bcc: [], subject: "Imported", text: "Body",
          messageId: "<imported@example.com>", attachments: [], ...spec,
        }),
      });
      const id = newId("d");
      drafts.set(id, mail);
      return {id, mail};
    };
    const metadata = async (mail: FakeMail) => ({
      id: mail.id,
      threadId: mail.threadId,
      internalDate: String(mail.internalDate),
      labelIds: mail.labelIds,
      sizeEstimate: base64UrlDecodedByteLength(mail.raw),
      payload: {headers: await fakeMailHeaders(mail)},
    });
    // Enough of the MIME tree for a draft's headers and plain-text body to be read.
    const full = async (mail: FakeMail) => {
      const text = (await parseMimeMessage(mail.raw)).text ?? "";
      return {
        ...await metadata(mail),
        payload: {
          mimeType: "text/plain",
          headers: await fakeMailHeaders(mail),
          body: {size: text.length, data: base64Url(text)},
        },
      };
    };
    const listed = (url: URL) => {
      const labelIds = url.searchParams.getAll("labelIds");
      return mailbox.filter(mail => labelIds.every(id => mail.labelIds.includes(id)) &&
        (!url.searchParams.has("q") || (options.matches?.(mail) ?? true)));
    };
    const respond = async (url: URL, init: RequestInit): Promise<Response> => {
      const [collection, id] = url.pathname.replace("/gmail/v1/users/me/", "").split("/");
      const format = url.searchParams.get("format");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (collection === "labels" && !init.method) {
        return json({labels: ["INBOX", "UNREAD", "STARRED", "TRASH", "SENT", "DRAFT"]
          .map(systemLabel)});
      }
      if (collection === "messages" && id === "send" && init.method === "POST") {
        const sent = deliver(
          {raw: body.raw, threadId: body.threadId, labelIds: ["SENT"], from: ME});
        return json({id: sent.id, threadId: sent.threadId});
      }
      if (collection === "messages" && id === "batchModify" && init.method === "POST") {
        for (const mail of mailbox.filter(candidate => body.ids.includes(candidate.id))) {
          mail.labelIds = [
            ...mail.labelIds.filter(label =>
              !body.removeLabelIds.includes(label) && !body.addLabelIds.includes(label)),
            ...body.addLabelIds,
          ];
        }
        return new Response(null, {status: 204});
      }
      if (collection === "drafts" && id === undefined && init.method === "POST") {
        const mail = deliver({
          raw: body.message.raw, threadId: body.message.threadId, labelIds: ["DRAFT"], from: ME,
        });
        const draftId = newId("d");
        drafts.set(draftId, mail);
        return json({id: draftId, message: {id: mail.id, threadId: mail.threadId}});
      }
      if (collection === "drafts" && id === "send" && init.method === "POST") {
        const draft = drafts.get(body.id);
        if (!draft) return json({error: "no such draft"}, 404);
        // Gmail consumes the draft: its message is gone, and the sent one has an ID of its own.
        drafts.delete(body.id);
        mailbox.splice(mailbox.indexOf(draft), 1);
        const sent = deliver(
          {raw: body.message.raw, threadId: draft.threadId, labelIds: ["SENT"], from: ME});
        return json({id: sent.id, threadId: sent.threadId});
      }
      if (init.method) throw new Error(`Unexpected request: ${init.method} ${url}`);
      if (collection === "drafts" && id !== undefined) {
        const mail = drafts.get(id);
        if (!mail) return json({error: "no such draft"}, 404);
        return json({id, message: format === "full" ? await full(mail) : fakeMailRaw(mail)});
      }
      if (collection === "messages" && id === undefined) {
        return json({messages: listed(url).map(mail => ({id: mail.id, threadId: mail.threadId}))});
      }
      if (collection === "threads" && id === undefined) {
        return json({threads: [...new Set(listed(url).map(mail => mail.threadId))]
          .map(threadId => ({id: threadId}))});
      }
      const mail = mailbox.find(candidate => candidate.id === id);
      if (collection === "messages") {
        if (!mail) return json({error: "no such message"}, 404);
        return json(format === "raw" ? fakeMailRaw(mail) : await metadata(mail));
      }
      const thread = mailbox.filter(candidate => candidate.threadId === id);
      if (collection === "threads" && thread.length) {
        return json(format === "minimal"
          ? threadMinimal(id, thread.map(candidate => candidate.id))
          : {id, messages: await Promise.all(thread.map(metadata))});
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    return {...actionHarness(respond, options), mailbox, drafts, receive, saveDraft};
  }

  const attachment = {
    filename: "source.txt",
    contentType: "text/plain",
    data: btoa("source attachment"),
    disposition: "attachment" as const,
    description: "source attachment",
  };

  it("opens new mail as soon as it is sent", async () => {
    const {gatekeeper, mailbox, values} = mailHarness();
    const session = await gatekeeper.startSession(approvalQueue());

    const id = await session.send(["to@example.com"], "Hello", "Plain body", {
      cc: ["Carol <carol@example.com>"], bcc: ["hidden@example.com"], html: "<p>HTML body</p>",
    });
    const {submittedAt} = (await values.get<{submittedAt: number}>("pending:action:1"))!;
    const message = await session.getMessage(id);

    expect(await message.getMetadata()).toEqual({
      id,
      from: {address: ME},
      to: [{address: "to@example.com"}],
      cc: [{address: "carol@example.com", name: "Carol"}],
      bcc: [{address: "hidden@example.com"}],
      subject: "Hello",
      timestamp: new Date(submittedAt),
      labels: [systemLabel("SENT")],
    });
    const headers = await message.getHeaders();
    expect(headerNamed(headers, "Message-ID")).toBe(id);
    expect(headerNamed(headers, "To")).toContain("to@example.com");
    expect(headerNamed(headers, "Bcc")).toContain("hidden@example.com");
    const content = await message.getContent();
    expect(content.text?.trim()).toBe("Plain body");
    expect(content.html?.trim()).toBe("<p>HTML body</p>");
    expect(await message.attachments()).toEqual([]);
    // Gmail assigns new mail its thread only when it sends it.
    await expect(message.thread()).rejects.toThrow(/once this message has been delivered/);
    expect(mailbox).toEqual([]);
  });

  it("reads a pending reply back as it will be sent, dated when it was submitted", async () => {
    const {gatekeeper, receive, storage, values} = mailHarness();
    const source = receive({cc: ["carol@example.com"]});
    const sourceMessageId = (await parseMimeMessage(source.raw)).messageId;
    const session = await gatekeeper.startSession(approvalQueue());

    const id = await (await session.getMessage(source.id)).reply("Reply body");
    // Long past, so a `Date` stamped at the time of each read would show.
    const submittedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    storage.kv.put("pending:action:1", {...await values.get<object>("pending:action:1"), submittedAt});
    const message = await session.getMessage(id);

    expect(await message.getMetadata()).toEqual({
      id,
      threadId: source.threadId,
      from: {address: ME},
      to: [{address: SENDER}],
      cc: [],
      subject: "Re: Quarterly report",
      timestamp: new Date(submittedAt),
      labels: [systemLabel("SENT")],
    });
    const headers = await message.getHeaders();
    expect(headerNamed(headers, "Message-ID")).toBe(id);
    expect(headerNamed(headers, "In-Reply-To")).toBe(sourceMessageId);
    expect(headerNamed(headers, "References")).toContain(sourceMessageId);
    expect(new Date(headerNamed(headers, "Date")!)).toEqual(new Date(submittedAt));
    expect(headerNamed(await (await session.getMessage(id)).getHeaders(), "Date"))
      .toBe(headerNamed(headers, "Date"));
    expect((await message.getContent()).text?.trim()).toBe("Reply body");
    expect(await message.attachments()).toEqual([]);
  });

  it("reads a pending forward back with its quoted source and the source's attachments", async () => {
    const {gatekeeper, receive} = mailHarness();
    const source = receive({html: "<p>Source <strong>HTML</strong></p>", attachments: [attachment]});
    const session = await gatekeeper.startSession(approvalQueue());

    const id = await (await session.getMessage(source.id))
      .forward(["recipient@example.com"], "Intro");
    const message = await session.getMessage(id);

    const info = await message.getMetadata();
    expect(info).toMatchObject({
      id, to: [{address: "recipient@example.com"}], subject: "Fwd: Quarterly report",
      labels: [systemLabel("SENT")],
    });
    expect(info).not.toHaveProperty("threadId");
    const content = await message.getContent();
    expect(content.text).toContain("Intro");
    expect(content.text).toContain("---------- Forwarded message ---------");
    expect(content.text).toContain("Source body");
    expect(content.html).toContain("Source <strong>HTML</strong>");
    const attachments = await message.attachments();
    expect(attachments.map(entry => entry.info)).toEqual([{
      filename: "source.txt", mimeType: "text/plain", size: 17, disposition: "attachment",
      readable: true,
    }]);
    expect(decodeText(attachments[0].content)).toBe("source attachment");
    await expect(message.thread()).rejects.toThrow(/once this message has been delivered/);
  });

  it("reads back the send of an inline-forward draft Gmail does not have yet", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive({attachments: [attachment]});
    const session = await gatekeeper.startSession(approvalQueue());
    const draft = await (await session.getMessage(source.id))
      .createForwardDraft(["recipient@example.com"], "Intro");

    const id = await draft.send();
    const message = await session.getMessage(id);

    expect(await message.getMetadata()).toMatchObject({
      id, to: [{address: "recipient@example.com"}], subject: "Fwd: Quarterly report",
    });
    expect(headerNamed(await message.getHeaders(), "Message-ID")).toBe(id);
    const content = await message.getContent();
    expect(content.text).toContain("Intro");
    expect(content.text).toContain("Source body");
    const attachments = await message.attachments();
    expect(attachments.map(entry => entry.info.filename)).toEqual(["source.txt"]);
    expect(decodeText(attachments[0].content)).toBe("source attachment");
    expect(mailbox).toEqual([source]);
  });

  it("reads back the send of a draft written in Gmail, with the draft's attachments", async () => {
    const {gatekeeper, saveDraft, storage} = mailHarness();
    const imported = saveDraft({html: "<p>Body</p>", attachments: [attachment]});
    storage.kv.put(`gmail:draft:${imported.id}`, {
      logicalId: imported.id, providerId: imported.id, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());

    const id = await (await session.getDraft(imported.id)).send();
    const message = await session.getMessage(id);

    expect(await message.getMetadata()).toMatchObject({
      id, threadId: imported.mail.threadId, to: [{address: "to@example.com"}],
      subject: "Imported", labels: [systemLabel("SENT")],
    });
    // The send carries its own Message-ID, not the one the draft was written with.
    expect(headerNamed(await message.getHeaders(), "Message-ID")).toBe(id);
    const content = await message.getContent();
    expect(content.text?.trim()).toBe("Body");
    expect(content.html?.trim()).toBe("<p>Body</p>");
    const attachments = await message.attachments();
    expect(attachments.map(entry => entry.info.filename)).toEqual(["source.txt"]);
    expect(decodeText(attachments[0].content)).toBe("source attachment");
  });

  it("still describes a sent draft whose Gmail draft can no longer be read", async () => {
    const {drafts, gatekeeper, saveDraft, storage} = mailHarness();
    const imported = saveDraft({attachments: [attachment]});
    storage.kv.put(`gmail:draft:${imported.id}`, {
      logicalId: imported.id, providerId: imported.id, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const id = await (await session.getDraft(imported.id)).send();

    // As after a send whose outcome is unknown, where Gmail may have consumed the draft.
    drafts.delete(imported.id);

    const message = await session.getMessage(id);
    await expect(message.getMetadata()).resolves.toMatchObject({id, subject: "Imported"});
    // The email cannot be rebuilt without the draft's attachments.
    await expect(message.getHeaders()).rejects.toThrow(/drafts\.get failed/);
    await expect(message.getContent()).rejects.toThrow(/drafts\.get failed/);
    await expect(message.attachments()).rejects.toThrow(/drafts\.get failed/);
  });

  it("shows a pending reply in its thread", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive({cc: ["carol@example.com"]});
    const before = structuredClone(mailbox);
    const session = await gatekeeper.startSession(approvalQueue());

    const id = await (await session.getMessage(source.id)).reply("Reply body");
    const thread = await session.getThread(source.threadId);

    const summary = await thread.getMetadata();
    expect(summary).toMatchObject({
      id: source.threadId,
      subject: "Quarterly report",
      messageCount: 2,
      latestMessageId: id,
      participants: [{address: SENDER}, {address: ME}, {address: "carol@example.com"}],
      unread: true,
      labels: [systemLabel("INBOX"), systemLabel("UNREAD"), systemLabel("SENT")],
    });
    expect(summary.timestamp.getTime()).toBeGreaterThan(source.internalDate);
    expect(await (await session.listThreads()).next()).toMatchObject([
      {info: {id: source.threadId, messageCount: 2, latestMessageId: id}},
    ]);
    expect(await memberIds(thread.messages())).toEqual([source.id, id]);
    // The reply goes to the sender alone, so the Cc'd recipient of the original cannot see it.
    expect(await memberIds(thread.messagesVisibleTo(SENDER))).toEqual([source.id, id]);
    expect(await memberIds(thread.messagesVisibleTo("carol@example.com"))).toEqual([source.id]);
    // Mail waiting to be sent is not in any message list.
    expect(entryIds(await (await session.listMessages()).next())).toEqual([source.id]);
    expect(entryIds(await (await session.searchMessages("subject:report")).next()))
      .toEqual([source.id]);
    expect(mailbox).toEqual(before);
  });

  it("shows a sent draft in its thread in place of the draft's message", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive();
    const session = await gatekeeper.startSession(approvalQueue());
    const threadIds = async () => memberIds((await session.getThread(source.threadId)).messages());
    const draft = await (await session.getMessage(source.id)).createReplyDraft("Reply body");
    await gatekeeper.applyAction(1);
    const draftMessage = mailbox[1];
    // Gmail lists a draft in its thread.
    expect(await threadIds()).toEqual([source.id, draftMessage.id]);

    const id = await draft.send();

    expect(await threadIds()).toEqual([source.id, id]);
    await expect((await session.getThread(source.threadId)).getMetadata()).resolves.toMatchObject({
      messageCount: 2, latestMessageId: id,
      labels: [systemLabel("INBOX"), systemLabel("UNREAD"), systemLabel("SENT")],
    });
    await expect((await session.getMessage(id)).getMetadata())
      .resolves.toMatchObject({id, threadId: source.threadId});
    // The draft's message is gone from search results too.
    expect(entryIds(await (await session.searchMessages("subject:report")).next()))
      .toEqual([source.id]);
    expect(mailbox).toEqual([source, draftMessage]);

    await gatekeeper.applyAction(2);
    expect(mailbox.map(mail => mail.labelIds)).toEqual([["INBOX", "UNREAD"], ["SENT"]]);
    expect(await threadIds()).toEqual([source.id, mailbox[1].id]);
  });

  it("keeps the draft's message hidden when its creation is approved after it was sent", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive();
    const session = await gatekeeper.startSession(approvalQueue());
    const threadIds = async () => memberIds((await session.getThread(source.threadId)).messages());
    const draft = await (await session.getMessage(source.id)).createReplyDraft("Reply body");
    const id = await draft.send();
    expect(await threadIds()).toEqual([source.id, id]);

    // Only now does Gmail have the draft, under a message ID the send never saw.
    await gatekeeper.applyAction(1);

    expect(mailbox.map(mail => mail.labelIds)).toEqual([["INBOX", "UNREAD"], ["DRAFT"]]);
    expect(await threadIds()).toEqual([source.id, id]);
    await expect((await session.getThread(source.threadId)).getMetadata())
      .resolves.toMatchObject({messageCount: 2, latestMessageId: id});
    expect(entryIds(await (await session.searchMessages("subject:report")).next()))
      .toEqual([source.id]);
    expect((await (await session.getMessage(id)).getContent()).text?.trim()).toBe("Reply body");
  });

  it("leaves a draft that is being deleted out of its thread", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive();
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const thread = await session.getThread(source.threadId);
    const draft = await (await session.getMessage(source.id)).createReplyDraft("Reply body");
    await gatekeeper.applyAction(1);
    expect(await memberIds(thread.messages())).toEqual([source.id, mailbox[1].id]);

    await draft.delete();

    expect(await memberIds(thread.messages())).toEqual([source.id]);
    await expect(thread.getMetadata()).resolves.toMatchObject({
      messageCount: 1, latestMessageId: source.id,
      labels: [systemLabel("INBOX"), systemLabel("UNREAD")],
    });
    await thread.mutate("archive");
    expect(await mutationTargets(queue)).toEqual([[source.id]]);
  });

  it("drops a thread from a search that only its outgoing draft still matched", async () => {
    const {gatekeeper, receive} = mailHarness();
    const source = receive();
    const session = await gatekeeper.startSession(approvalQueue());
    const read = async () => entryIds(await (await session.searchThreads("is:read")).next());
    const draft = await (await session.getMessage(source.id)).createReplyDraft("Reply body");
    await gatekeeper.applyAction(1);
    // The incoming message is unread, so the thread matches through its draft alone.
    expect(await read()).toEqual([source.threadId]);

    await draft.delete();

    expect(await read()).toBeNull();
    expect(entryIds(await (await session.searchThreads("is:unread")).next()))
      .toEqual([source.threadId]);
  });

  it("drops a thread whose only message is a draft that is being sent", async () => {
    const {gatekeeper, saveDraft, storage} = mailHarness();
    const imported = saveDraft({});
    imported.mail.labelIds = ["DRAFT", "STARRED"];
    storage.kv.put(`gmail:draft:${imported.id}`, {
      logicalId: imported.id, providerId: imported.id, createdAt: 1, status: "active", version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const starred = async () => entryIds(await (await session.searchThreads("is:starred")).next());
    expect(await starred()).toEqual([imported.mail.threadId]);

    const id = await (await session.getDraft(imported.id)).send();

    // Nothing Gmail matched is left in the thread, and the message waiting to be sent is not
    // starred. It is still there to open, in the thread the draft had.
    expect(await starred()).toBeNull();
    expect(await (await session.searchThreads("subject:Imported")).next()).toBeNull();
    await expect((await session.getThread(imported.mail.threadId)).getMetadata())
      .resolves.toMatchObject({messageCount: 1, latestMessageId: id, labels: [systemLabel("SENT")]});
  });

  it("archives through a pending reply the earlier replies delivered since", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive();
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const message = await session.getMessage(source.id);
    const first = await message.reply("First reply");
    const second = await message.reply("Second reply");
    const thread = await session.getThread(source.threadId);
    expect(await memberIds(thread.messages())).toEqual([source.id, first, second]);
    const {latestMessageId} = await thread.getMetadata();
    expect(latestMessageId).toBe(second);

    // Gmail dates the first reply at its approval, after the second was submitted. The caller
    // saw it ahead of the second all the same.
    await gatekeeper.applyAction(1);
    mailbox[1].internalDate = Date.now() + 60_000;
    await thread.mutate("archive", latestMessageId);
    expect(await mutationTargets(queue)).toEqual([[source.id, mailbox[1].id]]);

    await gatekeeper.applyAction(2);
    await thread.mutate("archive", latestMessageId);
    expect((await mutationTargets(queue))[1]).toEqual([source.id, mailbox[1].id, mailbox[2].id]);
  });

  it("archives a thread through a pending reply, and means the same after it is sent", async () => {
    const {calls, gatekeeper, mailbox, receive, storage, values} = mailHarness();
    const source = receive();
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const id = await (await session.getMessage(source.id)).reply("Reply body");
    const thread = await session.getThread(source.threadId);
    const {latestMessageId} = await thread.getMetadata();
    expect(latestMessageId).toBe(id);
    // Arrives once the caller has seen the thread, and so before the reply is approved.
    const late = receive({}, {threadId: source.threadId, internalDate: Date.now() + 60_000});

    await thread.mutate("archive", latestMessageId);
    expect(await mutationTargets(queue)).toEqual([[source.id]]);

    await gatekeeper.applyAction(1);
    const delivered = mailbox[2];
    expect(delivered.labelIds).toEqual(["SENT"]);
    // Gmail files the reply after the late arrival, but the caller still never saw that one.
    await thread.mutate("archive", latestMessageId);
    expect((await mutationTargets(queue))[1]).toEqual([source.id, delivered.id]);

    await gatekeeper.applyAction(3);
    expect(late.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(calls.filter(call => call.url.pathname === batchModifyPath)).toHaveLength(1);

    // A send completed before sends recorded when they were submitted stops at Gmail's copy.
    const receiptKey = `gmail:sentAlias:${id.slice(1, -1)}`;
    const {submittedAt, ...receipt} = (await values.get<{submittedAt: number}>(receiptKey))!;
    expect(submittedAt).toBeLessThan(late.internalDate);
    storage.kv.put(receiptKey, receipt);
    await thread.mutate("archive", latestMessageId);
    expect((await mutationTargets(queue))[2]).toEqual([source.id, late.id, delivered.id]);
  });

  it("refuses a thread mutation through a reply that was rejected", async () => {
    const {gatekeeper, receive} = mailHarness();
    const source = receive();
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const id = await (await session.getMessage(source.id)).reply("Reply body");
    const thread = await session.getThread(source.threadId);

    await gatekeeper.rejectAction(1);

    await expect(thread.mutate("archive", id)).rejects.toThrow(/lastMessageId is not a message/);
    await expect(thread.mutate("archive", "<unknown@gadgets.invalid>"))
      .rejects.toThrow(/lastMessageId is not a message/);
    expect((await queue.read!()).submissions).toHaveLength(1);
    await expect(thread.getMetadata())
      .resolves.toMatchObject({messageCount: 1, latestMessageId: source.id});
  });

  it("leaves a draft that is being sent out of a thread mutation", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive();
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const draft = await (await session.getMessage(source.id)).createReplyDraft("Reply body");
    await gatekeeper.applyAction(1);
    await draft.send();
    const thread = await session.getThread(source.threadId);

    await thread.mutate("archive", (await thread.getMetadata()).latestMessageId);
    await thread.mutate("markRead");

    // Gmail no longer has the draft's message once the send is applied.
    expect(await mutationTargets(queue)).toEqual([[source.id], [source.id]]);
    await gatekeeper.applyAction(2);
    await gatekeeper.applyAction(3);
    await gatekeeper.applyAction(4);
    expect(mailbox.map(mail => mail.labelIds)).toEqual([[], ["SENT"]]);
  });

  it("becomes Gmail's copy on the same capability once the send is applied", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness();
    const source = receive();
    const session = await gatekeeper.startSession(approvalQueue());
    const id = await (await session.getMessage(source.id)).reply("Reply body");

    const {before, after} = await (await session.getMessage(id)).readAcrossDecision(1, "apply");

    expect(before).toMatchObject({id, threadId: source.threadId});
    expect(after).toMatchObject({
      id: mailbox[1].id, threadId: source.threadId, subject: "Re: Quarterly report",
      labels: [systemLabel("SENT")],
    });
    // Delivered, it can be changed like any other message, under either ID.
    await (await session.getMessage(id)).mutate("star");
    await gatekeeper.applyAction(2);
    expect(mailbox[1].labelIds).toEqual(["SENT", "STARRED"]);
  });

  it("reports that the message was not sent once the send is rejected", async () => {
    const {gatekeeper, receive} = mailHarness();
    const source = receive();
    const session = await gatekeeper.startSession(approvalQueue());
    const id = await (await session.getMessage(source.id)).reply("Reply body");

    const {before, error} = await (await session.getMessage(id)).readAcrossDecision(1, "reject");

    expect(before).toMatchObject({id});
    expect(error).toMatch(/This message was not sent/);
    await expect(session.getMessage(id)).rejects.toThrow(/Unknown Gmail message ID/);
    await expect((await session.getThread(source.threadId)).getMetadata())
      .resolves.toMatchObject({messageCount: 1, latestMessageId: source.id});
  });

  it("refuses to change, answer or forward a message that has not been delivered", async () => {
    const {gatekeeper, receive} = mailHarness();
    const source = receive();
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const id = await (await session.getMessage(source.id)).reply("Reply body");
    const message = await session.getMessage(id);
    const notDelivered = /\(\) is available once this message has been delivered/;

    for (const operation of ["archive", "trash", "markRead", "markUnread", "star", "unstar"]) {
      await expect(message.mutate(operation)).rejects.toThrow(notDelivered);
    }
    await expect(message.applyLabel(systemLabel("INBOX"))).rejects.toThrow(notDelivered);
    await expect(message.removeLabel(systemLabel("IMPORTANT"))).rejects.toThrow(notDelivered);
    await expect(message.reply("Again")).rejects.toThrow(notDelivered);
    await expect(message.replyAll("Again")).rejects.toThrow(notDelivered);
    await expect(message.forward(["to@example.com"])).rejects.toThrow(notDelivered);
    await expect(message.createReplyDraft("Again")).rejects.toThrow(notDelivered);
    await expect(message.createForwardDraft(["to@example.com"])).rejects.toThrow(notDelivered);
    expect((await queue.read!()).submissions).toHaveLength(1);
  });

  it("shows a restricted binding its pending reply only in the thread opened from it", async () => {
    const {gatekeeper, mailbox, receive} = mailHarness({
      searchQuery: `from:${SENDER}`, matches: mail => mail.from === SENDER,
    });
    const source = receive();
    receive({from: "other@example.com"}, {threadId: source.threadId});
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const id = await (await session.getMessage(source.id)).reply("Reply body");

    // The binding's own view of the thread holds what its search matches, as it will once the
    // reply is delivered: the reply is from the mailbox owner, which the search does not match.
    const thread = await session.getThread(source.threadId);
    await expect(thread.getMetadata())
      .resolves.toMatchObject({messageCount: 1, latestMessageId: source.id});
    expect(await memberIds(thread.messages())).toEqual([source.id]);
    expect(await (await session.listThreads()).next()).toMatchObject([
      {info: {id: source.threadId, messageCount: 1, latestMessageId: source.id}},
    ]);

    const reply = await session.getMessage(id);
    await expect(reply.getMetadata()).resolves.toMatchObject({id, threadId: source.threadId});
    await expect((await reply.thread()).getMetadata())
      .resolves.toMatchObject({messageCount: 2, latestMessageId: id});
    // Never the sibling the search does not match.
    expect(infoIds(await reply.threadMessages())).toEqual([source.id, id]);
    await reply.threadArchive(id);
    expect(await mutationTargets(queue)).toEqual([[source.id]]);

    await gatekeeper.applyAction(1);
    const delivered = mailbox[2];
    expect(infoIds(await (await session.getMessage(id)).threadMessages()))
      .toEqual([source.id, delivered.id]);
  });

  it("opens a restricted binding's pending reply after its source stopped matching", async () => {
    let matching = true;
    const {gatekeeper, receive} = mailHarness({
      searchQuery: "is:unread", matches: () => matching,
    });
    const source = receive();
    const session = await gatekeeper.startSession(approvalQueue());
    const id = await (await session.getMessage(source.id)).reply("Reply body");

    matching = false;

    const reply = await session.getMessage(id);
    await expect((await reply.thread()).getMetadata())
      .resolves.toMatchObject({messageCount: 1, latestMessageId: id, unread: false});
    expect(infoIds(await reply.threadMessages())).toEqual([id]);
    await expect(reply.threadArchive(id)).rejects.toThrow(/until that message has been delivered/);
    await expect(session.getThread(source.threadId)).rejects.toThrow(/not available/);
  });
});

describe("Gmail label action reconciliation", () => {
  it("rebases concurrent label renames onto the preceding pending rename", async () => {
    let currentName = "Before";
    let initialReads = 0;
    let releaseInitialReads!: () => void;
    const initialReadsReady = new Promise<void>(resolve => { releaseInitialReads = resolve; });
    const {gatekeeper, values} = actionHarness(async (url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        initialReads++;
        if (initialReads === 2) releaseInitialReads();
        if (initialReads <= 2) await initialReadsReady;
        return json({labels: [{id: "Label_1", name: currentName, type: "user"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/labels/Label_1" && !init.method) {
        return json({id: "Label_1", name: currentName, type: "user"});
      }
      if (url.pathname === "/gmail/v1/users/me/labels/Label_1" && init.method === "PATCH") {
        currentName = (JSON.parse(String(init.body)) as {name: string}).name;
        return json({id: "Label_1", name: currentName, type: "user"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const firstQueue = approvalQueue();
    const secondQueue = approvalQueue();
    const firstSession = await gatekeeper.startSession(firstQueue);
    const secondSession = await gatekeeper.startSession(secondQueue);
    const label = {id: "Label_1", name: "Before", type: "custom"} as const;

    await Promise.all([
      firstSession.renameLabel(label, "First"),
      secondSession.renameLabel(label, "Second"),
    ]);

    const first = await values.get<{name: string}>("pending:action:1");
    const second = await values.get<{
      name: string; expectedName: string; dependsOn: number[];
    }>("pending:action:2");
    expect(second).toMatchObject({expectedName: first?.name, dependsOn: [1]});
    const submissions = [
      ...(await firstQueue.read!()).submissions,
      ...(await secondQueue.read!()).submissions,
    ];
    const descriptions = new Map(submissions.map(submission => [
      submission.actionId,
      submission.description as ActionDescription,
    ]));
    expect(descriptions.get(1)?.title).toBe("Rename Gmail label: Before");
    expect(descriptions.get(2)?.title).toBe(`Rename Gmail label: ${first?.name}`);
    expect(JSON.stringify(descriptions.get(2)?.fields)).toContain(first?.name);

    await gatekeeper.applyAction(1);
    await gatekeeper.applyAction(2);

    expect(currentName).toBe(second?.name);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("pending:action:2")).toBe(false);
  });

  it("reconciles an accepted label create with a malformed response by exact name", async () => {
    let created = false;
    let creates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && init.method === "POST") {
        creates++;
        created = true;
        return json({});
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({
          labels: created ? [{id: "Label_1", name: "Review", type: "user"}] : [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const resource = {logicalId: "provisional-label", name: "Review", status: "active"};
    storage.kv.put("gmail:label:provisional-label", resource);
    storage.kv.put("pending:action:1", {type: "labelCreate", label: resource});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/valid label ID/);
    await gatekeeper.applyAction(1);

    expect(creates).toBe(1);
    expect(await values.get("gmail:label:provisional-label")).toMatchObject({
      providerId: "Label_1", name: "Review", status: "active",
    });
    expect(await values.has("pending:action:1")).toBe(false);
  });

  it("reconciles an accepted label rename by stable ID without another PATCH", async () => {
    let currentName = "Before";
    let renames = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels/Label_1" && !init.method) {
        return json({id: "Label_1", name: currentName, type: "user"});
      }
      if (url.pathname === "/gmail/v1/users/me/labels/Label_1" && init.method === "PATCH") {
        renames++;
        currentName = "After";
        return new Response("not-json", {headers: {"Content-Type": "application/json"}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("gmail:label:stable-label", {
      logicalId: "stable-label",
      providerId: "Label_1",
      name: "Before",
      status: "active",
    });
    storage.kv.put("pending:action:1", {
      type: "labelRename",
      labelId: "stable-label",
      name: "After",
      expectedName: "Before",
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/invalid JSON/);
    await gatekeeper.applyAction(1);

    expect(renames).toBe(1);
    expect(await values.get("gmail:label:stable-label")).toMatchObject({name: "After"});
    expect(await values.has("pending:action:1")).toBe(false);
  });
});

describe("Gmail draft dependency reconciliation", () => {
  it("emits a logical draft only once when Gmail repeats it across provider pages", async () => {
    const logicalId = "stable-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      providerId,
      messageId: "provider-message",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<stable-draft@example.com>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const pageTokens: Array<string | null> = [];
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        const pageToken = url.searchParams.get("pageToken");
        pageTokens.push(pageToken);
        return json({
          drafts: [{id: providerId, message: {id: state.messageId}}],
          ...(pageToken ? {} : {nextPageToken: "page-2"}),
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json(draftFull(providerId, state.messageId!, state.threadId!, state));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, providerId, createdAt: 1, status: "active", version: 0,
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    const pages = await session.listDraftPages();

    expect(pages.map(page => page.map(entry => entry.id))).toEqual([[logicalId]]);
    expect(pageTokens).toEqual([null, "page-2"]);
    const pageObservations = (await queue.read!()).observations.filter(observation =>
      typeof observation === "object" && observation !== null && "title" in observation &&
      /^Read \d+ Gmail drafts$/.test(String(observation.title)));
    expect(pageObservations).toEqual([
      {title: "Read 1 Gmail drafts", description: expect.any(String)},
      {title: "Read 0 Gmail drafts", description: expect.any(String)},
    ]);
  });

  it("proactively merges an uncertain listed draft and keeps the provider draft after rejection", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const messageId = "provider-message";
    const threadId = "provider-thread";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<proactive-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId),
      subject: state.subject,
      text: state.text,
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: messageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json({
          id: messageId,
          threadId,
          internalDate: "1",
          payload: {headers: [{name: "Message-ID", value: state.rfcMessageId}]},
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, messageId, threadId, state))
          : json({
              id: providerId,
              message: {id: messageId, threadId, internalDate: "1", raw},
            });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("gmail:applying:1", Date.now());
    const session = await gatekeeper.startSession(approvalQueue());

    const reconciled = await (await session.listDrafts()).next();

    expect(reconciled).toHaveLength(1);
    expect(reconciled![0].info).toMatchObject({id: logicalId, messageId, threadId});
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({providerId, status: "active"});

    await gatekeeper.rejectAction(1);
    const retained = await (await session.listDrafts()).next();
    expect(retained).toHaveLength(1);
    expect(retained![0].info.id).toBe(logicalId);
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({providerId, status: "active"});
  });

  it("proactively reconciles an uncertain inline-forward draft", async () => {
    const logicalId = "provisional-forward-draft";
    const providerId = "provider-draft";
    let providerMessageId = "provider-message";
    const threadId = "provider-thread";
    const source = new TextEncoder().encode([
      "From: source@example.com",
      "To: me@example.com",
      "Subject: Source",
      "Message-ID: <source@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Source body",
    ].join("\r\n"));
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Fwd: Source",
      text: "Intro",
      rfcMessageId: "<inline-forward@gadgets.invalid>",
      timestamp: 1,
      source: {kind: "forward", messageId: "source-message", format: "inline"},
      attachments: [],
      version: 0,
    };
    const api = new GmailApi("me@example.com", async () => "token");
    const providerRaw = (await api.buildForwardFromBytes(
      source, state.to, state.text, {}, state.rfcMessageId, state.subject, state.date)).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: providerMessageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${providerMessageId}` && !init.method) {
        return json({
          id: providerMessageId,
          threadId,
          internalDate: "1",
          payload: {headers: [{name: "Message-ID", value: state.rfcMessageId}]},
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, providerMessageId, threadId, state))
          : json({
              id: providerId,
              message: {id: providerMessageId, threadId, internalDate: "1", raw: providerRaw},
            });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await captureForwardSnapshot(storage, source);
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, source: state.source, forwardSnapshot: snapshot, createdAt: 1,
      status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state, sourceAttachment: {
      ...snapshot, messageId: "source-message", description: "Inline source",
    }});
    storage.kv.put("gmail:applying:1", Date.now());

    const session = await gatekeeper.startSession(approvalQueue());
    const entries = await (await session.listDrafts()).next();

    expect(entries).toHaveLength(1);
    expect(entries![0].info).toMatchObject({id: logicalId, messageId: providerMessageId});
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({providerId});
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId,
      messageId: providerMessageId,
      threadId,
    });

    providerMessageId = "provider-message-2";
    await gatekeeper.applyAction(1);

    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
  });

  it("rebases each dependent action onto Gmail's normalized provider revision", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const rfcMessageId = "<normalized-draft@gadgets.invalid>";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Original",
      rfcMessageId,
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {...state, text: "Approved update", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    let providerMessageId = "provider-message-1";
    let providerRaw = api.buildOutbound({
      ...outboundSpec(rfcMessageId),
      subject: state.subject,
      text: state.text + "\n",
    }).raw;
    let creates = 0;
    let updates = 0;
    let deletes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        return json({id: providerId, message: {id: providerMessageId}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: providerMessageId,
            threadId: "provider-thread",
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        providerMessageId = "provider-message-2";
        providerRaw = api.buildOutbound({
          ...outboundSpec(rfcMessageId),
          subject: after.subject,
          text: after.text + "\n",
        }).raw;
        return json({id: providerId, message: {id: providerMessageId}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const expectedBefore = await gmailDraftStateFingerprint(state);
    const expectedAfter = await gmailDraftStateFingerprint(after);
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore,
      dependsOn: [1],
    });
    storage.kv.put("pending:action:3", {
      type: "draftDelete",
      draftId: logicalId,
      expectedSnapshot: expectedAfter,
      dependsOn: [1, 2],
    });

    await gatekeeper.applyAction(1);

    expect(await values.get("pending:action:2")).toMatchObject({
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [1],
    });
    expect((await values.get<{expectedBefore: string}>("pending:action:2"))!.expectedBefore)
      .not.toBe(expectedBefore);
    expect(await values.get("pending:action:3")).toMatchObject({
      expectedSnapshot: expectedAfter,
      dependsOn: [1, 2],
    });
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);

    await gatekeeper.applyAction(2);

    expect(await values.get("pending:action:3")).toMatchObject({
      expectedProviderMessageId: "provider-message-2",
      dependsOn: [1, 2],
    });
    expect((await values.get<{expectedSnapshot: string}>("pending:action:3"))!.expectedSnapshot)
      .not.toBe(expectedAfter);

    await gatekeeper.applyAction(3);

    expect({creates, updates, deletes}).toEqual({creates: 1, updates: 1, deletes: 1});
    expect(await values.has("pending:action:2")).toBe(false);
    expect(await values.has("pending:action:3")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:2")).toBe(false);
  });

  it("retries provider-baseline capture from a durable create receipt without another write", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<receipt-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text + "\n",
    }).raw;
    let creates = 0;
    let readable = false;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        return json({id: providerId, message: {id: "provider-message"}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return readable
          ? json({
              id: providerId,
              message: {
                id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
              },
            })
          : json({error: "temporarily unavailable"}, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message",
    });
    readable = true;

    await gatekeeper.applyAction(1);

    expect(creates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
  });

  it("retries provider-baseline capture from an update receipt without another write", async () => {
    const providerId = "provider-draft";
    const before: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Before",
      rfcMessageId: "<update-receipt@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {...before, text: "After", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    const beforeRaw = api.buildOutbound({
      ...outboundSpec(before.rfcMessageId), subject: before.subject, text: before.text,
    }).raw;
    const normalizedAfterRaw = api.buildOutbound({
      ...outboundSpec(after.rfcMessageId), subject: after.subject, text: after.text,
    }).raw;
    const differentAfterRaw = api.buildOutbound({
      ...outboundSpec(after.rfcMessageId), subject: after.subject, text: "Different\n",
    }).raw;
    let providerMessageId = "provider-message-1";
    let providerThreadId = "provider-thread";
    let baselineMode: "unavailable" | "different" | "changed" | "changedThread" = "unavailable";
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (providerMessageId === "provider-message-1") {
          return json({
            id: providerId,
            message: {
              id: providerMessageId,
              threadId: providerThreadId,
              internalDate: "1",
              raw: beforeRaw,
            },
          });
        }
        if (baselineMode === "unavailable") return json({error: "unavailable"}, 400);
        return json({
          id: providerId,
          message: {
            id: "provider-message-3",
            threadId: providerThreadId,
            internalDate: "1",
            raw: baselineMode === "different" ? differentAfterRaw : normalizedAfterRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        providerMessageId = "provider-message-2";
        return json({id: providerId, message: {id: providerMessageId}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 2,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });
    storage.kv.put("pending:action:2", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: await gmailDraftStateFingerprint(after),
      expectedProviderMessageId: "provider-message-2",
      dependsOn: [1],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message-2", threadId: "provider-thread",
    });

    baselineMode = "different";
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    expect(updates).toBe(1);

    baselineMode = "changedThread";
    providerThreadId = "different-thread";
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    expect(updates).toBe(1);

    baselineMode = "changed";
    providerThreadId = "provider-thread";
    await gatekeeper.applyAction(1);

    expect(updates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(await values.get("pending:action:2")).toMatchObject({
      expectedProviderMessageId: "provider-message-3",
      dependsOn: [1],
    });
  });

  it("invalidates an update prepared while an earlier draft write completes", async () => {
    const providerId = "provider-draft";
    const before: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Before",
      rfcMessageId: "<authorization-race@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const firstUpdate: GmailDraftState = {...before, text: "First update", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    const beforeRaw = api.buildOutbound({
      ...outboundSpec(before.rfcMessageId), subject: before.subject, text: before.text,
    }).raw;
    const firstUpdateRaw = api.buildOutbound({
      ...outboundSpec(firstUpdate.rfcMessageId),
      subject: firstUpdate.subject,
      text: firstUpdate.text,
    }).raw;
    let providerMessageId = before.messageId!;
    let updates = 0;
    // Holds the update's own draft read open while the earlier write applies. Flags rather than
    // promises, because workerd refuses to resume a promise resolved by another Durable Object.
    const pause = {armed: false, reached: false, released: false};
    const {gatekeeper, storage, values} = actionHarness(async (url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (pause.armed) {
          pause.armed = false;
          pause.reached = true;
          await until(() => pause.released);
        }
        return json({
          id: providerId,
          message: {
            id: providerMessageId,
            threadId: before.threadId,
            internalDate: "1",
            raw: providerMessageId === before.messageId ? beforeRaw : firstUpdateRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        providerMessageId = "provider-message-2";
        return json({id: providerId, message: {id: providerMessageId}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after: firstUpdate,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: before.messageId,
      dependsOn: [],
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);
    const draft = await session.getDraft(providerId);
    pause.armed = true;

    const updateExpectation = expect(draft.update({text: "Second update"}))
      .rejects.toThrow(/changed identity while it was being read/);
    await until(() => pause.reached);
    await gatekeeper.applyAction(1);
    pause.released = true;
    await updateExpectation;

    expect(updates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("pending:action:2")).toBe(false);
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({version: 2});
  });

  it("completes an already-matching update without creating a write receipt", async () => {
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Already current",
      rfcMessageId: "<noop-update@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after = {...state, version: 1};
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      if (init.method === "PUT") updates++;
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: "provider-message",
      dependsOn: [],
    });

    await gatekeeper.applyAction(1);

    expect(updates).toBe(0);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
  });

  it("marks an update draft deleted when receipt reconciliation finds a provider 404", async () => {
    const providerId = "provider-draft";
    const before: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Before",
      rfcMessageId: "<discard-update@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after = {...before, text: "After", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    const beforeRaw = api.buildOutbound({
      ...outboundSpec(before.rfcMessageId), subject: before.subject, text: before.text,
    }).raw;
    let wrote = false;
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return wrote
          ? json({error: "missing"}, 404)
          : json({
              id: providerId,
              message: {
                id: "provider-message-1", threadId: "provider-thread", internalDate: "1", raw: beforeRaw,
              },
            });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        wrote = true;
        return json({id: providerId, message: {id: "provider-message-2"}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(true);

    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/uncertain provider outcome/);
    const session = await gatekeeper.startSession(approvalQueue());
    await expect(session.getDraft(providerId)).rejects.toThrow(/has been deleted/);
    await gatekeeper.applyAction(1);

    expect(updates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "deleted"});
  });

  it("refuses to bless a different provider revision after draft creation", async () => {
    const logicalId = "provisional-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<edited-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: "Externally edited",
    }).raw;
    let creates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        return json({id: "provider-draft", message: {id: "provider-message-1"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: "provider-message-2", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);

    expect(creates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(true);
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: "provider-draft", messageId: "provider-message-1",
    });

    await gatekeeper.rejectAction(1);

    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({
      logicalId, providerId: "provider-draft", status: "active",
    });
  });

  it("marks a created draft deleted when receipt reconciliation finds a provider 404", async () => {
    const logicalId = "provisional-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<deleted-create@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        return json({id: "provider-draft", message: {id: "provider-message"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({error: "missing"}, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/http=404/);
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: "provider-draft", messageId: "provider-message", missing: true,
    });

    await gatekeeper.rejectAction(1);

    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({status: "deleted"});
  });

  it("rolls back provider mapping when dependent rebasing validation fails", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<rollback-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {...state, text: "After", version: 1};
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text + "\n",
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        return json({id: providerId, message: {id: "provider-message"}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore: "not-the-create-output",
      dependsOn: [1],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/no longer matches/);

    expect(await values.get(`gmail:draft:${logicalId}`)).toEqual({
      logicalId, createdAt: 1, status: "active", version: 1,
    });
    expect(await values.has(`gmail:draft:${providerId}`)).toBe(false);
    expect(await values.has("gmail:draftAlias:provider-draft")).toBe(false);
    expect(await values.get("pending:action:1")).toEqual({type: "draftCreate", draft: state});
    expect(await values.get("pending:action:2")).toEqual({
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore: "not-the-create-output",
      dependsOn: [1],
    });
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message",
    });
    expect(await values.has("gmail:decision:1")).toBe(false);
  });

  it("skips descendants invalidated by a rejected intermediate draft action", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Created",
      rfcMessageId: "<rejected-middle@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const firstUpdate = {...state, text: "First update", version: 1};
    const secondUpdate = {...state, text: "Second update", version: 2};
    const expectedSecondBase = await gmailDraftStateFingerprint(firstUpdate);
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        return json({id: providerId, message: {id: "provider-message"}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 2,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: logicalId,
      after: firstUpdate,
      expectedBefore: await gmailDraftStateFingerprint(state),
      dependsOn: [1],
    });
    storage.kv.put("pending:action:3", {
      type: "draftUpdate",
      draftId: logicalId,
      after: secondUpdate,
      expectedBefore: expectedSecondBase,
      dependsOn: [1, 2],
    });

    await gatekeeper.rejectAction(2);
    await gatekeeper.applyAction(1);

    expect(await values.get("pending:action:3")).toMatchObject({
      expectedBefore: expectedSecondBase,
      dependsOn: [1, 2],
    });
    await expect(gatekeeper.applyAction(3)).rejects.toThrow(/prerequisite was rejected/i);
  });

  it("merges a discovered provider alias and applies create, update, and delete in order", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const rfcMessageId = "<draft@gadgets.invalid>";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Original",
      rfcMessageId,
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {
      ...state,
      logicalId: providerId,
      text: "Approved update",
      version: 1,
    };
    const expectedBefore = await gmailDraftStateFingerprint(state);
    const expectedAfter = await gmailDraftStateFingerprint(after);
    let providerMessageId = "provider-message-1";
    let providerRaw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(rfcMessageId),
      from: state.from,
      to: state.to,
      subject: state.subject,
      text: state.text,
    }).raw;
    const writes: string[] = [];
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: providerMessageId, threadId: "provider-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: providerMessageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: providerMessageId,
            threadId: "provider-thread",
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        writes.push("update");
        providerRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        providerMessageId = "provider-message-2";
        return json({id: providerId, message: {id: providerMessageId}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        writes.push("delete");
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 2,
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore,
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });
    storage.kv.put("pending:action:3", {
      type: "draftDelete",
      draftId: logicalId,
      expectedSnapshot: expectedAfter,
      dependsOn: [1],
    });
    storage.kv.put("gmail:applying:1", Date.now());

    await expect(gatekeeper.applyAction(2)).rejects.toThrow(/pending prerequisite/);
    expect(writes).toEqual([]);
    expect(await values.get("gmail:draftAlias:provider-draft")).toBe(logicalId);
    expect(await values.get("pending:action:2")).toMatchObject({draftId: logicalId, dependsOn: [1]});
    expect(await values.get("pending:action:3")).toMatchObject({dependsOn: [1, 2]});

    await gatekeeper.applyAction(1);
    expect((await values.keys()).filter(key => key.startsWith("gmail:draft:"))).toEqual([
      `gmail:draft:${logicalId}`,
    ]);
    expect(await values.get("gmail:draftAlias:provider-draft")).toBe(logicalId);
    expect(await values.get("pending:action:2")).toMatchObject({draftId: logicalId, dependsOn: [1]});
    expect(await values.get("pending:action:3")).toMatchObject({dependsOn: [1, 2]});

    await gatekeeper.applyAction(2);
    const approvedUpdate = await parseMimeMessage(providerRaw);
    expect(approvedUpdate.text).toContain("Approved update");
    expect(approvedUpdate.to?.[0]).toMatchObject({address: "to@example.com"});

    await gatekeeper.applyAction(3);
    expect(writes).toEqual(["update", "delete"]);
    expect(await values.get(`gmail:draft:${logicalId}`)).toMatchObject({status: "deleted"});
    expect(await values.has("pending:action:2")).toBe(false);
    expect(await values.has("pending:action:3")).toBe(false);
  });

  it("allows rejection when a retry finds an externally changed draft", async () => {
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<ambiguous-delete@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const api = new GmailApi("me@example.com", async () => "token");
    const originalRaw = api.buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    const changedRaw = api.buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: "Externally changed",
    }).raw;
    let changed = false;
    let deletes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: changed ? "provider-message-2" : state.messageId,
            threadId: state.threadId,
            internalDate: "1",
            raw: changed ? changedRaw : originalRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return json({error: "failed"}, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: state.messageId,
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.delete failed/);
    expect(await values.has("gmail:applying:1")).toBe(true);
    changed = true;

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    expect(await values.has("gmail:applying:1")).toBe(false);
    await expect(gatekeeper.rejectAction(1)).resolves.toBeUndefined();
    expect(await values.has("pending:action:1")).toBe(false);
    expect(deletes).toBe(1);
  });

  it("allows rejection when a retry finds a draft that cannot be parsed", async () => {
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<ambiguous-delete-parse@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const originalRaw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    const unsupportedRaw = base64Url([
      "From: me@example.com",
      "To: to@example.com",
      `Date: ${TEST_DRAFT_DATE}`,
      "Subject: Subject",
      `Message-ID: ${state.rfcMessageId}`,
      "Sender: delegate@example.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n"));
    let malformed = false;
    let deletes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: state.messageId,
            threadId: state.threadId,
            internalDate: "1",
            raw: malformed ? unsupportedRaw : originalRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return json({error: "failed"}, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: state.messageId,
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.delete failed/);
    expect(await values.has("gmail:applying:1")).toBe(true);
    malformed = true;

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/unsupported top-level header/);
    expect(await values.has("gmail:applying:1")).toBe(false);
    await expect(gatekeeper.rejectAction(1)).resolves.toBeUndefined();
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "active"});
    expect(deletes).toBe(1);
  });

  it("retries an ambiguous delete after verifying the draft is unchanged", async () => {
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<retry-delete@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    let deletes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: state.messageId,
            threadId: state.threadId,
            internalDate: "1",
            raw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return deletes === 1
          ? json({error: "failed"}, 500)
          : new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: state.messageId,
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.delete failed/);
    expect(await values.has("gmail:applying:1")).toBe(true);

    await gatekeeper.applyAction(1);

    expect(deletes).toBe(2);
    expect(await values.has("gmail:applying:1")).toBe(false);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "deleted"});
  });

  it("keeps a failed pending delete hidden until its outcome reconciles", async () => {
    const providerId = "provider-draft";
    const messageId = "provider-message";
    const threadId = "provider-thread";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId,
      threadId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<draft-delete@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId),
      subject: state.subject,
      text: state.text,
    }).raw;
    let deletes = 0;
    let gone = false;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: gone ? [] : [{id: providerId, message: {id: messageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (gone) return json({error: "missing"}, 404);
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, messageId, threadId, state))
          : json({
              id: providerId,
              message: {id: messageId, threadId, internalDate: "1", raw},
            });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return json({error: "failed"}, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: messageId,
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/Gmail API drafts\.delete failed/);
    expect(deletes).toBe(1);
    expect(await values.has("pending:action:1")).toBe(true);

    const session = await gatekeeper.startSession(approvalQueue());
    expect(await (await session.listDrafts()).next()).toBeNull();

    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/uncertain provider outcome/);
    gone = true;
    await expect(session.getDraft(providerId)).rejects.toThrow(/has been deleted/);
    await gatekeeper.applyAction(1);
    expect(await (await session.listDrafts()).next()).toBeNull();
  });

  it("treats a missing draft as an idempotently completed delete", async () => {
    const providerId = "provider-draft";
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({error: "missing"}, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: "already-missing",
      dependsOn: [],
    });

    await gatekeeper.applyAction(1);

    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "deleted"});
  });
});
