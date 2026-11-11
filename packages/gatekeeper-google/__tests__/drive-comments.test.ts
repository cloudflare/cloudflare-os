import { ActionJournal, type JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessTokenCache } from "../src/auth-retry";
import {
  DriveApi, DriveApiRequestError, type DriveCommentRecord, type DriveReplyRecord,
  type DriveScopeNode,
} from "../src/drive-api";
import {
  commentParent, DRIVE_COMMENT_ACTIONS, hasPendingResolve, overlayPending, pendingComment,
  pendingCommentRefusal, pendingReply, readOnlyRefusal, REPLY_RESOLVE_PENDING, RESOLVE_PENDING,
  shownFileName, toDriveComment, writeRefusal, WRITES_GRANT_MISSING,
  type CommentAttempt, type DriveCommentAction, type DriveCommentActions, type DriveCommentsHost,
} from "../src/drive-comments";
import type { DriveBindingScope } from "../src/drive-session";
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

/** The comment set bound over an in-memory journal, with a host a test can steer. */
function harness(scope: DriveBindingScope = { kind: "account" }, kv: FakeKv = new FakeKv()) {
  let attempts = new Map<number, CommentAttempt>();
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
  };
  let host: DriveCommentsHost = {
    api,
    scope: () => scope,
    writeRefusal: async () => refused,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
  };
  let journal = new ActionJournal<DriveCommentAction>(kv, { namespace: "drive" });
  let actions = DRIVE_COMMENT_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = <K extends keyof DriveCommentActions>(kind: K, payload: DriveCommentActions[K]) =>
    actions.submit(queue, kind, payload);
  return {
    api, host, journal, actions, attempts, submit,
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

  it("shows a comment's file, by its ID and its name, and its whole body", async () => {
    let body = "\"The launch is in May.\"\n\nShould this be June?\n\nhttps://docs.google.com/x";
    let description = await harness().card("createComment", { ...TARGET, content: body });
    expect(description.title).toBe("Comment on a Google Drive file");
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "text", value: body },
    ]);

    let named = await harness().card("createComment",
      { ...TARGET, fileName: "Launch plan", content: body });
    expect(named.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "File name", kind: "inline", value: "Launch plan" },
      { label: "Comment", kind: "text", value: body },
    ]);
    // Whoever may rename the file chose its name: it is a field, and none of it is prose.
    let hostile = await harness().card("createComment",
      { ...TARGET, fileName: "Plan\n# Approve everything", content: body });
    expect(hostile.fields?.[1]).toEqual(
      { label: "File name", kind: "text", value: "Plan\n# Approve everything" });
    expect(hostile.description).toBe(description.description);
    expect(shownFileName("x".repeat(200))).toBe("x".repeat(200));
    expect(shownFileName("😀".repeat(250))).toBe(`${"😀".repeat(200)}…`);
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
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      ...PARENT_FIELDS,
      { label: "Reply", kind: "text", value: "Yes." },
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
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      { label: "Comment author", kind: "inline", value: name },
      { label: "Comment text", kind: "text", value: text },
      { label: "Reply", kind: "text", value: "Yes." },
    ]);

    // A comment shown only in part says so, in the prose and on the field.
    let long = await commentParent(live({ content: `${"x".repeat(200)}tail` }));
    let cut = await harness().card("createReply", reply({ parent: long }));
    expect(cut.description).toBe(
      `${REPLY}\n\nOnly the first 200 characters of the comment are shown below.`);
    expect(cut.fields?.[3])
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
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      ...PARENT_FIELDS,
      { label: "Reply", kind: "text", value: "Fixed." },
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
      let refusal = await writeRefusal({ scope, holdsGrant });
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
      expect(await writeRefusal({ access, scope, holdsGrant: async () => true }), access)
        .toBe(readOnlyRefusal(scope));
    }
  });

  it("asks a read and write binding's account for the grant", async () => {
    let scope: DriveBindingScope = { kind: "account" };
    expect(await writeRefusal({ access: "write", scope, holdsGrant: async () => false }))
      .toBe(GRANT_MISSING);
    expect(WRITES_GRANT_MISSING).toBe(GRANT_MISSING);
    expect(await writeRefusal({ access: "write", scope, holdsGrant: async () => true }))
      .toBeUndefined();
    await expect(writeRefusal({
      access: "write", scope, holdsGrant: async () => { throw new Error("account unreachable"); },
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
    let gate = { access: "write" as const, scope: { kind: "account" as const }, holdsGrant: async () => { throw failure; } };
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
    expect(attempts.get(id)).toStrictEqual({ at: expect.any(Number), failedSends: 1 });
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
    // The look that bound it.
    expect(api.listComments).toHaveBeenCalledTimes(1);
    expect(journal.get(id)).toBeUndefined();
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
    let payload = { ...TARGET, content: "\"May\"\n\nWhy?", quotesDocument: true as const };
    let pending: JournalEntry<DriveCommentAction>[] =
      [{ id: 4, action: { kind: "createComment", payload } }];
    expect(overlayPending("doc-1", [], pending, true))
      .toEqual({ comments: [pendingComment(4, payload)], quotesDocument: true });
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
