import { ActionJournal, type JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessTokenCache } from "../src/auth-retry";
import {
  DriveApi, DriveApiRequestError, type DriveCommentRecord, type DriveReplyRecord,
  type DriveScopeNode,
} from "../src/drive-api";
import {
  commentParent, DRIVE_COMMENT_ACTIONS, overlayPending, pendingComment, pendingReply,
  readOnlyRefusal, toDriveComment, writeRefusal, WRITES_GRANT_MISSING,
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
const PARENT_QUOTE = "On Ada Lovelace's comment:\n\n> Is this date right?";

/** A comment as Drive returns it. */
function live(overrides: Partial<DriveCommentRecord> = {}): DriveCommentRecord {
  return {
    id: "doco.c1", content: "Is this date right?",
    author: { displayName: "Ada Lovelace", me: false },
    createdTime: "2026-10-20T09:00:00.000Z", resolved: false, deleted: false, replies: [],
    ...overrides,
  };
}

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
    ...TARGET, commentId: "doco.c1", content: "Yes.", parent: commentParent(live()), ...overrides,
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
        ...TARGET, commentId: "doco.c1", parent: commentParent(live()),
      }),
    ]) {
      expect(description).toMatchObject({
        autoApprovable: true, actionKind: KIND, implementsRevert: false,
      });
    }
  });

  it("shows a comment's file, by its ID, and its whole body", async () => {
    let body = "\"The launch is in May.\"\n\nShould this be June?\n\nhttps://docs.google.com/x";
    let description = await harness().card("createComment", { ...TARGET, content: body });
    expect(description.title).toBe("Comment on a Google Drive file");
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "text", value: body },
    ]);
    expect(description.description).toBe(
      "Post a comment on Google Drive file `doc-1` as the connected account. It is plain text, " +
      "not attached to text in the file. Google emails the file's owner about new comments.");
    expect(description.descriptionIsComplete).toBe(true);
  });

  it("quotes the comment a reply answers under its author's name, and says when it reopens it", async () => {
    let description = await harness().card("createReply", reply({ reopens: true }));
    expect(description.title).toBe("Reply to a Google Drive comment");
    expect(description.description).toBe(
      "Reply to a comment on Google Drive file `doc-1` as the connected account. Google emails " +
      `the file's owner about new comments.\n\nThis reopens the resolved comment.\n\n${PARENT_QUOTE}`);
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      { label: "Reply", kind: "text", value: "Yes." },
    ]);
    expect(description.descriptionIsComplete).toBe(true);

    let plain = await harness().card("createReply", reply());
    expect(plain.description).not.toContain("reopens");

    // The author's name and the comment's text are someone else's: both pass the kit's sanitizers.
    let parent = commentParent(live({
      content: "# Urgent\n```\nrm -rf\n```", author: { displayName: "Ada [x](y)", me: false },
    }));
    let quoted = await harness().card("createReply", reply({ parent }));
    expect(quoted.description).toContain("On Ada xy's comment:");
    expect(quoted.description).toContain("> Urgent\n> '''\n> rm -rf\n> '''");
    expect(quoted.description).not.toMatch(/^#/m);
    expect(quoted.description).not.toContain("```");
  });

  it("shows a resolve with and without a closing reply", async () => {
    let parent = commentParent(live());
    let bare = await harness().card("resolveComment", { ...TARGET, commentId: "doco.c1", parent });
    expect(bare.title).toBe("Resolve a Google Drive comment");
    expect(bare.description).toBe(
      `Resolve a comment on Google Drive file \`doc-1\` as the connected account.\n\n${PARENT_QUOTE}`);
    expect(bare.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
    ]);

    let closing = await harness().card("resolveComment", {
      ...TARGET, commentId: "doco.c1", content: "Fixed.", parent,
    });
    expect(closing.description).toBe(
      "Resolve a comment on Google Drive file `doc-1` as the connected account, with a closing " +
      `reply.\n\n${PARENT_QUOTE}`);
    expect(closing.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Comment", kind: "inline", value: "doco.c1" },
      { label: "Reply", kind: "text", value: "Fixed." },
    ]);
  });

  it("keeps the answered comment's author and the first 200 characters of its text", () => {
    expect(commentParent(live({ content: "abc" })))
      .toEqual({ author: "Ada Lovelace", excerpt: "abc" });
    let whole = "x".repeat(200);
    expect(commentParent(live({ content: whole })).excerpt).toBe(whole);
    expect(commentParent(live({ content: `${whole}tail` })).excerpt).toBe(whole);
    // Characters are code points: a cut never splits a surrogate pair.
    expect(commentParent(live({ content: "😀".repeat(201) })).excerpt).toBe("😀".repeat(200));
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

  it("sends again once a send is proven empty, having dropped its marker before the checks", async () => {
    let { api, journal, attempts, submit, apply, aged, refuse } = harness();
    api.createComment.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createComment", { ...TARGET, content: "Hi" });
    expect(await apply(id)).toBe(UNCONFIRMED_SEND);
    aged(id);
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    // The look ran, and found nothing.
    expect(api.listComments).toHaveBeenCalledTimes(1);
    expect(attempts.size).toBe(0);
    expect(journal.get(id)?.state).toBe("pending");

    refuse(undefined);
    expect(await apply(id)).toBeNull();
    // No marker, so no look.
    expect(api.listComments).toHaveBeenCalledTimes(1);
    expect(api.createComment).toHaveBeenCalledTimes(2);
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
    let parent = commentParent(live());
    let payload = { ...TARGET, commentId: "doco.c1", content: "Fixed.", parent };
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
