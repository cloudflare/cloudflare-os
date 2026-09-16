import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {
  applyGmailDraftPatch, canonicalizeGmailMutableLabel, GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES,
  GmailDraftState, GmailForwardSnapshotReference, gmailDependencyError, gmailDraftFingerprint,
  gmailDraftStateFingerprint, GmailForwardSnapshotStore, MAX_GMAIL_PENDING_FORWARD_SNAPSHOT_BYTES,
  overlayGmailDraft,
  overlayGmailLabels,
} from "../../src/gmail-state";
import {GmailApi, parseGmailDraft} from "../../src/google-api";

const testEnv = env as unknown as {TestHooks: DurableObjectNamespace};
const TEST_DRAFT_DATE = "Thu, 1 Jan 1970 00:00:00 +0000";

type SnapshotTestStore = {
  capture(bytes: Uint8Array): Promise<GmailForwardSnapshotReference>;
  read(snapshot: GmailForwardSnapshotReference): Promise<Uint8Array>;
  delete(snapshot: GmailForwardSnapshotReference): Promise<void>;
  prune(referenced: ReadonlySet<string>, createdBefore: number): Promise<void>;
  keys(): Promise<string[]>;
  entries(): Promise<Array<[string, unknown]>>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteKey(key: string): Promise<void>;
};

function snapshotStore(): SnapshotTestStore {
  const stub = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(`gmail-state-${crypto.randomUUID()}`));
  function run<T>(callback: (store: GmailForwardSnapshotStore, storage: DurableObjectStorage) => T | Promise<T>) {
    return runInDurableObject(stub, (_instance, state) =>
      callback(new GmailForwardSnapshotStore(state.storage), state.storage));
  }
  return {
    capture: bytes => run(store => store.capture(bytes)),
    read: snapshot => run(store => store.read(snapshot)),
    delete: snapshot => run(store => { store.delete(snapshot); }),
    prune: (referenced, createdBefore) => run(store => {
      store.pruneUnreferenced(referenced, createdBefore);
    }),
    keys: () => run((_store, storage) => [...storage.kv.list()].map(([key]) => key)),
    entries: () => run((_store, storage) => [...storage.kv.list()]),
    get: key => run((_store, storage) => storage.kv.get(key)),
    put: (key, value) => run((_store, storage) => { storage.kv.put(key, value); }),
    deleteKey: key => run((_store, storage) => { storage.kv.delete(key); }),
  };
}

const draft = (overrides: Partial<GmailDraftState> = {}): GmailDraftState => ({
  logicalId: "provisional-draft-1",
  from: "me@example.com",
  replyTo: [],
  to: ["to@example.com"],
  cc: [],
  bcc: [],
  subject: "Subject",
  text: "Body",
  html: "<p>Body</p>",
  timestamp: 1,
  attachments: [{
    key: "a",
    info: {
      filename: "a.txt", mimeType: "text/plain", size: 1,
      disposition: "attachment", readable: true,
    },
    contentDigest: "digest",
  }],
  version: 0,
  ...overrides,
});

const snapshotBytes = () => Uint8Array.from(
  {length: GMAIL_FORWARD_SNAPSHOT_CHUNK_BYTES + 17}, (_, index) => index % 251);

describe("Gmail draft overlays", () => {
  it("simulates provisional create and update without dropping attachments", () => {
    const created = draft();
    const updated = applyGmailDraftPatch(created, {text: "Changed", html: null});
    const result = overlayGmailDraft(created.logicalId, undefined, [
      {id: 1, action: {type: "draftCreate", draft: created}},
      {id: 2, action: {
        type: "draftUpdate", draftId: created.logicalId, after: updated, dependsOn: [1],
      }},
    ]);
    expect(result?.text).toBe("Changed");
    expect(result?.html).toBeUndefined();
    expect(result?.attachments).toEqual(created.attachments);
  });

  it("applies create, update, and delete overlays in dependency order", () => {
    const created = draft();
    const updated = applyGmailDraftPatch(created, {text: "Changed"});
    const createAndUpdate = [
      {id: 1, action: {type: "draftCreate" as const, draft: created}},
      {id: 2, action: {
        type: "draftUpdate" as const, draftId: created.logicalId, after: updated, dependsOn: [1],
      }},
    ];
    expect(overlayGmailDraft(created.logicalId, undefined, createAndUpdate)?.text).toBe("Changed");
    expect(overlayGmailDraft(created.logicalId, undefined, [...createAndUpdate, {
      id: 3,
      action: {type: "draftDelete", draftId: created.logicalId, dependsOn: [1, 2]},
    }])).toBeNull();
  });

  it("hides a draft after a pending delete", () => {
    const base = draft({logicalId: "d"});
    expect(overlayGmailDraft("d", base, [
      {id: 2, action: {type: "draftDelete", draftId: "d"}},
    ])).toBeNull();
    expect(overlayGmailDraft("d", base, [])).toEqual(base);
  });

  it("preserves provider-owned identity while overlaying a pending update", () => {
    const base = draft({
      logicalId: "d", providerId: "provider-draft", messageId: "provider-message", threadId: "t1",
    });
    const after = applyGmailDraftPatch(
      draft({logicalId: "d", providerId: undefined, messageId: undefined, threadId: undefined}),
      {text: "Changed"});
    expect(overlayGmailDraft("d", base, [{
      id: 2,
      action: {type: "draftUpdate", draftId: "d", after},
    }])).toMatchObject({
      text: "Changed",
      providerId: "provider-draft",
      messageId: "provider-message",
      threadId: "t1",
    });
    expect(overlayGmailDraft("d", base, [{
      id: 1,
      action: {type: "draftCreate", draft: draft({logicalId: "d"})},
    }])).toMatchObject({
      providerId: "provider-draft",
      messageId: "provider-message",
      threadId: "t1",
    });
  });

  it("does not simulate a dependent action after its prerequisite is rejected", () => {
    const base = draft();
    const changed = {...base, text: "must not appear"};
    expect(overlayGmailDraft(base.logicalId, base, [
      {id: 2, action: {
        type: "draftUpdate", draftId: base.logicalId, after: changed, dependsOn: [1],
      }},
    ], new Map([[1, "rejected"]]))).toEqual(base);
  });

  it("invalidates a rejected provisional create and retains a mapped logical ID", () => {
    const provisional = draft();
    expect(overlayGmailDraft(provisional.logicalId, undefined, [], new Map([[1, "rejected"]])))
      .toBeNull();
    const mapped = draft({providerId: "provider-draft-id"});
    expect(overlayGmailDraft(mapped.logicalId, mapped, [])).toMatchObject({
      logicalId: provisional.logicalId,
      providerId: "provider-draft-id",
    });
  });

  it("reports pending and rejected prerequisites distinctly", () => {
    const action = {dependsOn: [1]};
    expect(gmailDependencyError(action, new Set([1]), new Map())).toMatch(/pending prerequisite/);
    expect(gmailDependencyError(action, new Set(), new Map([[1, "rejected"]])))
      .toMatch(/was rejected/);
    expect(gmailDependencyError(action, new Set(), new Map()))
      .toMatch(/no recorded successful outcome/);
  });

  it("keeps a reply subject immutable", () => {
    expect(() => applyGmailDraftPatch(
      draft({source: {kind: "reply", messageId: "m"}}), {subject: "Different"}))
      .toThrow(/immutable/);
  });

  it("uses the same semantic fingerprint before and after a provider MIME round trip", async () => {
    const message = new GmailApi("me@example.com", async () => "token").buildOutbound({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      html: "<p>Body</p>",
      messageId: "<draft@gadgets.invalid>",
      attachments: [],
    });
    const state = draft({
      logicalId: "d",
      date: TEST_DRAFT_DATE,
      attachments: [],
      rfcMessageId: "<draft@gadgets.invalid>",
    });
    const parsed = await parseGmailDraft({
      id: "m", threadId: "t", internalDate: "1", raw: message.raw,
    });
    expect(await gmailDraftFingerprint(parsed, "t"))
      .toBe(await gmailDraftStateFingerprint(state));
  });

  it("includes the Date header in raw and simulated draft fingerprints", async () => {
    const date = TEST_DRAFT_DATE;
    const state = draft({date, html: undefined, attachments: []});
    const parsed = {
      from: state.from,
      replyTo: state.replyTo,
      to: state.to,
      cc: state.cc,
      bcc: state.bcc,
      date,
      subject: state.subject,
      text: state.text,
      attachments: [],
    };
    expect(await gmailDraftFingerprint(parsed)).toBe(await gmailDraftStateFingerprint(state));
    expect(await gmailDraftFingerprint({...parsed, date: "Fri, 2 Jan 1970 00:00:00 +0000"}))
      .not.toBe(await gmailDraftFingerprint(parsed));
    expect(await gmailDraftStateFingerprint({
      ...state, date: "Fri, 2 Jan 1970 00:00:00 +0000",
    })).not.toBe(await gmailDraftStateFingerprint(state));
  });

  it("normalizes display-name formatting but fingerprints visible name changes", async () => {
    const state = draft({
      logicalId: "d",
      from: "Mailbox Owner <me@example.com>",
      replyTo: ["Replies <reply@example.com>"],
      to: ["Provider Name <to@example.com>"],
      cc: ["Changed Name <cc@example.com>"],
      bcc: ["Hidden <bcc@example.com>"],
      html: undefined,
      attachments: [],
      rfcMessageId: "<draft@gadgets.invalid>",
    });
    const parsed = {
      from: '"Mailbox  Owner" <ME@example.com>',
      replyTo: ['"Replies" <reply@example.com>'],
      to: ['"Provider Name" <to@example.com>'],
      cc: ['"Changed Name" <CC@example.com>'],
      bcc: ['"Hidden" <bcc@example.com>'],
      subject: state.subject,
      text: state.text,
      messageId: state.rfcMessageId,
      attachments: [],
    };
    expect(await gmailDraftFingerprint(parsed)).toBe(await gmailDraftStateFingerprint(state));
    expect(await gmailDraftFingerprint({...parsed, to: ["Other Name <to@example.com>"]}))
      .not.toBe(await gmailDraftStateFingerprint(state));
  });

  it("does not fingerprint provider draft, message, or unthreaded thread IDs", async () => {
    const first = draft({
      providerId: "draft-one", messageId: "message-one", threadId: "thread-one",
    });
    const second = draft({
      providerId: "draft-two", messageId: "message-two", threadId: "thread-two",
    });
    expect(await gmailDraftStateFingerprint(first)).toBe(await gmailDraftStateFingerprint(second));
  });

  it.each(["line one\nline two", "line one\r\nline two", "line one\rline two", "trailing\n"])(
    "keeps draft drift fingerprints stable across MIME newline normalization: %j",
    async text => {
      const message = new GmailApi("me@example.com", async () => "token").buildOutbound({
        from: "me@example.com",
        to: ["to@example.com"],
        cc: [],
        bcc: [],
        date: TEST_DRAFT_DATE,
        subject: "Subject",
        text,
        messageId: "<draft@gadgets.invalid>",
        attachments: [],
      });
      const state = draft({
        logicalId: "d",
        date: TEST_DRAFT_DATE,
        text,
        html: undefined,
        attachments: [],
        rfcMessageId: "<draft@gadgets.invalid>",
      });
      const parsed = await parseGmailDraft({
        id: "m", threadId: "t", internalDate: "1", raw: message.raw,
      });
      expect(await gmailDraftFingerprint(parsed, "t"))
        .toBe(await gmailDraftStateFingerprint(state));
    },
  );

  it("keeps an empty draft fingerprint stable across a MIME round trip", async () => {
    const message = new GmailApi("me@example.com", async () => "token").buildOutbound({
      from: "me@example.com",
      to: [],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "",
      text: "",
      messageId: "<draft@gadgets.invalid>",
      attachments: [],
    });
    const parsed = await parseGmailDraft({
      id: "m", threadId: "t", internalDate: "1", raw: message.raw,
    });
    expect(await gmailDraftFingerprint(parsed, "t")).toBe(await gmailDraftStateFingerprint(draft({
      logicalId: "d",
      date: TEST_DRAFT_DATE,
      to: [],
      subject: "",
      text: "",
      html: undefined,
      attachments: [],
      rfcMessageId: "<draft@gadgets.invalid>",
    })));
  });

  it("keeps an attachment fingerprint stable across a MIME round trip", async () => {
    const bytes = new TextEncoder().encode("attachment content");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const message = new GmailApi("me@example.com", async () => "token").buildOutbound({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      date: TEST_DRAFT_DATE,
      subject: "Subject",
      text: "Body",
      messageId: "<draft@gadgets.invalid>",
      attachments: [{
        filename: "file.txt",
        contentType: "text/plain",
        data: btoa("attachment content"),
        disposition: "attachment",
        description: "file.txt",
      }],
    });
    const parsed = await parseGmailDraft({
      id: "m", threadId: "t", internalDate: "1", raw: message.raw,
    });
    expect(await gmailDraftFingerprint(parsed, "t")).toBe(await gmailDraftStateFingerprint(draft({
      logicalId: "d",
      date: TEST_DRAFT_DATE,
      html: undefined,
      rfcMessageId: "<draft@gadgets.invalid>",
      attachments: [{
        key: "0",
        info: {
          filename: "file.txt",
          mimeType: "text/plain",
          size: bytes.byteLength,
          disposition: "attachment",
          readable: true,
        },
        contentDigest: digest,
      }],
    })));
  });
});

describe("Gmail forward snapshot storage", () => {
  it("stores and reassembles the exact captured bytes", async () => {
    const store = snapshotStore();
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const snapshot = await store.capture(bytes);

    await expect(store.read(snapshot)).resolves.toEqual(bytes);
  });

  it.each([
    ["missing", async (store: SnapshotTestStore, keys: string[]) => store.deleteKey(keys[1])],
    ["reordered", async (store: SnapshotTestStore, keys: string[]) => {
      const first = await store.get<Uint8Array>(keys[0]);
      const second = await store.get<Uint8Array>(keys[1]);
      if (!first || !second) throw new Error("Missing snapshot chunk.");
      await store.put(keys[0], second);
      await store.put(keys[1], first);
    }],
    ["truncated", async (store: SnapshotTestStore, keys: string[]) => {
      const chunk = await store.get<Uint8Array>(keys[0]);
      if (!chunk) throw new Error("Missing snapshot chunk.");
      await store.put(keys[0], chunk.slice(1));
    }],
    ["corrupted", async (store: SnapshotTestStore, keys: string[]) => {
      const chunk = await store.get<Uint8Array>(keys[0]);
      if (!chunk) throw new Error("Missing snapshot chunk.");
      chunk[0] ^= 0xff;
      await store.put(keys[0], chunk);
    }],
  ])("rejects %s snapshot chunks before use", async (_name, corrupt) => {
    const store = snapshotStore();
    const snapshot = await store.capture(snapshotBytes());
    const keys = (await store.keys())
      .filter(key => key.includes(`${snapshot.handle}:chunk:`)).toSorted();
    await corrupt(store, keys);
    await expect(store.read(snapshot)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("cleans up every chunk and makes the snapshot unreadable", async () => {
    const store = snapshotStore();
    const snapshot = await store.capture(snapshotBytes());
    await store.delete(snapshot);
    await store.delete(snapshot);
    expect((await store.keys()).some(key => key.includes(snapshot.handle))).toBe(false);
    expect((await store.entries()).find(([, value]) => typeof value === "number")?.[1]).toBe(0);
    await expect(store.read(snapshot)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("releases aggregate accounting even when a snapshot manifest is missing", async () => {
    const store = snapshotStore();
    const snapshot = await store.capture(new Uint8Array([1, 2, 3]));
    const manifestKey = (await store.keys()).find(
      key => key.includes(snapshot.handle) && key.endsWith(":manifest"));
    await store.deleteKey(manifestKey!);
    await store.delete(snapshot);
    expect((await store.entries()).find(([, value]) => typeof value === "number")?.[1]).toBe(0);
  });

  it("prunes stale unreferenced snapshots but retains pending-action snapshots", async () => {
    const store = snapshotStore();
    const retained = await store.capture(new Uint8Array([1]));
    const orphaned = await store.capture(new Uint8Array([2]));
    await store.prune(new Set([retained.handle]), Date.now() + 1);
    expect(await store.read(retained)).toEqual(new Uint8Array([1]));
    expect((await store.keys()).some(key => key.includes(orphaned.handle))).toBe(false);
  });

  it("bounds aggregate pending snapshot storage", async () => {
    const store = snapshotStore();
    await store.capture(new Uint8Array([1]));
    const totalKey = (await store.entries()).find(([, value]) => typeof value === "number")?.[0];
    expect(totalKey).toBeDefined();
    await store.put(totalKey!, MAX_GMAIL_PENDING_FORWARD_SNAPSHOT_BYTES);
    await expect(store.capture(new Uint8Array([2]))).rejects.toThrow(/aggregate storage limit/);
  });

  it("fails old pending action snapshots closed with resubmission guidance", async () => {
    const store = snapshotStore();
    await expect(store.read({size: 1, digest: "0".repeat(64)} as never))
      .rejects.toThrow(/reject and resubmit/i);
  });
});

describe("Gmail label state and canonicalization", () => {
  const provider = [
    {id: "INBOX", name: "INBOX", type: "system" as const},
    {id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" as const},
    {id: "Label_1", name: "Real name", type: "user" as const},
  ];

  it("does not trust a caller-provided custom label name", () => {
    expect(canonicalizeGmailMutableLabel(
      {id: "Label_1", name: "Forged name", type: "custom"}, provider, []))
      .toEqual({id: "Label_1", name: "Real name", type: "custom"});
  });

  it("requires exact system ID/name consistency and the mutable allowlist", () => {
    expect(() => canonicalizeGmailMutableLabel(
      {id: "INBOX", name: "TRASH", type: "system"}, provider, [])).toThrow(/inconsistent/);
    expect(() => canonicalizeGmailMutableLabel(
      {id: "SENT", name: "SENT", type: "system"}, [
        ...provider, {id: "SENT", name: "SENT", type: "system" as const},
      ], [])).toThrow(/not mutable/);
  });

  it("accepts manually applicable category labels", () => {
    expect(canonicalizeGmailMutableLabel(
      {id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system"}, provider, []))
      .toEqual({id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system"});
  });

  it("accepts only this binding's active provisional labels", () => {
    const local = [{
      logicalId: "provisional-label-1", name: "Pending", status: "active" as const,
    }];
    expect(canonicalizeGmailMutableLabel(
      {id: "provisional-label-1", name: "forged", type: "custom"}, provider, local))
      .toEqual({id: "provisional-label-1", name: "Pending", type: "custom"});
    expect(() => canonicalizeGmailMutableLabel(
      {id: "provisional-label-other", name: "Pending", type: "custom"}, provider, local))
      .toThrow(/not found/);
  });

  it("uses the provider's current name for a mapped custom label", () => {
    expect(canonicalizeGmailMutableLabel(
      {id: "logical-label", name: "forged", type: "custom"}, provider, [{
        logicalId: "logical-label",
        providerId: "Label_1",
        name: "Stale local name",
        status: "active",
      }])).toEqual({id: "logical-label", name: "Real name", type: "custom"});
  });

  it("overlays create, rename, and delete in submission order", () => {
    const resource = {
      logicalId: "provisional-label-1", name: "Pending", status: "active" as const,
    };
    expect(overlayGmailLabels(provider, [resource], [
      {id: 1, action: {type: "labelCreate", label: resource}},
      {id: 2, action: {type: "labelRename", labelId: resource.logicalId, name: "Renamed"}},
    ])).toContainEqual({id: resource.logicalId, name: "Renamed", type: "user"});
    expect(overlayGmailLabels(provider, [resource], [
      {id: 1, action: {type: "labelCreate", label: resource}},
      {id: 2, action: {type: "labelDelete", labelId: resource.logicalId}},
    ])).not.toContainEqual(expect.objectContaining({id: resource.logicalId}));
  });
});
