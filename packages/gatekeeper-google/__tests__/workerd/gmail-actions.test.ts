import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
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
  EmailContent, GmailAttachmentInfo, GmailComposeOptions, GmailDraftInfo, GmailDraftInput,
  GmailDraftPatch, GmailMessageInfo, GmailReplyOptions, GmailThreadInfo,
} from "../../src/types";
import {containsBytes} from "../gmail-test-utils";

type TestHooks = {
  initialize(
      facetName: string, id: string, props: GmailGatekeeperImplProps): Promise<void>;
  startSession(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      queueId: string, rejection?: string): Promise<void>;
  applyAction(
      facetName: string, id: string, props: GmailGatekeeperImplProps,
      actionId: number): Promise<void>;
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

  send(): Promise<void> { return this.call("draft.send", [this.id]) as Promise<void>; }
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

  markReadAndRefresh(actionId: number): Promise<{
    before: GmailMessageInfo;
    after: GmailMessageInfo;
  }> {
    return this.call("message.markReadAndRefresh", [this.id, actionId]) as Promise<{
      before: GmailMessageInfo;
      after: GmailMessageInfo;
    }>;
  }

  async thread(): Promise<TestThread> {
    const info = await this.call("message.thread", [this.id]) as GmailThreadInfo;
    return new TestThread(this.call, info.id);
  }

  reply(body: string, options?: GmailReplyOptions): Promise<void> {
    return this.call("message.reply", [this.id, body, options]) as Promise<void>;
  }

  forward(to: string[], body?: string, options?: GmailComposeOptions): Promise<void> {
    return this.call("message.forward", [this.id, to, body, options]) as Promise<void>;
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
}

class TestThread {
  constructor(private readonly call: SessionCall, private readonly id: string) {}

  getMetadata(): Promise<GmailThreadInfo> {
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
}

class TestSession {
  constructor(
      private readonly call: SessionCall, private readonly restricted: boolean,
  ) {}

  listMessages(): Promise<TestCursor<{info: GmailMessageInfo; message: TestMessage}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.listMessages") as GmailMessageInfo[] | null;
      return infos?.map(info => ({info, message: new TestMessage(this.call, info.id, info)})) ?? null;
    }));
  }

  listDrafts(): Promise<TestCursor<{info: GmailDraftInfo; draft: TestDraft}>> {
    return Promise.resolve(new TestCursor(async () => {
      const infos = await this.call("session.listDrafts") as GmailDraftInfo[] | null;
      return infos?.map(info => ({info, draft: new TestDraft(this.call, info.id)})) ?? null;
    }));
  }

  send(
      to: string[], subject: string, body: string, options?: GmailComposeOptions,
  ): Promise<void> {
    return this.call("session.send", [to, subject, body, options]) as Promise<void>;
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
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

type FetchCall = {url: URL; init: RequestInit};

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
    startSession(approval: ApprovalQueueHandle): Promise<TestSession> {
      approval.read = () => runHook(hook, instance => instance.readQueue(approval.id));
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
    id: string, threadId: string, rfcMessageId = "<message@example.com>", labelIds: string[] = []) {
  return {
    id,
    threadId,
    internalDate: "1",
    labelIds,
    payload: {headers: [
      {name: "From", value: "sender@example.com"},
      {name: "To", value: "me@example.com"},
      {name: "Subject", value: "Known message"},
      {name: "Message-ID", value: rfcMessageId},
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

describe("Gmail forward action snapshots", () => {
  it("bounds approval descriptions for large outbound bodies", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const queue = approvalQueue();
    const session = await gatekeeper.startSession(queue);

    await session.send(["to@example.com"], "Subject", "x".repeat(64 * 1024));

    const description = (await queue.read!()).submissions[0]?.description as {description: string};
    expect(description).toBeDefined();
    expect(description.description.length).toBeLessThan(32 * 1024 + 100);
    expect(description.description).toContain("truncated");
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
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw), labelIds: [],
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

    const description = (await queue.read!()).submissions[1]?.description as {description: string};
    expect(description.description).toContain("Intro");
    expect(description.description).toContain("Source body");
    expect(description.description).toContain("Source <strong>HTML</strong>");
    expect(description.description).toContain("source.txt (text/plain)");
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
          labelIds: [], payload: {headers: [
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
    let writes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: delivered ? [{id: "sent-message", threadId: "sent-thread"}] : []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/sent-message" && !init.method) {
        return json(messageMetadata("sent-message", "sent-thread", "<forward@gadgets.invalid>"));
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        writes++;
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
    const {gatekeeper, storage} = actionHarness((url, init) => {
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
    await draft.send();
    await gatekeeper.applyAction(3);

    expect(extractRfc822Attachments(sentRaw!)[0].bytes).toEqual(source);
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
          labelIds: [],
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
    const providerMessageId = "provider-message";
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

    await draft.send();

    const action = await values.get<{messageId: string; approved: GmailDraftState}>("pending:action:1");
    if (!action) throw new Error("Missing staged draft-send action.");
    expect(action.messageId).toMatch(/^<[-0-9a-f]+@gadgets\.invalid>$/);
    expect(action.approved.rfcMessageId).toBe(action.messageId);
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
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, providerMessageId, threadId, state))
          : json({
              id: providerId,
              message: {id: providerMessageId, threadId, internalDate: "1", raw},
            });
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
        return json(messageMetadata("sent-message", threadId, reconciliationMessageId));
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
    await gatekeeper.applyAction(1);

    expect((await parseMimeMessage(sentRaw!)).messageId).toBe(action.messageId);
    expect(searches).toEqual([
      `in:anywhere -in:drafts rfc822msgid:${action.messageId.slice(1, -1)}`,
    ]);
    expect(sends).toBe(1);
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
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "Label_1", name: "Review", type: "user"}]});
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
    storage.kv.put("gmail:draft:aaa", {
      logicalId: "aaa",
      providerId: "aaa",
      source: {kind: "reply", messageId: "ccc"},
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
    expect(await values.get("gmail:draft:aaa")).toMatchObject({status: "deleted"});
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

  it("refreshes metadata on one message capability after an approved mark-read", async () => {
    let unread = true;
    let metadataReads = 0;
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        metadataReads++;
        return json(messageMetadata(
          messageId, threadId, "<refresh@example.com>", unread ? ["UNREAD"] : []));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}/modify` &&
          init.method === "POST") {
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

    const {before, after} = await message.markReadAndRefresh(1);

    expect(before.labels).toContainEqual({id: "UNREAD", name: "UNREAD", type: "system"});
    expect(after.labels).not.toContainEqual({id: "UNREAD", name: "UNREAD", type: "system"});
    expect(metadataReads).toBe(4);
  });

  it("allows an empty direct reply", async () => {
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
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
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue());
    const entries = await (await session.listMessages()).next();
    const draft = await entries![0].message.createReplyDraft("");

    await expect(draft.send()).resolves.toBeUndefined();

    expect(await values.get("pending:action:2")).toMatchObject({
      type: "draftSend",
      approved: {text: ""},
    });
  });

  it("checks the binding restriction before opening a known message", async () => {
    const rfcMessageId = "<restricted@example.com>";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage(messageId)).rejects.toThrow(/restricted binding/);
    const scopeCheck = calls.find(call => call.url.pathname === "/gmail/v1/users/me/messages");
    expect(scopeCheck?.url.searchParams.get("q")).toBe(
      "(from:sender@example.com) AND (rfc822msgid:restricted@example.com)");
  });

  it("fails closed for a Message-ID containing Gmail query syntax", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, "<x@x)OR(is:unread>"));
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue());

    await expect(session.getMessage(messageId)).rejects.toThrow(/restricted binding/);
    expect(calls.filter(call => call.url.pathname === "/gmail/v1/users/me/messages"))
      .toHaveLength(0);
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

  it("opens a known thread by ID without scanning the thread list", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json({
          id: threadId,
          messages: [{payload: {headers: [{name: "Subject", value: "Known thread"}]}}],
        });
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

  it("limits a search-scoped thread to its admitted messages", async () => {
    const excludedMessageId = "excluded-message";
    const admittedRfcMessageId = "<admitted-thread@example.com>";
    const excludedRfcMessageId = "<excluded-thread@example.com>";
    const {gatekeeper} = actionHarness((url, init) => {
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
  });

  it("rejects a thread with no messages admitted by the binding", async () => {
    const rfcMessageId = "<outside-thread@example.com>";
    const {gatekeeper} = actionHarness((url, init) => {
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
  });

  it("limits a label-scoped thread to messages carrying the bound label", async () => {
    const admittedMessageId = "admitted-label-message";
    const excludedMessageId = "excluded-label-message";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "Label_1", name: "Team", type: "user"}]});
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
  it.each([
    ["archive", "/modify", {addLabelIds: [], removeLabelIds: ["INBOX"]}],
    ["markRead", "/modify", {addLabelIds: [], removeLabelIds: ["UNREAD"]}],
    ["markUnread", "/modify", {addLabelIds: ["UNREAD"], removeLabelIds: []}],
    ["star", "/modify", {addLabelIds: ["STARRED"], removeLabelIds: []}],
    ["unstar", "/modify", {addLabelIds: [], removeLabelIds: ["STARRED"]}],
  ] as const)("applies %s with the expected label mutation", async (operation, suffix, body) => {
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
    });

    await gatekeeper.applyAction(1);

    const call = calls.find(item => item.url.pathname.includes("/threads/thread"));
    expect(call?.url.pathname).toBe(`/gmail/v1/users/me/threads/thread${suffix}`);
    expect(JSON.parse(String(call?.init.body))).toEqual(body);
  });

  it.each([
    ["trash", "/trash"],
    ["applyLabel", "/trash"],
    ["removeLabel", "/untrash"],
  ] as const)("applies %s with the expected trash endpoint", async (operation, suffix) => {
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
      ...(operation === "applyLabel" || operation === "removeLabel" ? {labelId: "TRASH"} : {}),
    });

    await gatekeeper.applyAction(1);

    expect(calls.some(item => item.url.pathname === `/gmail/v1/users/me/threads/thread${suffix}`))
      .toBe(true);
  });

  it("keeps a partially applied multi-message mutation unrejectable until retry succeeds", async () => {
    let rejectSecond = true;
    const writes: string[] = [];
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      const match = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(aaa|bbb)\/modify$/);
      if (match && init.method === "POST") {
        writes.push(match[1]);
        if (match[1] === "bbb" && rejectSecond) {
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
      target: {kind: "messages", messageIds: ["aaa", "bbb"]},
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/messages\.modify failed/);

    expect(await values.has("gmail:applying:1")).toBe(true);
    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/uncertain provider outcome/);

    await gatekeeper.applyAction(1);

    expect(writes).toEqual(["aaa", "bbb", "aaa", "bbb"]);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:applying:1")).toBe(false);
  });

  it("allows rejection when the first mutation target gets a definitive 400", async () => {
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages/aaa/modify" && init.method === "POST") {
        return json({error: "invalid mutation"}, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "messageMutation",
      operation: "markRead",
      target: {kind: "messages", messageIds: ["aaa", "bbb"]},
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/messages\.modify failed/);

    expect(await values.has("gmail:applying:1")).toBe(false);
    await expect(gatekeeper.rejectAction(1)).resolves.toBeUndefined();
    expect(await values.has("pending:action:1")).toBe(false);
  });
});

describe("Gmail label action reconciliation", () => {
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
    const providerMessageId = "provider-message";
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
      source, state.to, state.text, {}, state.rfcMessageId, state.subject)).raw;
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
      ...outboundSpec(after.rfcMessageId), subject: after.subject, text: after.text + "\n",
    }).raw;
    let providerMessageId = "provider-message-1";
    let baselineMode: "unavailable" | "changed" | "expected" = "unavailable";
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (providerMessageId === "provider-message-1") {
          return json({
            id: providerId,
            message: {
              id: providerMessageId,
              threadId: "provider-thread",
              internalDate: "1",
              raw: beforeRaw,
            },
          });
        }
        if (baselineMode === "unavailable") return json({error: "unavailable"}, 400);
        return json({
          id: providerId,
          message: {
            id: baselineMode === "changed" ? "provider-message-3" : "provider-message-2",
            threadId: "provider-thread",
            internalDate: "1",
            raw: normalizedAfterRaw,
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
      after,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(await values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message-2",
    });

    baselineMode = "changed";
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    expect(updates).toBe(1);

    baselineMode = "expected";
    await gatekeeper.applyAction(1);

    expect(updates).toBe(1);
    expect(await values.has("pending:action:1")).toBe(false);
    expect(await values.has("gmail:draftWriteReceipt:1")).toBe(false);
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
      from: "Mailbox Owner <me@example.com>",
      to: ["Provider Display <to@example.com>"],
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
