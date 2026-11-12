import { ActionJournal, defineActions, type JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessTokenCache } from "../src/auth-retry";
import type {
  DocsRange, DocsSuggestionRecord, GoogleDocsApi, GoogleDocsDocument, StructuralElement,
} from "../src/docs-api";
import { GoogleApiError } from "../src/google-response";
import {
  DriveApi, DriveApiRequestError, type DriveCommentRecord, type DriveReplyRecord,
  type DriveScopeNode,
} from "../src/drive-api";
import {
  commentEntries, commentParent, DRIVE_COMMENT_DEFINITIONS, hasPendingResolve, overlayPending,
  pendingComment, pendingCommentRefusal, pendingReply, pendingSuggestion, REPLY_RESOLVE_PENDING,
  RESOLVE_PENDING, suggestionSummary,
  toDriveComment, type DriveCommentAction, type DriveCommentActions,
} from "../src/drive-comments";
import type { DriveBindingScope } from "../src/drive-session";
import {
  CREDENTIALS_NOT_ACCEPTED, readOnlyRefusal, writeRefusal, WRITES_GRANT_MISSING, type DriveWritesHost, type QueuedWrite,
  type WriteAttempt,
} from "../src/drive-writes";
import { parseResourceUrl, type DriveAccessLevel } from "../src/resources";
import { FakeKv } from "./fake-kv";

const TARGET = { fileId: "doc-1", queuedAt: "2026-10-20T10:00:00.000Z" };
const KIND = { tag: "driveComments", label: "Drive comments" };
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const GRANT_MISSING =
  "Changes need a permission this Google account hasn't granted, or no longer grants. In " +
  "Workshop, start adding a Google Drive connection for this account, choose all of Drive or a " +
  "folder, then \"Read and write\", and select \"Allow changes\". The permission covers every " +
  "read and write Drive connection on the account, so the dialog can then be closed.";
const UNCONFIRMED_SEND =
  "Google Drive did not confirm whether this was posted, and it may have been. Approving it " +
  "again first checks the file's comments, so it is not posted twice; rejecting it leaves " +
  "anything already posted on the file.";
const NOT_VISIBLE =
  "Google Drive no longer shows this file or comment to the connected account, so whether this " +
  "was posted can't be checked, and it won't be sent again. Reject it to clear it.";
const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
const CANNOT_COMMENT = "The connected account can no longer comment on that file.";
const NOT_FOUND = "That comment was not found on this file.";
/** The fields that show the comment a reply or resolve answers. */
const PARENT_FIELDS = [
  { label: "Comment author", kind: "inline", value: "Ada Lovelace" },
  { label: "Comment text", kind: "text", value: "Is this date right?" },
];

/** A comment as Drive returns it. */
function live(overrides: Partial<DriveCommentRecord> = {}): DriveCommentRecord {
  return {
    id: "doco.c1", content: "Is this date right?",
    author: { displayName: "Ada Lovelace", me: false },
    createdTime: "2026-10-20T09:00:00.000Z", resolved: false, deleted: false, replies: [],
    ...overrides,
  };
}

/** Hex SHA-256 of the text of the comment `live()` returns. */
const LIVE_SHA256 = createHash("sha256").update("Is this date right?").digest("hex");

/** What a reply or resolve keeps of the comment `live()` returns. */
const PARENT = await commentParent(live());

/** A reply of the connected account's, as Drive lists it. */
function mine(overrides: Partial<DriveReplyRecord> = {}): DriveReplyRecord {
  return {
    id: "doco.reply", content: "Fixed.", author: { displayName: "Me", me: true },
    createdTime: "2026-10-20T10:00:01.000Z", deleted: false, ...overrides,
  };
}

/** A live folder the account can list, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return { id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true };
}

/** A live file the account can comment on, as a scope proof reads it. */
function file(id: string, parent: string): DriveScopeNode {
  return { id, mimeType: "application/pdf", parents: [parent], trashed: false, canComment: true };
}

/** Drive's answer to a send or a look whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");
/** Drive's refusal of a token that lacks the scope a request needs. */
const missingScope = () => new DriveApiRequestError(403, "insufficientPermissions");
/** Drive's refusal of an account that cannot comment on the file. */
const viewOnly = () => new DriveApiRequestError(403, "insufficientFilePermissions");

/** Drive's batch answer for one file: 200 around the part, whatever the part's own status. */
function batchOfOne(status: number, body: unknown): Response {
  let boundary = "batch_boundary";
  let text = [
    `--${boundary}`, "Content-Type: application/http", "Content-ID: <response-item-0>", "",
    `HTTP/1.1 ${status} Test`, "Content-Type: application/json", "", JSON.stringify(body), "",
    `--${boundary}--`, "",
  ].join("\r\n");
  return new Response(text, { headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A kv that can fail the journal's next write of one kind, as a storage write can. */
class FaultyKv extends FakeKv {
  /** Fails the next write of the journal's applied-id memory: a retire that does not land. */
  failNextRetire = false;
  /** Fails the next write of a failed record: a terminal failure that does not land. */
  failNextFailure = false;
  override put<T>(key: string, value: T): void {
    if (this.failNextRetire && key === "applied:drive:action:") {
      this.failNextRetire = false;
      throw new Error("storage failure");
    }
    if (this.failNextFailure && key.startsWith("drive:action:") &&
        (value as { state?: string }).state === "failed") {
      this.failNextFailure = false;
      throw new Error("storage failure");
    }
    super.put(key, value);
  }
}

/** The comment definitions as a set of their own; the gatekeeper binds them among the others. */
const COMMENT_ACTIONS = defineActions<DriveWritesHost, DriveCommentActions>(
  DRIVE_COMMENT_DEFINITIONS, { fence: "none", vendorId: "google" });

/** A Drive call no comment write makes. */
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

/** The text of the Doc a test host's Docs API reads, one paragraph in tab `t.0`, from index 1. */
const DOC_TEXT = "The launch is in May. Costs are final.\n";

/** A tab body of one paragraph, `content` in one run from index 1. */
function bodyOf(content: string): { content: StructuralElement[] } {
  return { content: [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 1 + content.length, paragraph: {
      elements: [{ startIndex: 1, endIndex: 1 + content.length, textRun: { content, textStyle: {} } }],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    } },
  ] };
}

/** A Doc whose first tab is `text` in one run, and a second tab. */
function docOf(text: string, revisionId = "rev-1"): GoogleDocsDocument {
  let tab = (tabId: string, index: number, content: string) =>
    ({ tabId, title: tabId, index, nestingLevel: 0, lists: {}, namedRanges: {}, body: bodyOf(content) });
  return { documentId: "doc-1", title: "Plan", revisionId,
    tabs: [tab("t.0", 0, text), tab("t.1", 1, "Second tab.\n")] };
}

/** Docs' refusal of a write: of a revision other than the latest, a bad request, or a hidden file. */
const docsRefused = (status = "INVALID_ARGUMENT") =>
  new GoogleApiError("Google Docs suggest edit failed [http=400]", status);

/** A suggestion of the connected account's, as Docs lists it. */
function suggestion(overrides: Partial<DocsSuggestionRecord> = {}): DocsSuggestionRecord {
  return {
    suggestionId: "suggest.s1", summaryText: "Replace: “May” with “June”",
    headPost: { content: "", me: true, createTime: new Date().toISOString(), deleted: false },
    replies: [], ...overrides,
  };
}

/** A suggested edit's payload, replacing "May" in tab `t.0`. */
function edit(
  overrides: Partial<DriveCommentActions["suggestEdit"]> = {},
): DriveCommentActions["suggestEdit"] {
  return { ...TARGET, tabId: "t.0", oldText: "May", newText: "June", ...overrides };
}

/** A comment's payload, attached to "Costs are final" in tab `t.0`. */
const ANCHORED = { ...TARGET, content: "Are they?", anchor: { tabId: "t.0", text: "Costs are final" } };

/** The comment set bound over an in-memory journal, with a host a test can steer. */
function harness(scope: DriveBindingScope = { kind: "account" }, kv: FakeKv = new FakeKv()) {
  let attempts = new Map<number, WriteAttempt>();
  let refused: string | undefined;
  let described: ActionDescription | undefined;
  let api = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(
      async ids => ids.map(id => ({ id, canComment: true }))),
    getComment: vi.fn<DriveApi["getComment"]>(async () => live()),
    listComments: vi.fn<DriveApi["listComments"]>(async () => ({ comments: [] })),
    listReplies: vi.fn<DriveApi["listReplies"]>(async () => ({ replies: [] })),
    createComment: vi.fn<DriveApi["createComment"]>(
      async () => live({ id: "doco.posted", author: { displayName: "Me", me: true } })),
    createReply: vi.fn<DriveApi["createReply"]>(async () => mine()),
    listPermissions: vi.fn<DriveApi["listPermissions"]>(unexpected),
    createPermission: vi.fn<DriveApi["createPermission"]>(unexpected),
    updatePermission: vi.fn<DriveApi["updatePermission"]>(unexpected),
    deletePermission: vi.fn<DriveApi["deletePermission"]>(unexpected),
    swapParent: vi.fn<DriveApi["swapParent"]>(unexpected),
  };
  let doc = { current: docOf(DOC_TEXT), suggestions: [] as DocsSuggestionRecord[] };
  let docs = {
    getDocumentWithSuggestions: vi.fn<GoogleDocsApi["getDocumentWithSuggestions"]>(
      async () => ({ document: doc.current, suggestions: doc.suggestions })),
    getRevisionId: vi.fn<GoogleDocsApi["getRevisionId"]>(async () => doc.current.revisionId),
    insertComment: vi.fn<GoogleDocsApi["insertComment"]>(async () => "doco.anchored"),
    suggest: vi.fn<GoogleDocsApi["suggest"]>(async () => ({ id: "suggest.s1", threadSaved: true })),
    replyToSuggestion: vi.fn<GoogleDocsApi["replyToSuggestion"]>(async () => undefined),
  };
  let host: DriveWritesHost = {
    api,
    docs,
    scope: () => scope,
    writeRefusal: async () => refused,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
  };
  let journal = new ActionJournal<DriveCommentAction>(kv, { namespace: "drive" });
  let actions = COMMENT_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = <K extends keyof DriveCommentActions>(kind: K, payload: DriveCommentActions[K]) =>
    actions.submit(queue, kind, payload);
  return {
    api, docs, doc, host, journal, actions, attempts, submit,
    /**
     * Makes `suggest` keep what it makes in the Doc's suggestions, summed up as Google does, and
     * `replyToSuggestion` keep each note on its thread. `loseFirst` makes the first send of
     * `what` land and then fail with no answer.
     */
    keepSuggestions({ loseFirst }: { loseFirst?: "suggestion" | "note" } = {}): void {
      let lose = loseFirst;
      docs.suggest.mockImplementation(async (_documentId, requests) => {
        let [{ deleteContentRange: { range } }, insert] = requests as
          [{ deleteContentRange: { range: DocsRange } }, { insertText: { text: string } }?];
        let old = DOC_TEXT.slice(range.startIndex - 1, range.endIndex - 1);
        let made = suggestion({
          suggestionId: `suggest.s${doc.suggestions.length + 1}`,
          summaryText: insert ? `Replace: “${old}” with “${insert.insertText.text}”` : `Delete: “${old}”`,
        });
        doc.suggestions.push(made);
        if (lose === "suggestion") {
          lose = undefined;
          throw new Error("The operation was aborted due to timeout");
        }
        return { id: made.suggestionId, threadSaved: true };
      });
      docs.replyToSuggestion.mockImplementation(async (_documentId, suggestionId, content) => {
        let thread = doc.suggestions.find(candidate => candidate.suggestionId === suggestionId)!;
        thread.replies.push({ content, me: true, createTime: new Date().toISOString(), deleted: false });
        if (lose === "note") {
          lose = undefined;
          throw new Error("The operation was aborted due to timeout");
        }
      });
    },
    /** Submits one write and returns what its approval shows. */
    async card<K extends keyof DriveCommentActions>(
      kind: K, payload: DriveCommentActions[K],
    ): Promise<ActionDescription> {
      await submit(kind, payload);
      if (!described) throw new Error("nothing was described");
      return described;
    },
    /** Applies an action, answering `null` when it applied and the failure's message otherwise. */
    apply: (id: number): Promise<string | null> =>
      actions.apply(id).then(() => null, (error: Error) => error.message),
    reject: (id: number) => actions.reject(id),
    /** Sets what the binding's write refusal answers from here on. */
    refuse(message: string | undefined): void { refused = message; },
    /** Dates the action's marker ten minutes back, keeping its other fields; returns that time. */
    aged(id: number): number {
      let attempt = attempts.get(id);
      if (!attempt) throw new Error("no marker to age");
      let at = Date.now() - 10 * 60_000;
      attempts.set(id, { ...attempt, at });
      return at;
    },
    /** What the gatekeeper does before it applies: hands back a claim an earlier apply left. */
    adopt(id: number): void {
      if (journal.get(id)?.state === "claimed") journal.restorePending(id);
    },
    /**
     * Makes `createComment` keep what it posts, as the connected account's own comment created
     * at the time of the call, and `listComments` answer with it, so a look can find it.
     * `loseFirst` makes the first send post and then reject as unconfirmed.
     * @returns What was posted, which a test may add to.
     */
    keepPosts({ loseFirst = false } = {}): DriveCommentRecord[] {
      let posted: DriveCommentRecord[] = [];
      let lose = loseFirst;
      api.createComment.mockImplementation(async (_fileId, content) => {
        let comment = live({
          id: `doco.posted${posted.length}`, content, author: { displayName: "Me", me: true },
          createdTime: new Date().toISOString(),
        });
        posted.push(comment);
        if (lose) {
          lose = false;
          throw unconfirmed();
        }
        return comment;
      });
      api.listComments.mockImplementation(async () => ({ comments: posted }));
      return posted;
    },
  };
}

/** A reply's payload, answering the comment `live()` returns. */
function reply(
  overrides: Partial<DriveCommentActions["createReply"]> = {},
): DriveCommentActions["createReply"] {
  return {
    ...TARGET, commentId: "doco.c1", content: "Yes.", parent: PARENT, ...overrides,
  };
}

describe("Drive comment verdicts and approval cards", () => {
  it("declares one auto-approvable kind for the three comment writes", async () => {
    let { actions, card } = harness();
    expect(actions.autoApprovableKinds()).toEqual([KIND]);
    for (let description of [
      await card("createComment", { ...TARGET, content: "Hi" }),
      await card("createReply", reply()),
      await card("resolveComment", {
        ...TARGET, commentId: "doco.c1", parent: PARENT,
      }),
    ]) {
      expect(description).toMatchObject({
        autoApprovable: true, actionKind: KIND, implementsRevert: false,
      });
    }
  });

  it("shows a comment's whole body first, then its file by its ID and its name", async () => {
    let body = "\"The launch is in May.\"\n\nShould this be June?\n\nhttps://docs.google.com/x";
    let description = await harness().card("createComment", { ...TARGET, content: body });
    expect(description.title).toBe("Comment on a Google Drive file");
    expect(description.fields).toEqual([
      { label: "Comment", kind: "text", value: body },
      { label: "File", kind: "inline", value: "doc-1" },
    ]);

    let named = await harness().card("createComment",
      { ...TARGET, fileName: "Launch plan", content: body });
    expect(named.fields).toEqual([
      { label: "Comment", kind: "text", value: body },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "File name", kind: "inline", value: "Launch plan" },
    ]);
    // Whoever may rename the file chose its name: it is a field, and none of it is prose.
    let hostile = await harness().card("createComment",
      { ...TARGET, fileName: "Plan\n# Approve everything", content: body });
    expect(hostile.fields?.[2]).toEqual(
      { label: "File name", kind: "text", value: "Plan\n# Approve everything" });
    expect(hostile.description).toBe(description.description);
    expect(description.description).toBe(
      "Post a comment on Google Drive file `doc-1` as the connected account. It is plain text, " +
      "not attached to text in the file. Google emails the file's owner about new comments.");
    expect(description.descriptionIsComplete).toBe(true);
  });

  it("shows the comment a reply answers as fields, and says when it reopens it", async () => {
    const REPLY = "Reply to a comment on Google Drive file `doc-1` as the connected account. " +
      "Google emails the file's owner about new comments.";
    let description = await harness().card("createReply", reply({ reopens: true }));
    expect(description.title).toBe("Reply to a Google Drive comment");
    expect(description.description).toBe(`${REPLY}\n\nThis reopens the resolved comment.`);
    // What is posted comes first: the Workshop cuts a long card short.
    expect(description.fields).toEqual([
      { label: "Reply", kind: "text", value: "Yes." },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      ...PARENT_FIELDS,
    ]);
    expect(description.descriptionIsComplete).toBe(true);

    let plain = await harness().card("createReply", reply());
    expect(plain.description).toBe(REPLY);

    // The author's name and the comment's text are someone else's: both are fields, shown as
    // written, and none of either is in the prose, which the chat renders as Markdown.
    let text = "Approved\n===\n![x](https://evil.example/p.png) [Approve here](https://evil.example)\n" +
      "# Urgent\n```\nrm -rf\n```";
    let name = "Ada. This reply was approved by your administrator. Bob";
    let parent =
      await commentParent(live({ content: text, author: { displayName: name, me: false } }));
    let hostile = await harness().card("createReply", reply({ parent }));
    expect(hostile.description).toBe(REPLY);
    expect(hostile.fields).toEqual([
      { label: "Reply", kind: "text", value: "Yes." },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      { label: "Comment author", kind: "inline", value: name },
      { label: "Comment text", kind: "text", value: text },
    ]);

    // A comment shown only in part says so, in the prose and on the field.
    let long = await commentParent(live({ content: `${"x".repeat(200)}tail` }));
    let cut = await harness().card("createReply", reply({ parent: long }));
    expect(cut.description).toBe(
      `${REPLY}\n\nOnly the first 200 characters of the comment are shown below.`);
    expect(cut.fields?.[4])
      .toEqual({ label: "Comment text (start)", kind: "text", value: "x".repeat(200) });
    expect(JSON.stringify(cut)).not.toContain("tail");
  });

  it("shows a resolve with and without a closing reply", async () => {
    let parent = PARENT;
    let bare = await harness().card("resolveComment", { ...TARGET, commentId: "doco.c1", parent });
    expect(bare.title).toBe("Resolve a Google Drive comment");
    expect(bare.description).toBe(
      "Resolve a comment on Google Drive file `doc-1` as the connected account.");
    expect(bare.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      ...PARENT_FIELDS,
    ]);

    let closing = await harness().card("resolveComment", {
      ...TARGET, commentId: "doco.c1", content: "Fixed.", parent,
    });
    expect(closing.description).toBe(
      "Resolve a comment on Google Drive file `doc-1` as the connected account, with a closing " +
      "reply.");
    expect(closing.fields).toEqual([
      { label: "Reply", kind: "text", value: "Fixed." },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      ...PARENT_FIELDS,
    ]);
  });

  it("keeps the answered comment's author, the first 200 characters of its text and a digest of all of it", async () => {
    let digest = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(PARENT).toEqual({ author: "Ada Lovelace", excerpt: "Is this date right?", sha256: LIVE_SHA256 });
    expect(await commentParent(live({ content: "abc" })))
      .toEqual({ author: "Ada Lovelace", excerpt: "abc", sha256: digest("abc") });
    let whole = "x".repeat(200);
    expect(await commentParent(live({ content: whole })))
      .toEqual({ author: "Ada Lovelace", excerpt: whole, sha256: digest(whole) });
    // The digest is of the whole text, the part past what is shown included.
    expect(await commentParent(live({ content: `${whole}tail` })))
      .toEqual({ author: "Ada Lovelace", excerpt: whole, cut: true, sha256: digest(`${whole}tail`) });
    // Characters are code points: a cut never splits a surrogate pair, and 200 emoji are whole.
    expect(await commentParent(live({ content: "😀".repeat(200) }))).not.toHaveProperty("cut");
    expect(await commentParent(live({ content: "😀".repeat(201) }))).toEqual({
      author: "Ada Lovelace", excerpt: "😀".repeat(200), cut: true,
      sha256: digest("😀".repeat(201)),
    });
  });
});

describe("Drive write refusal", () => {
  it("refuses a read-only binding with the URL to request, without asking the account", async () => {
    let holdsGrant = vi.fn(async () => true);
    let bindings: [DriveBindingScope, string][] = [
      [{ kind: "account" }, "https://drive.google.com/drive/my-drive?access=write"],
      [{ kind: "folder", folderId: "a/b" }, "https://drive.google.com/drive/folders/a%2Fb?access=write"],
      [{ kind: "file", fileId: "doc-1" }, "https://drive.google.com/file/d/doc-1/view?access=write"],
    ];
    for (let [scope, url] of bindings) {
      let refusal = await writeRefusal({ deployment: "write", scope, holdsGrant });
      expect(refusal, scope.kind).toBe(readOnlyRefusal(scope));
      expect(refusal?.endsWith(` ${url}`), scope.kind).toBe(true);
    }
    expect(holdsGrant).not.toHaveBeenCalled();

    expect(readOnlyRefusal({ kind: "folder", folderId: "a/b" })).toBe(
      "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
      "connection with read and write access, which the user chooses when connecting. Request " +
      "one with this resource URL: https://drive.google.com/drive/folders/a%2Fb?access=write");
    let account = readOnlyRefusal({ kind: "account" });
    expect(account).toBe(
      "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
      "connection with read and write access, which the user chooses when connecting. To change " +
      "one file, or the files of one folder, request the narrower " +
      "https://drive.google.com/file/d/<fileId>/view?access=write or " +
      "https://drive.google.com/drive/folders/<folderId>?access=write instead. For all of Drive, " +
      "request this resource URL: https://drive.google.com/drive/my-drive?access=write");
    // Each URL as a copy would take it, up to the next space: all three ask for read and write.
    let urls = account.match(/https:\S+/g) ?? [];
    expect(urls.map(url => parseResourceUrl(url.replace(/<\w+>/, "X1")))).toEqual([
      { kind: "driveFile", fileId: "X1", access: "write" },
      { kind: "driveFolder", folderId: "X1", access: "write" },
      { kind: "driveAccount", access: "write" },
    ]);
  });

  it("reads any other access value as read-only", async () => {
    let scope: DriveBindingScope = { kind: "account" };
    for (let access of ["WRITE" as DriveAccessLevel, "read" as DriveAccessLevel]) {
      expect(await writeRefusal({ deployment: "write", access, scope, holdsGrant: async () => true }), access)
        .toBe(readOnlyRefusal(scope));
    }
  });

  it("asks a read and write binding's account for the grant", async () => {
    let scope: DriveBindingScope = { kind: "account" };
    expect(await writeRefusal({
      deployment: "write", access: "write", scope, holdsGrant: async () => false,
    })).toBe(GRANT_MISSING);
    expect(WRITES_GRANT_MISSING).toBe(GRANT_MISSING);
    expect(await writeRefusal({
      deployment: "write", access: "write", scope, holdsGrant: async () => true,
    })).toBeUndefined();
    await expect(writeRefusal({
      deployment: "write", access: "write", scope,
      holdsGrant: async () => { throw new Error("account unreachable"); },
    })).rejects.toThrow("account unreachable");
  });
});

describe("Drive comment checks at apply", () => {
  it("fails an approved write for good once its binding is read-only, sending nothing", async () => {
    let { api, journal, submit, apply, refuse } = harness();
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    let readOnly = readOnlyRefusal({ kind: "account" });
    refuse(readOnly);
    expect(await apply(id)).toBe(readOnly);
    expect(journal.get(id)?.state).toBe("failed");
    refuse(undefined);
    expect(await apply(id)).toBe(readOnly);
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("keeps an approved write pending while the account does not allow changes, and posts it once it does", async () => {
    let { api, journal, attempts, submit, apply, refuse } = harness();
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
    expect(attempts.size).toBe(0);
    refuse(undefined);
    expect(await apply(id)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  // The binding memoizes its token, and Drive's batch answers 200 around a part it refuses for a
  // missing scope. A token memoized before the account allowed changes must not make a file the
  // account reaches read as out of scope, which would fail the write for good.
  it("posts a write approved under a token memoized before the account allowed changes", async () => {
    let { host, journal, submit, apply } = harness();
    let stored = "before";
    let tokens = new AccessTokenCache(
      async () => ({ token: stored, expires: new Date(Date.now() + 3_600_000) }));
    host.api = new DriveApi(opts => tokens.get(opts));
    let missingScopeBody = { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } };
    let sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      let token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
      let { pathname } = new URL(url);
      sent.push(`${token} ${pathname}`);
      let allowed = token === "after";
      if (pathname.startsWith("/batch/")) {
        return batchOfOne(allowed ? 200 : 403,
          allowed ? { id: "doc-1", capabilities: { canComment: true } } : missingScopeBody);
      }
      return allowed
        ? Response.json({
          id: "doco.posted", content: "Hi", createdTime: "2026-10-20T10:00:01.000Z",
          author: { displayName: "Me", me: true },
        })
        : Response.json(missingScopeBody, { status: 403 });
    });
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    await tokens.get();
    stored = "after";

    expect(await apply(id)).toBeNull();
    expect(journal.get(id)).toBeUndefined();
    expect(sent).toEqual([
      "before /batch/drive/v3", "after /batch/drive/v3", "after /drive/v3/files/doc-1/comments",
    ]);
  });

  // A disconnected account fails the grant's read with what its reads fail with, which names the
  // remedy: that is passed on, and is not the grant's refusal.
  it("passes on a failure of the grant's read, at queue and at apply, sending nothing", async () => {
    let failure = new Error("The Google account this connection was made with has been disconnected.");
    let gate = {
      deployment: "write" as const, access: "write" as const, scope: { kind: "account" as const },
      holdsGrant: async () => { throw failure; },
    };
    await expect(writeRefusal(gate)).rejects.toBe(failure);

    let { api, host, journal, submit, apply } = harness();
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    host.writeRefusal = () => writeRefusal(gate);
    expect(await apply(id)).toBe(failure.message);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("fails a write when the account can no longer comment on the file, sending nothing", async () => {
    for (let node of [{ id: "doc-1", canComment: false }, { id: "doc-1" }]) {
      let { api, journal, submit, apply } = harness();
      api.getScopeNodes.mockImplementation(async () => [node]);
      let id = await submit("createComment", { ...TARGET, content: "Hi" });
      expect(await apply(id)).toBe(CANNOT_COMMENT);
      expect(journal.get(id)?.state).toBe("failed");
      expect(api.createComment).not.toHaveBeenCalled();
    }
  });

  it("fails a file binding's write that names another file, asking Drive nothing", async () => {
    let { api, journal, submit, apply } = harness({ kind: "file", fileId: "doc-1" });
    let other = await submit("createComment", { ...TARGET, fileId: "doc-2", content: "Hi" });
    expect(await apply(other)).toBe(OUT_OF_SCOPE);
    expect(journal.get(other)?.state).toBe("failed");
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();

    let bound = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(bound)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("fails a folder binding's write whose saved path does not start at the bound folder", async () => {
    let { api, submit, apply } = harness({ kind: "folder", folderId: "bound-root" });
    // Every link holds and the file sits in the last folder named: only the path's start can fail.
    api.getScopeNodes.mockImplementation(async ids => ids.map(id =>
      id === "doc-1" ? file(id, ids.at(-2) ?? "none") : folder(id, "above")));
    let elsewhere = await submit("createComment", { ...TARGET, folderIds: ["other"], content: "Hi" });
    expect(await apply(elsewhere)).toBe(OUT_OF_SCOPE);
    let pathless = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(pathless)).toBe(OUT_OF_SCOPE);
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();

    let bound = await submit("createComment", { ...TARGET, folderIds: ["bound-root"], content: "Hi" });
    expect(await apply(bound)).toBeNull();
    expect(api.getScopeNodes).toHaveBeenCalledWith(["bound-root", "doc-1"]);
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("fails a folder binding's write once a saved link no longer holds, though the file is still in its folder", async () => {
    let { api, submit, apply } = harness({ kind: "folder", folderId: "bound-root" });
    let innerParent = "bound-root";
    api.getScopeNodes.mockImplementation(async ids => ids.map(id =>
      id === "bound-root" ? folder(id, "above")
      : id === "inner" ? folder(id, innerParent)
      : file(id, "inner")));
    let payload = { ...TARGET, folderIds: ["bound-root", "inner"], content: "Hi" };
    let linked = await submit("createComment", payload);
    expect(await apply(linked)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(1);

    innerParent = "elsewhere";
    let moved = await submit("createComment", payload);
    expect(await apply(moved)).toBe(OUT_OF_SCOPE);
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("fails a reply or resolve whose comment is gone, or marked deleted", async () => {
    for (let kind of ["createReply", "resolveComment"] as const) {
      for (let gone of [
        async () => { throw new DriveApiRequestError(404, "notFound"); },
        async () => live({ deleted: true }),
      ]) {
        let { api, journal, submit, apply } = harness();
        api.getComment.mockImplementation(gone);
        let id = await submit(kind, reply());
        expect(await apply(id), kind).toBe(NOT_FOUND);
        expect(journal.get(id)?.state, kind).toBe("failed");
        expect(api.createReply).not.toHaveBeenCalled();
      }
    }
  });

  it("fails a reply or resolve whose comment was edited after it was queued, anywhere in its text", async () => {
    const EDITED = "That comment was edited after this was queued. Queue it again to answer the " +
      "comment as it is now.";
    let long = `${"x".repeat(200)}tail`;
    for (let kind of ["createReply", "resolveComment"] as const) {
      for (let [queued, now] of [
        ["Is this date right?", "Is this date still right?"],
        // Past what the approval showed.
        [long, `${long}!`],
      ]) {
        let { api, journal, attempts, submit, apply } = harness();
        let parent = await commentParent(live({ content: queued }));
        api.getComment.mockResolvedValue(live({ content: now }));
        let id = await submit(kind, reply({ parent }));
        expect(await apply(id), kind).toBe(EDITED);
        expect(journal.get(id)?.state, kind).toBe("failed");
        expect(attempts.has(id), kind).toBe(false);
        expect(api.createReply).not.toHaveBeenCalled();
      }
    }

    // A changed display name is not a changed comment, and a long comment left alone still posts.
    let renamed = harness();
    renamed.api.getComment.mockResolvedValue(live({ author: { displayName: "Ada King", me: false } }));
    expect(await renamed.apply(await renamed.submit("createReply", reply()))).toBeNull();
    let unchanged = harness();
    unchanged.api.getComment.mockResolvedValue(live({ content: long }));
    let parent = await commentParent(live({ content: long }));
    expect(await unchanged.apply(await unchanged.submit("createReply", reply({ parent })))).toBeNull();

    // Gone is said before edited, and edited before resolved.
    let gone = harness();
    gone.api.getComment.mockResolvedValue(live({ content: "Other", deleted: true }));
    expect(await gone.apply(await gone.submit("createReply", reply()))).toBe(NOT_FOUND);
    let both = harness();
    both.api.getComment.mockResolvedValue(live({ content: "Other", resolved: true }));
    expect(await both.apply(await both.submit("resolveComment", reply()))).toBe(EDITED);
  });
});

describe("what a binding has queued for a comment", () => {
  const entry = (id: number, action: DriveCommentAction): JournalEntry<DriveCommentAction> =>
    ({ id, action });
  const WAITING = "That comment is waiting for approval; reply to it once it is posted.";
  const DECIDED = "That pending ID names no comment waiting for approval. If its comment was " +
    "posted, list the file's comments again and use the comment's Drive ID.";

  it("answers a pending ID by whether its comment still waits", () => {
    let pending = [
      entry(4, { kind: "createComment", payload: { ...TARGET, content: "Hi" } }),
      entry(6, { kind: "createReply", payload: reply() }),
    ];
    expect(pendingCommentRefusal("pending:4", pending)).toBe(WAITING);
    // Never issued, a queued reply's ID, and a comment since approved or rejected.
    expect(pendingCommentRefusal("pending:5", pending)).toBe(DECIDED);
    expect(pendingCommentRefusal("pending:6", pending)).toBe(DECIDED);
    expect(pendingCommentRefusal("pending:4", [])).toBe(DECIDED);
    // A queued suggested edit takes no replies at all.
    expect(pendingCommentRefusal("pending:8", [entry(8, { kind: "suggestEdit", payload: edit() })]))
      .toBe("That pending ID names a suggested edit, which takes no replies here; once it is " +
        "approved, the Doc's owner answers it in the Doc.");
  });

  it("finds a queued resolve by its file and its comment", () => {
    let resolve = { ...TARGET, commentId: "doco.c1", parent: PARENT };
    let pending = [entry(1, { kind: "resolveComment", payload: resolve })];
    expect(hasPendingResolve("doc-1", "doco.c1", pending)).toBe(true);
    expect(hasPendingResolve("doc-1", "doco.c2", pending)).toBe(false);
    expect(hasPendingResolve("doc-2", "doco.c1", pending)).toBe(false);
    expect(hasPendingResolve("doc-1", "doco.c1", [entry(1, { kind: "createReply", payload: reply() })]))
      .toBe(false);
    expect(hasPendingResolve("doc-1", "doco.c1", [])).toBe(false);
    expect(RESOLVE_PENDING).toBe(
      "That comment already has a resolve waiting for approval. To give it a closing reply, have " +
      "that resolve rejected and resolve again with the reply as the text.");
    expect(REPLY_RESOLVE_PENDING).toBe(
      "That comment has a resolve waiting for approval, and a reply posted after it would reopen " +
      "the comment. To close the comment with a reply, have that resolve rejected and resolve " +
      "again with the reply as the text; otherwise reply once the resolve is decided.");
  });
});

describe("Drive comment sends and their markers", () => {
  it("keeps a write pending when Google says the token lacks the scope, and sends it again once approved", async () => {
    let { api, journal, attempts, submit, apply } = harness();
    api.createComment.mockRejectedValueOnce(missingScope());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(attempts.has(id)).toBe(false);
    expect(journal.get(id)?.state).toBe("pending");
    expect(await apply(id)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(2);
    // No marker asked for a look.
    expect(api.listComments).not.toHaveBeenCalled();

    // A send refused for the file's own permissions is refused for good.
    let other = harness();
    other.api.createComment.mockRejectedValueOnce(viewOnly());
    let refused = await other.submit("createComment", { ...TARGET, content: "Hi" });
    expect(await other.apply(refused)).toBe(CANNOT_COMMENT);
    expect(other.journal.get(refused)?.state).toBe("failed");
    expect(other.attempts.has(refused)).toBe(false);
  });

  it("keeps a marker and says what rejecting leaves when Drive does not confirm a send", async () => {
    let { api, journal, attempts, submit, apply } = harness();
    api.createComment.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    expect(attempts.get(id)).toEqual({ at: expect.any(Number) });
    expect(journal.get(id)?.state).toBe("pending");
  });

  it("logs a send Drive did not confirm, what a look found and a post, under the comment events", async () => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let { submit, apply, keepPosts } = harness();
    keepPosts({ loseFirst: true });
    let bound = {
      component: "gatekeeper.google.drive.comments", vendorId: "google",
      actionKind: "createComment", fileId: "doc-1",
    };

    let lost = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(lost)).toBe(UNCONFIRMED_SEND);
    expect(await apply(lost)).toBeNull();
    let posted = await submit("createComment", { ...TARGET, content: "Again" });
    expect(await apply(posted)).toBeNull();

    let failed = warn.mock.calls.map(([line]) => line);
    expect(failed).toEqual([expect.objectContaining({
      ...bound, actionId: lost, event: "drive.comments.send.failed", outcome: "unknown",
      httpStatus: 503, providerReasons: ["backendError"],
    })]);
    // Nothing was known to be posted, so the line names no comment.
    expect(failed[0]).not.toHaveProperty("commentId");
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      expect.objectContaining({
        ...bound, actionId: lost, event: "drive.comments.reconciled", outcome: "found",
        commentId: "doco.posted0",
      }),
      expect.objectContaining({
        ...bound, actionId: posted, event: "drive.comments.posted", outcome: "posted",
        commentId: "doco.posted1",
      }),
    ]);
  });

  it("withdraws a write whose send may have gone", async () => {
    let { api, host, journal, attempts, submit, apply, reject } = harness();
    api.createComment.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    let markerRead = vi.spyOn(host.attempts, "get");
    await expect(reject(id)).resolves.toBeUndefined();
    expect(journal.get(id)).toBeUndefined();
    // Rejecting runs no hook of the set's: the marker is neither consulted nor dropped here.
    expect(markerRead).not.toHaveBeenCalled();
    expect(attempts.has(id)).toBe(true);
  });

  it("sends again once a send is proven empty, keeping its marker through a check that fails", async () => {
    let { api, journal, attempts, submit, apply, aged, refuse } = harness();
    api.createComment.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    let at = aged(id);
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    // The look ran, and found nothing. The marker stays as it was, so the send is counted once
    // however often the check after it fails.
    expect(api.listComments).toHaveBeenCalledTimes(1);
    expect(attempts.get(id)).toStrictEqual({ at });
    expect(journal.get(id)?.state).toBe("pending");
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(attempts.get(id)).toStrictEqual({ at });

    refuse(undefined);
    expect(await apply(id)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(2);
    // The second send's marker records the one before it.
    expect(attempts.get(id)).toStrictEqual({ at: expect.any(Number), failedSends: 1, postedId: "doco.posted" });
  });

  it("stops after three sends that posted nothing, and never sends a fourth", async () => {
    const EXHAUSTED = "Google Drive did not accept this in 3 tries, and none of them posted it, " +
      "so it won't be sent again. Reject it to clear it.";
    let { api, journal, attempts, submit, apply, reject, aged } = harness();
    api.createComment.mockRejectedValue(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    for (let sends = 1; sends <= 3; sends++) {
      expect(await apply(id)).toBe(UNCONFIRMED_SEND);
      expect(api.createComment).toHaveBeenCalledTimes(sends);
      expect(attempts.get(id)?.failedSends).toBe(sends === 1 ? undefined : sends - 1);
      aged(id);
    }
    // The third send is found to have posted nothing too: the write fails for good, unsent.
    expect(await apply(id)).toBe(EXHAUSTED);
    expect(api.createComment).toHaveBeenCalledTimes(3);
    expect(journal.get(id)?.state).toBe("failed");
    expect(attempts.has(id)).toBe(false);
    // Approving again answers the same and asks Drive nothing; denying clears it.
    let looks = api.listComments.mock.calls.length;
    expect(await apply(id)).toBe(EXHAUSTED);
    expect(api.listComments).toHaveBeenCalledTimes(looks);
    await expect(reject(id)).resolves.toBeUndefined();
    expect(journal.get(id)).toBeUndefined();

    // A rate limit is Google's answer that nothing was posted: the count starts over.
    let limited = harness();
    limited.api.createComment
      .mockRejectedValueOnce(unconfirmed())
      .mockRejectedValueOnce(new DriveApiRequestError(429))
      .mockRejectedValueOnce(unconfirmed());
    let other = await limited.submit("createComment", { ...TARGET, content: "Hi" });
    expect(await limited.apply(other)).toBe(UNCONFIRMED_SEND);
    limited.aged(other);
    expect(await limited.apply(other)).toMatch(/^Google Drive is limiting requests/);
    expect(limited.attempts.has(other)).toBe(false);
    expect(await limited.apply(other)).toBe(UNCONFIRMED_SEND);
    expect(limited.attempts.get(other)?.failedSends).toBeUndefined();
  });

  // Google lists an account that can only view a file none of its comments, its own included,
  // with no error: a look by such an account finds nothing whatever was posted.
  it("takes nothing found for proof only when the account could have seen its comment", async () => {
    const BLIND = "The connected account can no longer comment on that file, and Google Drive " +
      "shows a file's comments only to accounts that can, so whether this was posted can't be " +
      "checked, and it won't be sent again. Reject it to clear it.";
    let { api, journal, attempts, submit, apply, reject, aged, keepPosts } = harness();
    let posted = keepPosts({ loseFirst: true });
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    expect(posted).toHaveLength(1);
    // The account is made a viewer: the listing is empty, and the file says it cannot comment.
    api.listComments.mockImplementation(async () => ({ comments: [] }));
    api.getScopeNodes.mockImplementation(async ids => ids.map(nodeId => ({ id: nodeId, canComment: false })));

    // Inside the window nothing is concluded either way.
    expect(await apply(id)).toMatch(/^Google Drive may still be posting this/);
    expect(journal.get(id)?.state).toBe("pending");
    let at = aged(id);
    expect(await apply(id)).toBe(BLIND);
    expect(journal.get(id)).toMatchObject({ state: "failed", outcome: "unknown" });
    expect(attempts.get(id)).toStrictEqual({ at });
    expect(api.createComment).toHaveBeenCalledTimes(1);
    // The same answer once the right to comment is back, with nothing asked; denying clears it.
    api.getScopeNodes.mockImplementation(async ids => ids.map(nodeId => ({ id: nodeId, canComment: true })));
    let asked = api.listComments.mock.calls.length;
    expect(await apply(id)).toBe(BLIND);
    expect(api.listComments).toHaveBeenCalledTimes(asked);
    await expect(reject(id)).resolves.toBeUndefined();
    expect(journal.get(id)).toBeUndefined();

    // A file the account no longer sees at all ends the same way.
    let gone = harness();
    gone.api.createComment.mockRejectedValueOnce(unconfirmed());
    let other = await gone.submit("createComment", { ...TARGET, content: "Hi" });
    expect(await gone.apply(other)).toBe(UNCONFIRMED_SEND);
    gone.aged(other);
    gone.api.getScopeNodes.mockImplementation(async () => [undefined]);
    expect(await gone.apply(other)).toBe(BLIND);
    expect(gone.api.createComment).toHaveBeenCalledTimes(1);
  });

  it("drops the marker of a write that fails for good after its send is proven empty", async () => {
    let { api, journal, attempts, submit, apply, aged, refuse } = harness();
    api.createComment.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    aged(id);
    refuse("This Google Drive connection is read-only.");
    expect(await apply(id)).toBe("This Google Drive connection is read-only.");
    expect(journal.get(id)?.state).toBe("failed");
    expect(attempts.has(id)).toBe(false);
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  // Denying always withdraws: no state a write can be left in refuses it, whatever approving
  // answers there.
  it("withdraws a write from every state approving can leave it in", async () => {
    type Run = ReturnType<typeof harness>;
    let states: [string, (run: Run) => Promise<number>, RegExp][] = [
      ["never approved", run => run.submit("createComment", { ...TARGET, content: "Hi" }), /^$/],
      ["a send Drive did not confirm, inside its window", async run => {
        run.api.createComment.mockRejectedValueOnce(unconfirmed());
        let id = await run.submit("createComment", { ...TARGET, content: "Hi" });
        expect(await run.apply(id)).toBe(UNCONFIRMED_SEND);
        return id;
      }, /^Google Drive may still be posting this/],
      ["waiting for the account to allow changes", async run => {
        run.refuse(WRITES_GRANT_MISSING);
        let id = await run.submit("createComment", { ...TARGET, content: "Hi" });
        expect(await run.apply(id)).toBe(WRITES_GRANT_MISSING);
        return id;
      }, /^Changes need a permission/],
      ["failed for good at a check", async run => {
        run.api.getComment.mockResolvedValue(live({ content: "Is this date still right?" }));
        let id = await run.submit("createReply", reply());
        expect(await run.apply(id)).toMatch(/^That comment was edited after this was queued/);
        return id;
      }, /^That comment was edited after this was queued/],
      ["failed for good by Google's refusal", async run => {
        run.api.createComment.mockRejectedValueOnce(viewOnly());
        let id = await run.submit("createComment", { ...TARGET, content: "Hi" });
        expect(await run.apply(id)).toBe(CANNOT_COMMENT);
        return id;
      }, /^The connected account can no longer comment/],
      ["an outcome that cannot be told", async run => {
        let posted = run.keepPosts({ loseFirst: true });
        let id = await run.submit("createComment", { ...TARGET, content: "Hi" });
        expect(await run.apply(id)).toBe(UNCONFIRMED_SEND);
        posted.push({ ...posted[0]!, id: "doco.twin" });
        expect(await run.apply(id)).toMatch(/more than one identical comment/);
        return id;
      }, /more than one identical comment/],
      ["a look that could not have seen the comment", async run => {
        run.keepPosts({ loseFirst: true });
        let id = await run.submit("createComment", { ...TARGET, content: "Hi" });
        expect(await run.apply(id)).toBe(UNCONFIRMED_SEND);
        run.api.listComments.mockImplementation(async () => ({ comments: [] }));
        run.api.getScopeNodes.mockImplementation(
          async ids => ids.map(nodeId => ({ id: nodeId, canComment: false })));
        run.aged(id);
        expect(await run.apply(id)).toMatch(/whether this was posted can't be checked/);
        return id;
      }, /whether this was posted can't be checked/],
      ["an approval interrupted after its claim", async run => {
        let id = await run.submit("createComment", { ...TARGET, content: "Hi" });
        run.journal.markClaimed(id);
        return id;
      }, /./],
    ];
    for (let [name, reach, again] of states) {
      // Approving again answers as before, or waits: it never settles these on its own terms.
      let stuck = harness();
      let id = await reach(stuck);
      if (name !== "never approved" && !name.startsWith("an approval interrupted")) {
        expect(await stuck.apply(id), name).toMatch(again);
      }
      // Denying does, from the same state, and nothing is left behind for a later approval.
      let run = harness();
      id = await reach(run);
      let sends = run.api.createComment.mock.calls.length + run.api.createReply.mock.calls.length;
      await expect(run.reject(id), name).resolves.toBeUndefined();
      expect(run.journal.get(id), name).toBeUndefined();
      expect(run.journal.listPending(), name).toEqual([]);
      expect(run.api.createComment.mock.calls.length + run.api.createReply.mock.calls.length, name)
        .toBe(sends);
    }
  });

  it("binds a posted comment after a retire that did not land, without sending again", async () => {
    let kv = new FaultyKv();
    let { api, journal, attempts, submit, apply, adopt, keepPosts } = harness({ kind: "account" }, kv);
    let posted = keepPosts();
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    kv.failNextRetire = true;
    expect(await apply(id)).toBe("storage failure");
    expect(api.createComment).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    expect(journal.get(id)?.state).toBe("claimed");
    expect(attempts.has(id)).toBe(true);

    adopt(id);
    expect(await apply(id)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(1);
    // Google confirmed the send, so nothing needs a look.
    expect(api.listComments).not.toHaveBeenCalled();
    expect(journal.get(id)).toBeUndefined();
  });

  // Nathan: a confirmed send must hold even once its comment no longer looks like what was sent.
  it("never sends a confirmed write again after a retire that did not land, though its post was edited since", async () => {
    let kv = new FaultyKv();
    let { api, journal, attempts, submit, apply, adopt, aged, keepPosts } = harness({ kind: "account" }, kv);
    let posted = keepPosts();
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    kv.failNextRetire = true;
    expect(await apply(id)).toBe("storage failure");
    expect(attempts.get(id)).toMatchObject({ postedId: "doco.posted0" });
    posted[0] = { ...posted[0], content: "Hi, edited" };
    aged(id);

    adopt(id);
    expect(await apply(id)).toBeNull();
    expect(api.createComment).toHaveBeenCalledTimes(1);
    expect(api.listComments).not.toHaveBeenCalled();
    expect(journal.get(id)).toBeUndefined();

    // A reply keeps its post too.
    let replies = harness();
    let answer = await replies.submit("createReply", reply());
    expect(await replies.apply(answer)).toBeNull();
    expect(replies.attempts.get(answer)).toMatchObject({ postedId: expect.any(String) });
  });

  it("binds a found comment after a retire that did not land", async () => {
    let kv = new FaultyKv();
    let { api, journal, attempts, submit, apply, adopt, keepPosts } = harness({ kind: "account" }, kv);
    let posted = keepPosts({ loseFirst: true });
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    kv.failNextRetire = true;
    expect(await apply(id)).toBe("storage failure");
    expect(journal.get(id)?.state).toBe("claimed");
    expect(attempts.has(id)).toBe(true);

    adopt(id);
    expect(await apply(id)).toBeNull();
    expect(posted).toHaveLength(1);
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("keeps the marker of a send a look cannot tell, so it is never sent again", async () => {
    let kv = new FaultyKv();
    let { api, journal, attempts, submit, apply, adopt, keepPosts } = harness({ kind: "account" }, kv);
    let posted = keepPosts({ loseFirst: true });
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    let [first] = posted;
    if (!first) throw new Error("nothing was posted");
    posted.push({ ...first, id: "doco.twin" });
    kv.failNextFailure = true;
    expect(await apply(id)).toBe("storage failure");
    expect(journal.get(id)?.state).toBe("claimed");
    expect(attempts.has(id)).toBe(true);

    adopt(id);
    let unknown = await apply(id);
    expect(unknown).toMatch(/^The connected account has more than one identical comment/);
    expect(journal.get(id)?.state).toBe("failed");
    expect(attempts.has(id)).toBe(true);
    adopt(id);
    expect(await apply(id)).toBe(unknown);
    expect(api.createComment).toHaveBeenCalledTimes(1);

    // A send Google refused leaves no marker.
    let refused = harness();
    refused.api.createComment.mockRejectedValueOnce(viewOnly());
    let failed = await refused.submit("createComment", { ...TARGET, content: "Hi" });
    expect(await refused.apply(failed)).toBe(CANNOT_COMMENT);
    expect(refused.attempts.has(failed)).toBe(false);

    // A send that posted leaves its marker for the gatekeeper to drop.
    let sent = harness();
    let applied = await sent.submit("createComment", { ...TARGET, content: "Hi" });
    expect(await sent.apply(applied)).toBeNull();
    expect(sent.attempts.has(applied)).toBe(true);
    expect(sent.journal.get(applied)).toBeUndefined();
    expect(await sent.apply(applied)).toBeNull();
    expect(sent.api.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("Drive comment looks for an earlier send", () => {
  it("keeps a write pending, with its marker, when Google refuses the look for a missing scope", async () => {
    let { api, journal, attempts, submit, apply, keepPosts } = harness();
    let posted = keepPosts({ loseFirst: true });
    let id = await submit("createComment", { ...TARGET, content: "Looks good." });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    let marker = { ...attempts.get(id) };
    expect(marker).toEqual({ at: expect.any(Number) });

    api.listComments.mockRejectedValue(missingScope());
    expect(await apply(id)).toBe(GRANT_MISSING);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.get(id)).toEqual(marker);
    expect(await apply(id)).toBe(GRANT_MISSING);
    expect(attempts.get(id)).toEqual(marker);
    expect(api.createComment).toHaveBeenCalledTimes(1);

    api.listComments.mockImplementation(async () => ({ comments: posted }));
    expect(await apply(id)).toBeNull();
    // The look bound what the first send posted.
    expect(api.createComment).toHaveBeenCalledTimes(1);
    expect(journal.get(id)).toBeUndefined();

    // A reply whose send posted nothing.
    let other = harness();
    other.api.createReply.mockRejectedValueOnce(unconfirmed());
    let replyId = await other.submit("createReply", reply());
    expect(await other.apply(replyId)).toBe(UNCONFIRMED_SEND);
    let replyMarker = { ...other.attempts.get(replyId) };
    other.api.listReplies.mockRejectedValue(missingScope());
    expect(await other.apply(replyId)).toBe(GRANT_MISSING);
    expect(other.journal.get(replyId)?.state).toBe("pending");
    expect(other.attempts.get(replyId)).toEqual(replyMarker);
    expect(other.api.createReply).toHaveBeenCalledTimes(1);

    other.api.listReplies.mockImplementation(async () => ({ replies: [] }));
    other.aged(replyId);
    expect(await other.apply(replyId)).toBeNull();
    expect(other.api.createReply).toHaveBeenCalledTimes(2);
  });

  it("binds only a reply with the body it sent, and not a deleted one", async () => {
    let { api, submit, apply, aged } = harness();
    api.createReply.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createReply", reply({ content: "Fixed." }));
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    // Dated inside the window the look searches, so only what it compares leaves these out.
    let createdTime = new Date(aged(id) + 1000).toISOString();
    api.listReplies.mockImplementation(async () => ({ replies: [
      mine({ id: "doco.other", content: "Thanks", createdTime }),
      mine({ id: "doco.gone", content: "Fixed.", createdTime, deleted: true }),
    ] }));
    expect(await apply(id)).toBeNull();
    expect(api.listReplies).toHaveBeenCalledTimes(1);
    expect(api.createReply).toHaveBeenCalledTimes(2);
  });

  it("does not take a plain reply for a resolve it sent, nor a resolve for a plain reply", async () => {
    let payload = { ...TARGET, commentId: "doco.c1", content: "Fixed.", parent: PARENT };
    for (let [kind, stray] of [
      ["resolveComment", mine()],
      ["createReply", mine({ action: "resolve" })],
    ] as const) {
      let { api, submit, apply, aged } = harness();
      api.createReply.mockRejectedValueOnce(unconfirmed());
      let id = await submit(kind, payload);
      expect(await apply(id), kind).toBe(UNCONFIRMED_SEND);
      let createdTime = new Date(aged(id) + 1000).toISOString();
      api.listReplies.mockImplementation(async () => ({ replies: [{ ...stray, createdTime }] }));
      expect(await apply(id), kind).toBeNull();
      expect(api.listReplies, kind).toHaveBeenCalledTimes(1);
      expect(api.createReply, kind).toHaveBeenCalledTimes(2);
    }

    // The control: a resolve the look does find is bound, and nothing is sent again.
    let { api, submit, apply, aged } = harness();
    api.createReply.mockRejectedValueOnce(unconfirmed());
    let id = await submit("resolveComment", payload);
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    let createdTime = new Date(aged(id) + 1000).toISOString();
    api.listReplies.mockImplementation(async () => ({
      replies: [mine({ action: "resolve", createdTime })],
    }));
    expect(await apply(id)).toBeNull();
    expect(api.createReply).toHaveBeenCalledTimes(1);
  });

  it("ends as of unknown outcome when the file is no longer visible to look through, and only then", async () => {
    for (let gone of [new DriveApiRequestError(404, "notFound"), viewOnly()]) {
      let { api, journal, attempts, submit, apply } = harness();
      api.createComment.mockRejectedValueOnce(unconfirmed());
      let id = await submit("createComment", { ...TARGET, content: "Hi" });
      expect(await apply(id)).toBe(UNCONFIRMED_SEND);
      api.listComments.mockRejectedValue(gone);
      expect(await apply(id), gone.reason).toBe(NOT_VISIBLE);
      expect(journal.get(id)?.state, gone.reason).toBe("failed");
      expect(attempts.has(id), gone.reason).toBe(true);

      api.listComments.mockImplementation(async () => ({ comments: [] }));
      expect(await apply(id), gone.reason).toBe(NOT_VISIBLE);
      expect(api.listComments).toHaveBeenCalledTimes(1);
      expect(api.createComment).toHaveBeenCalledTimes(1);
    }

    // A look that fails any other way decides nothing.
    let { api, journal, attempts, submit, apply } = harness();
    api.createComment.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    api.listComments.mockRejectedValueOnce(new DriveApiRequestError(500, "backendError"));
    expect(await apply(id)).toMatch(/500/);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("Drive comment listings", () => {
  it("shows a queued comment on the last page only, and says when it quotes the document", () => {
    let payload = { ...TARGET, content: "Why?", anchor: { tabId: "t.0", text: "May" } };
    let pending: JournalEntry<DriveCommentAction>[] =
      [{ id: 4, action: { kind: "createComment", payload } }];
    expect(overlayPending("doc-1", [], pending, true))
      .toEqual({ comments: [pendingComment(4, payload)], quotesDocument: true });
    // The queued comment shows the text it is attached to, as a posted one does.
    expect(pendingComment(4, payload).quotedText).toBe("May");
    // A queued suggested edit is not a comment, and Drive lists none: it is not shown.
    expect(overlayPending("doc-1", [], [{ id: 7, action: { kind: "suggestEdit", payload: edit() } }], true))
      .toEqual({ comments: [], quotesDocument: false });
    expect(overlayPending("doc-1", [], pending, false))
      .toEqual({ comments: [], quotesDocument: false });
    expect(overlayPending("doc-2", [], pending, true))
      .toEqual({ comments: [], quotesDocument: false });

    let plain = { ...TARGET, content: "Why?" };
    expect(overlayPending(
      "doc-1", [], [{ id: 5, action: { kind: "createComment", payload: plain } }], true,
    )).toEqual({ comments: [pendingComment(5, plain)], quotesDocument: false });
  });

  it("shows a queued reply under its comment on whichever page holds it", () => {
    let action = { kind: "createReply" as const, payload: reply({ commentId: "c1" }) };
    let shown = overlayPending(
      "doc-1", [toDriveComment(live({ id: "c1" }))], [{ id: 6, action }], false);
    expect(shown.comments).toHaveLength(1);
    expect(shown.comments[0]?.replies.at(-1)).toEqual(pendingReply(6, action));
    expect(shown.quotesDocument).toBe(false);
  });

  it("reads only the comment writes among what is queued", () => {
    let answer = { kind: "createReply" as const, payload: reply({ commentId: "c1" }) };
    let comment = { kind: "createComment" as const, payload: { ...TARGET, content: "Why?" } };
    // A sharing change or a move knows nothing of comments: whatever its payload holds, it is not
    // read as one, and neither is a kind that only an object's prototype names.
    let other = { ...TARGET, commentId: "c1", content: "Not a comment." };
    let pending: QueuedWrite[] = [
      { id: 1, action: { kind: "createPermission", payload: other } },
      { id: 2, action: answer },
      { id: 3, action: { kind: "deletePermission", payload: other } },
      { id: 4, action: comment },
      { id: 5, action: { kind: "moveFile", payload: other } },
      { id: 6, action: { kind: "toString", payload: other } },
    ];
    expect(commentEntries(pending))
      .toEqual([{ id: 2, action: answer }, { id: 4, action: comment }]);

    let c1 = toDriveComment(live({ id: "c1" }));
    expect(overlayPending("doc-1", [c1], pending, true)).toEqual({
      comments: [
        { ...c1, replies: [pendingReply(2, answer)] }, pendingComment(4, comment.payload),
      ],
      quotesDocument: false,
    });
    expect(overlayPending("doc-2", [c1], pending, true))
      .toEqual({ comments: [c1], quotesDocument: false });
  });

  it("maps a Drive comment to what a listing shows: dates, the passage, and no deleted reply", () => {
    expect(toDriveComment(live({
      quotedText: "The launch is in May.",
      modifiedTime: "2026-10-20T11:00:00.000Z",
      replies: [
        mine({ id: "doco.gone", content: "", deleted: true }),
        mine({ id: "doco.kept", action: "resolve" }),
      ],
    }))).toEqual({
      id: "doco.c1", author: { displayName: "Ada Lovelace", me: false }, text: "Is this date right?",
      quotedText: "The launch is in May.",
      createdTime: new Date("2026-10-20T09:00:00.000Z"),
      modifiedTime: new Date("2026-10-20T11:00:00.000Z"),
      resolved: false,
      replies: [{
        id: "doco.kept", author: { displayName: "Me", me: true }, text: "Fixed.",
        createdTime: new Date("2026-10-20T10:00:01.000Z"), action: "resolve",
      }],
    });
    expect(toDriveComment(live())).not.toHaveProperty("quotedText");

    expect(() => toDriveComment(live({ createdTime: "soon" })))
      .toThrow("Google Drive returned an invalid comment time");
    expect(() => toDriveComment(live({ replies: [mine({ createdTime: "soon" })] })))
      .toThrow("Google Drive returned an invalid comment time");
    // A modification time is validated as a creation time is, on a comment and on a reply.
    expect(() => toDriveComment(live({ modifiedTime: "soon" })))
      .toThrow("Google Drive returned an invalid comment time");
    expect(() => toDriveComment(live({ replies: [mine({ modifiedTime: "soon" })] })))
      .toThrow("Google Drive returned an invalid comment time");
    let edited = toDriveComment(live({
      replies: [mine({ modifiedTime: "2026-10-20T10:30:00.000Z" })],
    }));
    expect(edited.replies[0]?.modifiedTime).toEqual(new Date("2026-10-20T10:30:00.000Z"));

    // A pending item's time is its payload's.
    let payload = { ...TARGET, content: "Why?" };
    expect(pendingComment(7, payload).createdTime).toEqual(new Date(payload.queuedAt));
    let action = { kind: "createReply" as const, payload: reply() };
    expect(pendingReply(8, action).createdTime).toEqual(new Date(action.payload.queuedAt));
  });
});

describe("comments that quote a Doc, and suggested edits, through the Docs API", () => {
  const QUOTE_GONE = "The quoted text is no longer in the Doc exactly once, so this can't be " +
    "attached to it. Queue it again with text the Doc has now.";
  const DOC_CHANGED = "The Google Doc changed while this was being sent, so nothing was " +
    "posted. Approve it again to place it on the Doc as it is now.";
  const UNCONFIRMED_SUGGESTION = "Google Docs did not confirm whether this was posted, and it may " +
    "have been. Approving it again first checks the file's suggestions, so it is not posted " +
    "twice; rejecting it leaves anything already posted on the file.";
  // "Costs are final" starts at offset 22 of the text, which starts at index 1.
  const COSTS: DocsRange = { startIndex: 23, endIndex: 38, tabId: "t.0" };
  const MAY: DocsRange = { startIndex: 18, endIndex: 21, tabId: "t.0" };

  it("shows a comment's quoted text and tab, and a suggestion's change, as fields", async () => {
    let anchored = await harness().card("createComment", { ...ANCHORED, fileName: "Plan" });
    expect(anchored).toMatchObject({ autoApprovable: true, actionKind: KIND, implementsRevert: false });
    expect(anchored.title).toBe("Comment on a Google Drive file");
    expect(anchored.description).toBe("Post a comment on Google Doc `doc-1` as the connected " +
      "account, attached to the quoted text. Google emails the file's owner about new comments.");
    expect(anchored.fields).toEqual([
      { label: "Comment", kind: "text", value: "Are they?" },
      { label: "Quoted text", kind: "text", value: "Costs are final" },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "File name", kind: "inline", value: "Plan" },
      { label: "Tab", kind: "inline", value: "t.0" },
    ]);

    let replace = await harness().card("suggestEdit", edit({ note: "It moved." }));
    expect(replace).toMatchObject({ autoApprovable: true, actionKind: KIND, implementsRevert: false });
    expect(replace.title).toBe("Suggest an edit in a Google Doc");
    expect(replace.description).toBe("Suggest replacing text in Google Doc `doc-1` as the " +
      "connected account. It is a suggestion: the Doc's text does not change unless someone who " +
      "can edit it accepts it. The note is posted as a reply on the suggestion.");
    expect(replace.fields).toEqual([
      { label: "Replace", kind: "text", value: "May" },
      { label: "With", kind: "text", value: "June" },
      { label: "Note", kind: "text", value: "It moved." },
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Tab", kind: "inline", value: "t.0" },
    ]);
    expect(replace.descriptionIsComplete).toBe(true);

    let deletion = await harness().card("suggestEdit", edit({ newText: "" }));
    expect(deletion.description).toMatch(/^Suggest deleting text in Google Doc `doc-1`/);
    expect(deletion.fields?.slice(0, 2)).toEqual([
      { label: "Delete", kind: "text", value: "May" },
      { label: "File", kind: "inline", value: "doc-1" },
    ]);
  });

  it("attaches a quoting comment to the quoted text found at approval, on the revision read then", async () => {
    let { api, docs, attempts, submit, apply } = harness();
    let id = await submit("createComment", ANCHORED);
    expect(await apply(id)).toBeNull();
    expect(docs.insertComment).toHaveBeenCalledWith("doc-1", "Are they?", COSTS, "rev-1");
    expect(api.createComment).not.toHaveBeenCalled();
    expect(attempts.get(id)).toEqual({ at: expect.any(Number), postedId: "doco.anchored" });

    // A plain comment still goes through Drive.
    let plain = harness();
    expect(await plain.apply(await plain.submit("createComment", { ...TARGET, content: "Hi" }))).toBeNull();
    expect(plain.api.createComment).toHaveBeenCalledWith("doc-1", "Hi");
    expect(plain.docs.getDocumentWithSuggestions).not.toHaveBeenCalled();
  });

  it("fails for good, sending nothing, when the quoted text is no longer there exactly once", async () => {
    for (let text of ["The launch is in June. Costs moved.\n", "May. May.\n"]) {
      let { doc, docs, journal, attempts, submit, apply } = harness();
      let id = await submit("suggestEdit", edit());
      doc.current = docOf(text);
      expect(await apply(id)).toBe(QUOTE_GONE);
      expect(journal.get(id)?.state).toBe("failed");
      expect(attempts.has(id)).toBe(false);
      expect(docs.suggest).not.toHaveBeenCalled();
    }
    // A tab that is gone, too.
    let run = harness();
    let id = await run.submit("createComment", { ...ANCHORED, anchor: { tabId: "t.9", text: "Costs" } });
    expect(await run.apply(id)).toBe(QUOTE_GONE);
    expect(run.docs.insertComment).not.toHaveBeenCalled();
  });

  // clanky: Docs refuses a stale token before it acts, so nothing is in doubt and the write is
  // sent at once on its next approval, with no look and no window to wait out.
  it("keeps a send Docs answered 401 pending, with no marker, and sends it once on the next approval", async () => {
    for (let kind of ["createComment", "suggestEdit"] as const) {
      let { docs, journal, attempts, submit, apply } = harness();
      let sendOf = kind === "createComment" ? docs.insertComment : docs.suggest;
      sendOf.mockRejectedValueOnce(docsRefused("UNAUTHENTICATED"));
      let id = kind === "createComment" ? await submit(kind, ANCHORED) : await submit(kind, edit());
      expect(await apply(id), kind).toBe(CREDENTIALS_NOT_ACCEPTED);
      expect(journal.get(id)?.state, kind).toBe("pending");
      expect(attempts.has(id), kind).toBe(false);
      expect(await apply(id), kind).toBeNull();
      expect(sendOf, kind).toHaveBeenCalledTimes(2);
    }
  });

  // clanky: a send through Docs names Docs when it is rate limited.
  it("says Google Docs is limiting requests when a send through it is rate limited", async () => {
    let { docs, journal, attempts, submit, apply } = harness();
    docs.insertComment.mockRejectedValueOnce(docsRefused("RESOURCE_EXHAUSTED"));
    let id = await submit("createComment", ANCHORED);
    expect(await apply(id))
      .toBe("Google Docs is limiting requests from this account. Approve it again in a minute.");
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(false);
  });

  it("is refused by a revision that moved after the read, and placed on the Doc as it is when approved again", async () => {
    let { doc, docs, journal, attempts, submit, apply } = harness();
    docs.insertComment.mockImplementationOnce(async () => {
      doc.current = docOf(`New. ${DOC_TEXT}`, "rev-2");
      throw docsRefused();
    });
    let id = await submit("createComment", ANCHORED);
    expect(await apply(id)).toBe(DOC_CHANGED);
    expect(journal.get(id)?.state).toBe("pending");
    // Nothing was posted, so nothing needs a look.
    expect(attempts.has(id)).toBe(false);
    expect(await apply(id)).toBeNull();
    expect(docs.insertComment).toHaveBeenLastCalledWith("doc-1", "Are they?",
      { startIndex: 28, endIndex: 43, tabId: "t.0" }, "rev-2");

    // The same refusal on a revision that did not move is Docs refusing the write itself.
    let other = harness();
    other.docs.suggest.mockRejectedValueOnce(docsRefused());
    let refused = await other.submit("suggestEdit", edit());
    expect(await other.apply(refused)).toBe("Google Docs refused this [INVALID_ARGUMENT].");
    expect(other.journal.get(refused)?.state).toBe("failed");
    // So is a commenter's refusal for the file, which Docs answers as permission denied.
    let viewer = harness();
    viewer.docs.suggest.mockRejectedValueOnce(docsRefused("PERMISSION_DENIED"));
    expect(await viewer.apply(await viewer.submit("suggestEdit", edit()))).toBe(CANNOT_COMMENT);
  });

  it("fails a suggestion for good, sending nothing, once the account can no longer comment", async () => {
    let { api, docs, submit, apply } = harness();
    api.getScopeNodes.mockImplementation(async ids => ids.map(id => ({ id, canComment: false })));
    expect(await apply(await submit("suggestEdit", edit()))).toBe(CANNOT_COMMENT);
    expect(docs.getDocumentWithSuggestions).not.toHaveBeenCalled();
    expect(docs.suggest).not.toHaveBeenCalled();
  });

  // Nathan: the file may leave the scope while the Doc is read, so it is asked again before a send.
  it("sends nothing placed through Docs once the file left the scope during the Doc's read", async () => {
    for (let payload of [ANCHORED, edit()]) {
      let { api, docs, journal, attempts, submit, apply } =
        harness({ kind: "folder", folderId: "bound-root" });
      let parent = "bound-root";
      api.getScopeNodes.mockImplementation(async ids => ids.map(id =>
        id === "bound-root" ? folder(id, "above") : file(id, parent)));
      let id = "anchor" in payload
        ? await submit("createComment", { ...payload, folderIds: ["bound-root"] })
        : await submit("suggestEdit", { ...payload, folderIds: ["bound-root"] });
      docs.getDocumentWithSuggestions.mockImplementationOnce(async () => {
        parent = "elsewhere";
        return { document: docOf(DOC_TEXT), suggestions: [] };
      });
      expect(await apply(id)).toBe(OUT_OF_SCOPE);
      expect(journal.get(id)?.state).toBe("failed");
      expect(attempts.has(id)).toBe(false);
      expect(docs.insertComment).not.toHaveBeenCalled();
      expect(docs.suggest).not.toHaveBeenCalled();
    }
  });

  it("binds a quoting comment an unconfirmed send posted, found on Drive, without sending again", async () => {
    let { api, docs, submit, apply, aged } = harness();
    docs.insertComment.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    let id = await submit("createComment", ANCHORED);
    expect(await apply(id)).toBe(UNCONFIRMED_SEND.replace("Google Drive", "Google Docs"));
    let at = aged(id);
    // Drive lists a comment made through Docs under its ID, with the content sent.
    api.listComments.mockResolvedValue({ comments: [live({
      id: "doco.anchored", content: "Are they?", author: { displayName: "Me", me: true },
      createdTime: new Date(at + 1000).toISOString(),
    })] });
    expect(await apply(id)).toBeNull();
    expect(docs.insertComment).toHaveBeenCalledTimes(1);
  });

  it("makes a suggestion as one delete and insert in SUGGEST mode, then posts its note on it", async () => {
    let { docs, attempts, submit, apply } = harness();
    let id = await submit("suggestEdit", edit({ note: "It moved." }));
    expect(await apply(id)).toBeNull();
    expect(docs.suggest).toHaveBeenCalledWith("doc-1", [
      { deleteContentRange: { range: MAY } },
      { insertText: { location: { index: 18, tabId: "t.0" }, text: "June" } },
    ], "rev-1");
    expect(docs.replyToSuggestion).toHaveBeenCalledWith("doc-1", "suggest.s1", "It moved.");
    expect(attempts.get(id)).toMatchObject({ suggestionId: "suggest.s1", postedId: "suggest.s1" });

    let deletion = harness();
    expect(await deletion.apply(await deletion.submit("suggestEdit", edit({ newText: "" })))).toBeNull();
    expect(deletion.docs.suggest).toHaveBeenCalledWith("doc-1",
      [{ deleteContentRange: { range: MAY } }], "rev-1");
    expect(deletion.docs.replyToSuggestion).not.toHaveBeenCalled();
    expect(suggestionSummary(edit({ newText: "" }))).toBe("Delete: “May”");
    expect(suggestionSummary(edit())).toBe("Replace: “May” with “June”");
  });

  it("looks for a suggestion an unconfirmed send made before it sends again, and posts the note once", async () => {
    let run = harness();
    run.keepSuggestions({ loseFirst: "suggestion" });
    // One of the account's suggestions was already in the Doc: it is not this send's.
    run.doc.suggestions.push(suggestion({ suggestionId: "suggest.old" }));
    let id = await run.submit("suggestEdit", edit({ note: "It moved." }));
    expect(await run.apply(id)).toBe(UNCONFIRMED_SUGGESTION);
    expect(run.attempts.get(id)).toEqual({ at: expect.any(Number), existing: ["suggest.old"] });
    expect(await run.apply(id)).toBeNull();
    expect(run.docs.suggest).toHaveBeenCalledTimes(1);
    expect(run.docs.replyToSuggestion).toHaveBeenCalledWith("doc-1", "suggest.s2", "It moved.");
    expect(run.doc.suggestions.map(({ suggestionId }) => suggestionId)).toEqual(["suggest.old", "suggest.s2"]);

    // Found nothing inside the window: it waits, never sends.
    let waiting = harness();
    waiting.docs.suggest.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    let pending = await waiting.submit("suggestEdit", edit());
    expect(await waiting.apply(pending)).toBe(UNCONFIRMED_SUGGESTION);
    expect(await waiting.apply(pending)).toMatch(/^Google Docs may still be posting this/);
    expect(waiting.docs.suggest).toHaveBeenCalledTimes(1);
    // Found nothing once the window closed: that send made nothing, so it is sent again.
    waiting.aged(pending);
    expect(await waiting.apply(pending)).toBeNull();
    expect(waiting.docs.suggest).toHaveBeenCalledTimes(2);
  });

  // bonk: a look that finds the suggestion and then stops short of its note must keep what it
  // found, or a later look that no longer finds it (accepted or rejected meanwhile) sends it again.
  it("keeps a suggestion a look found before its note, so it is never made again", async () => {
    let run = harness();
    run.keepSuggestions({ loseFirst: "suggestion" });
    let id = await run.submit("suggestEdit", edit({ note: "It moved." }));
    expect(await run.apply(id)).toBe(UNCONFIRMED_SUGGESTION);
    run.refuse(WRITES_GRANT_MISSING);
    expect(await run.apply(id)).toBe(GRANT_MISSING);
    expect(run.attempts.get(id)).toMatchObject({ suggestionId: "suggest.s1" });
    // Decided in the Doc before the next approval, well after the send's window.
    run.doc.suggestions.length = 0;
    run.aged(id);
    run.refuse(undefined);
    await run.apply(id);
    expect(run.docs.suggest).toHaveBeenCalledTimes(1);
  });

  it("ends as of unknown outcome when the account's suggestions from the send can't be told apart", async () => {
    let { doc, docs, journal, submit, apply } = harness();
    docs.suggest.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    let id = await submit("suggestEdit", edit());
    expect(await apply(id)).toBe(UNCONFIRMED_SUGGESTION);
    doc.suggestions.push(suggestion({ suggestionId: "suggest.other", summaryText: "Add: “x”" }));
    expect(await apply(id)).toMatch(/suggestions in this Doc around when this was sent that can't be told apart/);
    expect(journal.get(id)?.state).toBe("failed");
    expect(docs.suggest).toHaveBeenCalledTimes(1);
  });

  // Nathan: Google may make the suggestion and still not save its thread.
  it("keeps a suggestion Google made without saving its thread, and fails only its note", async () => {
    let { docs, journal, attempts, submit, apply } = harness();
    docs.suggest.mockResolvedValue({ id: "suggest.s1", threadSaved: false });
    let id = await submit("suggestEdit", edit({ note: "It moved." }));
    expect(await apply(id)).toBe("The suggestion was made, but Google Docs did not save its " +
      "thread, so its note can't be posted.");
    expect(journal.get(id)?.state).toBe("failed");
    expect(attempts.get(id)).toMatchObject({ suggestionId: "suggest.s1" });
    expect(docs.replyToSuggestion).not.toHaveBeenCalled();

    // Without a note there is nothing left to post.
    let bare = harness();
    bare.docs.suggest.mockResolvedValue({ id: "suggest.s1", threadSaved: false });
    expect(await bare.apply(await bare.submit("suggestEdit", edit()))).toBeNull();
    expect(bare.docs.suggest).toHaveBeenCalledTimes(1);
  });

  // bonk: a note Google confirmed must hold even once the note no longer reads as it was sent.
  it("never posts a confirmed note again after a retire that did not land, though the note was edited since", async () => {
    let kv = new FaultyKv();
    let run = harness({ kind: "account" }, kv);
    run.keepSuggestions();
    let id = await run.submit("suggestEdit", edit({ note: "It moved." }));
    kv.failNextRetire = true;
    expect(await run.apply(id)).toBe("storage failure");
    expect(run.attempts.get(id)).toMatchObject({ suggestionId: "suggest.s1", postedId: "suggest.s1" });
    run.doc.suggestions[0].replies[0].content = "It moved to June.";
    let long = Date.now() - 10 * 60_000;
    run.attempts.set(id, { ...run.attempts.get(id)!, at: long, noteAt: long });

    run.adopt(id);
    expect(await run.apply(id)).toBeNull();
    expect(run.docs.suggest).toHaveBeenCalledTimes(1);
    expect(run.docs.replyToSuggestion).toHaveBeenCalledTimes(1);
    expect(run.journal.get(id)).toBeUndefined();
  });

  it("never makes a suggestion twice when only its note is left to post", async () => {
    let run = harness();
    run.keepSuggestions({ loseFirst: "note" });
    let id = await run.submit("suggestEdit", edit({ note: "It moved." }));
    expect(await run.apply(id)).toMatch(/^The suggestion was made, but Google Docs did not confirm whether its note/);
    // The note landed: the look finds it, and nothing is sent again.
    expect(await run.apply(id)).toBeNull();
    expect(run.docs.suggest).toHaveBeenCalledTimes(1);
    expect(run.docs.replyToSuggestion).toHaveBeenCalledTimes(1);

    // A note that did not land waits out its window, then is sent again; the suggestion is not.
    let lost = harness();
    lost.keepSuggestions();
    lost.docs.replyToSuggestion.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    let other = await lost.submit("suggestEdit", edit({ note: "It moved." }));
    expect(await lost.apply(other)).toMatch(/^The suggestion was made/);
    expect(await lost.apply(other)).toMatch(/^Google Docs may still be posting this/);
    lost.attempts.set(other, { ...lost.attempts.get(other)!, noteAt: Date.now() - 10 * 60_000 });
    expect(await lost.apply(other)).toBeNull();
    expect(lost.docs.suggest).toHaveBeenCalledTimes(1);
    expect(lost.docs.replyToSuggestion).toHaveBeenCalledTimes(2);
 
    // A suggestion the Doc no longer shows, once decided there, is never made again, however
    // long ago it was sent: its note's outcome can't be told.
    let decided = harness();
    decided.keepSuggestions({ loseFirst: "note" });
    let third = await decided.submit("suggestEdit", edit({ note: "It moved." }));
    expect(await decided.apply(third)).toMatch(/^The suggestion was made/);
    decided.doc.suggestions.length = 0;
    let old = Date.now() - 10 * 60_000;
    decided.attempts.set(third, { ...decided.attempts.get(third)!, at: old, noteAt: old });
    expect(await decided.apply(third)).toMatch(/^The suggestion was made, and the Doc no longer shows it/);
    expect(decided.docs.suggest).toHaveBeenCalledTimes(1);
    expect(decided.journal.get(third)?.state).toBe("failed");
  });

  it("withdraws a suggested edit from every state approving can leave it in", async () => {
    type Run = ReturnType<typeof harness>;
    let states: [string, (run: Run) => Promise<number>][] = [
      ["never approved", run => run.submit("suggestEdit", edit())],
      ["a send Docs did not confirm", async run => {
        run.docs.suggest.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
        let id = await run.submit("suggestEdit", edit());
        expect(await run.apply(id)).toBe(UNCONFIRMED_SUGGESTION);
        return id;
      }],
      ["refused by a revision that moved", async run => {
        run.docs.suggest.mockImplementationOnce(async () => {
          run.doc.current = docOf(DOC_TEXT, "rev-2");
          throw docsRefused();
        });
        let id = await run.submit("suggestEdit", edit());
        expect(await run.apply(id)).toBe(DOC_CHANGED);
        return id;
      }],
      ["made, with its note unconfirmed", async run => {
        run.keepSuggestions({ loseFirst: "note" });
        let id = await run.submit("suggestEdit", edit({ note: "It moved." }));
        expect(await run.apply(id)).toMatch(/^The suggestion was made/);
        return id;
      }],
      ["failed for good with its text gone", async run => {
        let id = await run.submit("suggestEdit", edit());
        run.doc.current = docOf("Nothing here.\n");
        expect(await run.apply(id)).toBe(QUOTE_GONE);
        return id;
      }],
      ["an approval interrupted after its claim", async run => {
        let id = await run.submit("suggestEdit", edit());
        run.journal.markClaimed(id);
        return id;
      }],
    ];
    for (let [name, reach] of states) {
      let run = harness();
      let id = await reach(run);
      let sends = run.docs.suggest.mock.calls.length + run.docs.replyToSuggestion.mock.calls.length;
      await expect(run.reject(id), name).resolves.toBeUndefined();
      expect(run.journal.get(id), name).toBeUndefined();
      expect(run.journal.listPending(), name).toEqual([]);
      expect(run.docs.suggest.mock.calls.length + run.docs.replyToSuggestion.mock.calls.length, name)
        .toBe(sends);
    }
  });

  it("returns a queued suggested edit as the session shows it", () => {
    expect(pendingSuggestion(3, edit({ note: "It moved." }))).toEqual({
      id: "pending:3", tabId: "t.0", oldText: "May", newText: "June", note: "It moved.",
      createdTime: new Date(TARGET.queuedAt), pending: true,
    });
    expect(pendingSuggestion(3, edit())).not.toHaveProperty("note");
  });
});

describe("how a Docs write failed", () => {
  it("tells a refusal, a rate limit and an unanswered send apart", async () => {
    let { docsWriteFailure } = await import("../src/docs-api");
    expect(docsWriteFailure(docsRefused())).toBe("absent");
    expect(docsWriteFailure(docsRefused("PERMISSION_DENIED"))).toBe("absent");
    expect(docsWriteFailure(docsRefused("RESOURCE_EXHAUSTED"))).toBe("rateLimited");
    expect(docsWriteFailure(new GoogleApiError("x", "PERMISSION_DENIED", ["RATE_LIMIT_EXCEEDED"])))
      .toBe("rateLimited");
    expect(docsWriteFailure(docsRefused("INTERNAL"))).toBe("unknown");
    expect(docsWriteFailure(new GoogleApiError("x", undefined))).toBe("unknown");
    expect(docsWriteFailure(new Error("The operation was aborted due to timeout"))).toBe("unknown");
  });
});

describe("Docs writes, held to what Google answers", () => {
  const NOT_SAVED = "Google Docs answered that it did not save this comment, so nothing was " +
    "posted. Approve it again to post it.";

  it("keeps a comment Docs did not save pending, and posts it when approved again", async () => {
    let { DocsCommentNotSavedError } = await import("../src/docs-api");
    let { docs, journal, attempts, submit, apply } = harness();
    docs.insertComment.mockRejectedValueOnce(new DocsCommentNotSavedError("x"));
    let id = await submit("createComment", ANCHORED);
    expect(await apply(id)).toBe(NOT_SAVED);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(false);
    expect(await apply(id)).toBeNull();
    expect(docs.insertComment).toHaveBeenCalledTimes(2);
  });

  it("keeps a note Docs did not save to post again, never the suggestion", async () => {
    let { DocsCommentNotSavedError } = await import("../src/docs-api");
    let { docs, attempts, submit, apply } = harness();
    docs.replyToSuggestion.mockRejectedValueOnce(new DocsCommentNotSavedError("x"));
    let id = await submit("suggestEdit", edit({ note: "It moved." }));
    expect(await apply(id)).toBe("The suggestion was made, but Google Docs did not save its " +
      "note. Approve it again to post the note.");
    expect(attempts.get(id)).toEqual({ at: expect.any(Number), suggestionId: "suggest.s1" });
    expect(await apply(id)).toBeNull();
    expect(docs.suggest).toHaveBeenCalledTimes(1);
    expect(docs.replyToSuggestion).toHaveBeenCalledTimes(2);
  });

  it("checks the binding again before a note left to post is sent", async () => {
    let { api, docs, journal, submit, apply, refuse } = harness();
    docs.replyToSuggestion.mockRejectedValueOnce(docsRefused("RESOURCE_EXHAUSTED"));
    let id = await submit("suggestEdit", edit({ note: "It moved." }));
    expect(await apply(id)).toMatch(/limiting requests/);
    // The grant was withdrawn: the note waits, sent nowhere.
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(docs.replyToSuggestion).toHaveBeenCalledTimes(1);
    // The account can no longer comment: the note fails for good, and says the suggestion stands.
    refuse(undefined);
    api.getScopeNodes.mockImplementation(async ids => ids.map(nodeId => ({ id: nodeId, canComment: false })));
    expect(await apply(id)).toBe("The suggestion was made, but its note was not posted: The " +
      "connected account can no longer comment on that file.");
    expect(journal.get(id)?.state).toBe("failed");
    expect(docs.suggest).toHaveBeenCalledTimes(1);
    expect(docs.replyToSuggestion).toHaveBeenCalledTimes(1);
  });

  it("sends no positional write without the revision it was placed on", async () => {
    let { doc, docs, journal, submit, apply } = harness();
    let id = await submit("suggestEdit", edit());
    doc.current = { ...docOf(DOC_TEXT), revisionId: undefined };
    expect(await apply(id)).toBe("Google Docs did not give the connected account the Doc's " +
      "revision, so the quoted text can't be held in place while this is sent.");
    expect(journal.get(id)?.state).toBe("failed");
    expect(docs.suggest).not.toHaveBeenCalled();
  });
});
