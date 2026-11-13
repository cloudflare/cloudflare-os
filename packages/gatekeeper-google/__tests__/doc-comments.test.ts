import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocsCommentNotSavedError, GoogleDocsApi, type DocsCommentRecord, type GoogleDocsDocument,
  type StructuralElement,
} from "../src/docs-api";
import {
  DOC_COMMENT_ACTIONS, DOC_GRANT_MISSING, docsThreads, toCommentRecord,
} from "../src/doc-comments";
import type { DriveApi } from "../src/drive-api";
import {
  commentParent, type CommentHost, type DriveCommentAction, type DriveCommentActions,
} from "../src/drive-comments";
import type { WriteAttempt } from "../src/drive-writes";
import { GoogleApiError } from "../src/google-response";
import { FakeKv } from "./fake-kv";

const TARGET = { fileId: "doc-1", fileName: "Plan", queuedAt: "2026-11-11T10:00:00.000Z" };
const KIND = { tag: "docComments", label: "Google Doc comments" };
const TEXT = "The launch is in May. Costs are final.\n";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A thread as `getCommentThreads` returns it: someone else's, attached to "May". */
function thread(overrides: Partial<DocsCommentRecord> = {}): DocsCommentRecord {
  return {
    commentId: "doco.c1", anchored: true, quote: "May", resolved: false,
    headPost: {
      postId: "doco.c1", content: "Is this date right?",
      author: { displayName: "Ada Lovelace", me: false }, createTime: "2026-11-11T09:00:00.000Z",
    },
    replies: [],
    ...overrides,
  };
}

/** A Doc of one tab holding `text` in one run from index 1. */
function docOf(text: string): GoogleDocsDocument {
  let content: StructuralElement[] = [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 1 + text.length, paragraph: {
      elements: [{ startIndex: 1, endIndex: 1 + text.length, textRun: { content: text, textStyle: {} } }],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    } },
  ];
  return { documentId: "doc-1", title: "Plan", revisionId: "rev-1", tabs: [
    { tabId: "t.0", title: "Tab 1", index: 0, nestingLevel: 0, lists: {}, namedRanges: {}, body: { content } },
  ] };
}

/** The bound Doc's comment set over an in-memory journal, with Google faked behind the port. */
function harness() {
  let threads: DocsCommentRecord[] = [thread()];
  let canComment: boolean | undefined = true;
  let attempts = new Map<number, WriteAttempt>();
  let described: ActionDescription | undefined;
  let docs = {
    getCommentThreads: vi.fn<GoogleDocsApi["getCommentThreads"]>(async () => structuredClone(threads)),
    replyToComment: vi.fn<GoogleDocsApi["replyToComment"]>(
      async (_documentId, commentId, content, action) => {
        let found = threads.find(candidate => candidate.commentId === commentId)!;
        let postId = `doco.r${found.replies.length + 1}`;
        let resolves = action === "RESOLVE";
        found.replies.push({
          postId, content, author: { displayName: "Me", me: true }, createTime: new Date().toISOString(),
          ...(resolves ? { action: "resolve" as const } : found.resolved ? { action: "reopen" as const } : {}),
        });
        found.resolved = resolves;
        return postId;
      }),
    getDocumentWithSuggestions: vi.fn<GoogleDocsApi["getDocumentWithSuggestions"]>(
      async () => ({ document: docOf(TEXT), suggestions: [] })),
    getRevisionId: vi.fn<GoogleDocsApi["getRevisionId"]>(async () => "rev-1"),
    insertComment: vi.fn<GoogleDocsApi["insertComment"]>(async () => "doco.anchored"),
    suggest: vi.fn<GoogleDocsApi["suggest"]>(async () => ({ id: "suggest.s1", threadSaved: true })),
    replyToSuggestion: vi.fn<GoogleDocsApi["replyToSuggestion"]>(async () => undefined),
  };
  let drive = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(async ids => ids.map(id => ({ id, canComment }))),
  };
  let host: CommentHost = {
    threads: docsThreads(() => "doc-1", docs, drive),
    docs,
    writeRefusal: async () => undefined,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
  };
  let kv = new FakeKv();
  let journal = new ActionJournal<DriveCommentAction>(kv, {
    legacyKeys: { nextIdKey: "pending:nextActionId", recordPrefix: "docComments:action:" },
  });
  let actions = DOC_COMMENT_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  return {
    threads, docs, drive, kv, journal, attempts,
    submit: <K extends keyof DriveCommentActions>(kind: K, payload: DriveCommentActions[K]) =>
      actions.submit(queue, kind, payload),
    apply: (id: number): Promise<string | null> =>
      actions.apply(id).then(() => null, (error: Error) => error.message),
    get described() { return described; },
    setCanComment(value: boolean | undefined) { canComment = value; },
    /** Dates the action's marker ten minutes back, so its window has closed. */
    age(id: number): void {
      let attempt = attempts.get(id)!;
      attempts.set(id, { ...attempt, at: Date.now() - 10 * 60_000 });
    },
  };
}

async function replyPayload(
  overrides: Partial<DriveCommentActions["createReply"]> = {},
): Promise<DriveCommentActions["createReply"]> {
  return {
    ...TARGET, commentId: "doco.c1", content: "Yes.",
    parent: await commentParent(toCommentRecord(thread())), ...overrides,
  };
}

describe("Docs comment threads", () => {
  it("reads only the threads, with suggestions inline as Google requires, and parses each", async () => {
    let requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requested.push(url);
      return Response.json({ documentId: "doc-1", comments: [
        {
          commentId: "doco.a", anchorId: "kix.a", status: "RESOLVED", plainTextQuote: "May",
          headPost: { postId: "doco.a", content: "Date?", author: { displayName: "Ada", me: false },
            createTime: "2026-11-11T09:00:00Z", updateTime: "2026-11-11T09:00:00Z",
            commentAction: "NO_COMMENT_ACTION_CHANGE" },
          replies: [
            { postId: "doco.r1", content: "Yes.", author: { displayName: "Me", me: true },
              createTime: "2026-11-11T09:05:00Z", commentAction: "RESOLVE" },
            { postId: "doco.r2", content: "More.", author: { displayName: "Me", me: true },
              createTime: "2026-11-11T09:06:00Z", commentAction: "REOPEN" },
          ],
        },
        { commentId: "doco.b", status: "OPEN", headPost: { postId: "doco.b", content: "Whole file",
          author: { displayName: "Bo", me: false }, createTime: "2026-11-11T08:00:00Z" } },
      ] });
    });
    let threads = await new GoogleDocsApi(async () => "token").getCommentThreads("doc-1");

    let url = new URL(requested[0]);
    expect(url.pathname).toBe("/v1/documents/doc-1");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      includeTabsContent: "true", suggestionsViewMode: "SUGGESTIONS_INLINE",
      commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
      fields: "documentId,comments(commentId,anchorId,status,plainTextQuote," +
        "headPost(postId,content,author(displayName,me),createTime,updateTime,commentAction)," +
        "replies(postId,content,author(displayName,me),createTime,updateTime,commentAction))",
    });
    expect(threads).toEqual([
      {
        commentId: "doco.a", anchored: true, quote: "May", resolved: true,
        headPost: { postId: "doco.a", content: "Date?", author: { displayName: "Ada", me: false },
          createTime: "2026-11-11T09:00:00Z", updateTime: "2026-11-11T09:00:00Z" },
        replies: [
          { postId: "doco.r1", content: "Yes.", author: { displayName: "Me", me: true },
            createTime: "2026-11-11T09:05:00Z", action: "resolve" },
          { postId: "doco.r2", content: "More.", author: { displayName: "Me", me: true },
            createTime: "2026-11-11T09:06:00Z", action: "reopen" },
        ],
      },
      {
        commentId: "doco.b", anchored: false, resolved: false,
        headPost: { postId: "doco.b", content: "Whole file", author: { displayName: "Bo", me: false },
          createTime: "2026-11-11T08:00:00Z" },
        replies: [],
      },
    ]);
    // In Drive's shape, its modification time is its latest post's.
    expect(toCommentRecord(threads[0])).toMatchObject({
      id: "doco.a", quotedText: "May", resolved: true, modifiedTime: "2026-11-11T09:06:00Z",
      replies: [{ id: "doco.r1", action: "resolve" }, { id: "doco.r2", action: "reopen" }],
    });
    expect(toCommentRecord(threads[1])).not.toHaveProperty("quotedText");
  });

  it("reads a Doc with no comments as no threads, and refuses a malformed one", async () => {
    let answer: unknown = { documentId: "doc-1" };
    vi.stubGlobal("fetch", async () => Response.json(answer));
    let api = new GoogleDocsApi(async () => "token");
    expect(await api.getCommentThreads("doc-1")).toEqual([]);
    answer = { documentId: "doc-1", comments: [{ commentId: "doco.a", headPost: { content: "x" } }] };
    await expect(api.getCommentThreads("doc-1")).rejects.toThrow("Google Docs returned invalid comments");
    answer = { documentId: "doc-2", comments: [] };
    await expect(api.getCommentThreads("doc-1")).rejects.toThrow("Google Docs returned a different document");
  });

  it.each([
    ["a reply", "Yes.", undefined, { content: "Yes." }],
    ["a resolve", "", "RESOLVE", { content: "", commentAction: "RESOLVE" }],
    ["a reopen with words", "Again.", "REOPEN", { content: "Again.", commentAction: "REOPEN" }],
  ] as const)("sends %s as one addCommentReply, returning the reply's ID", async (_name, content, action, post) => {
    let bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ replies: [{ addCommentReply: { post: { postId: "doco.p9" } } }],
        commentUpdateState: "ALL_SAVED" });
    });
    let id = await new GoogleDocsApi(async () => "token")
      .replyToComment("doc-1", "doco.c1", content, action);
    expect(id).toBe("doco.p9");
    expect(bodies).toEqual([{ requests: [{ addCommentReply: { commentId: "doco.c1", post } }] }]);
  });

  it("returns a suggestion's ID with whether Google saved its thread", async () => {
    let state = "ALL_SAVED";
    vi.stubGlobal("fetch", async () => Response.json({
      suggestionResponses: [{ createdSuggestionIds: ["suggest.s1"] }], commentUpdateState: state,
    }));
    let api = new GoogleDocsApi(async () => "token");
    await expect(api.suggest("doc-1", [])).resolves.toEqual({ id: "suggest.s1", threadSaved: true });
    state = "ALL_FAILED_UNKNOWN_REASON";
    await expect(api.suggest("doc-1", [])).resolves.toEqual({ id: "suggest.s1", threadSaved: false });
  });

  it("refuses a reply Google says it did not save, or answered with no ID", async () => {
    let answer: unknown = { replies: [{}], commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" };
    vi.stubGlobal("fetch", async () => Response.json(answer));
    let api = new GoogleDocsApi(async () => "token");
    await expect(api.replyToComment("doc-1", "doco.c1", "Yes.")).rejects.toBeInstanceOf(DocsCommentNotSavedError);
    answer = { replies: [{}], commentUpdateState: "ALL_SAVED" };
    await expect(api.replyToComment("doc-1", "doco.c1", "Yes.")).rejects.toThrow("Google Docs returned no reply ID");
  });
});

describe("bound Doc comment writes", () => {
  it("queues each write as Google Doc comments, with its own cards", async () => {
    let run = harness();
    await run.submit("createComment", { ...TARGET, content: "Hm.", anchor: { tabId: "t.0", text: "May" } });
    expect(run.described).toMatchObject({
      title: "Comment on a Google Doc", actionKind: KIND, autoApprovable: true,
      description: "Post a comment on Google Doc `doc-1` as the connected account, attached to the " +
        "quoted text. Google emails the file's owner about new comments.",
    });
    await run.submit("createReply", await replyPayload({ reopens: true }));
    expect(run.described).toMatchObject({
      title: "Reply to a Google Doc comment", actionKind: KIND,
      description: "Reply to a comment on Google Doc `doc-1` as the connected account. Google " +
        "emails the file's owner about new comments.\n\nThis reopens the resolved comment.",
    });
    await run.submit("resolveComment", { ...await replyPayload(), content: undefined });
    expect(run.described).toMatchObject({
      title: "Resolve a Google Doc comment",
      description: "Resolve a comment on Google Doc `doc-1` as the connected account.",
    });
    await run.submit("suggestEdit", { ...TARGET, tabId: "t.0", oldText: "May", newText: "June" });
    expect(run.described).toMatchObject({ title: "Suggest an edit in a Google Doc", actionKind: KIND });
  });

  it("posts a reply and a resolve through the Docs API", async () => {
    let run = harness();
    let reply = await run.submit("createReply", await replyPayload());
    expect(await run.apply(reply)).toBeNull();
    let resolve = await run.submit("resolveComment", { ...await replyPayload(), content: undefined });
    expect(await run.apply(resolve)).toBeNull();
    expect(run.docs.replyToComment.mock.calls).toEqual([
      ["doc-1", "doco.c1", "Yes.", undefined],
      ["doc-1", "doco.c1", "", "RESOLVE"],
    ]);
    expect(run.threads[0].resolved).toBe(true);
  });

  it("refuses at apply a comment edited, or resolved, since the write was queued", async () => {
    let run = harness();
    let reply = await run.submit("createReply", await replyPayload());
    let resolve = await run.submit("resolveComment", await replyPayload({ content: "Done." }));
    run.threads[0].headPost.content = "Is this date right? Edited.";
    let edited = "That comment was edited after this was queued. Queue it again to answer the " +
      "comment as it is now.";
    expect(await run.apply(reply)).toBe(edited);
    expect(await run.apply(resolve)).toBe(edited);

    let fresh = harness();
    let late = await fresh.submit("createReply", await replyPayload());
    let twice = await fresh.submit("resolveComment", await replyPayload());
    fresh.threads[0].resolved = true;
    expect(await fresh.apply(late)).toBe("That comment was resolved after this reply was queued, " +
      "and replying would reopen it. Queue the reply again to reopen it.");
    expect(await fresh.apply(twice)).toBe("That comment is already resolved.");
    expect(fresh.docs.replyToComment).not.toHaveBeenCalled();
  });

  it("refuses at apply when the account may no longer comment, or the comment is gone", async () => {
    let run = harness();
    let reply = await run.submit("createReply", await replyPayload());
    run.setCanComment(false);
    expect(await run.apply(reply)).toBe("The connected account can no longer comment on that file.");
    let gone = harness();
    let id = await gone.submit("createReply", await replyPayload());
    gone.threads.splice(0);
    expect(await gone.apply(id)).toBe("That comment was not found on this file.");
  });

  it("keeps a write Google did not save pending, and one refused for a missing scope", async () => {
    let run = harness();
    let id = await run.submit("createReply", await replyPayload());
    run.docs.replyToComment.mockRejectedValueOnce(new DocsCommentNotSavedError("x"));
    expect(await run.apply(id)).toBe("Google Docs answered that it did not save this comment, so " +
      "nothing was posted. Approve it again to post it.");
    run.docs.replyToComment.mockRejectedValueOnce(new GoogleApiError(
      "Google Docs reply to comment failed [http=403]", "PERMISSION_DENIED",
      ["ACCESS_TOKEN_SCOPE_INSUFFICIENT"]));
    expect(await run.apply(id)).toBe(DOC_GRANT_MISSING);
    expect(run.journal.get(id)?.state).toBe("pending");
    expect(await run.apply(id)).toBeNull();
    expect(run.threads[0].replies.map(post => post.content)).toEqual(["Yes."]);
  });

  describe("the look after a send with no answer", () => {
    /** Applies a reply whose send posts, then fails with no answer. */
    async function lostReply(run: ReturnType<typeof harness>, { posts = true } = {}) {
      let id = await run.submit("createReply", await replyPayload());
      let send = run.docs.replyToComment.getMockImplementation()!;
      run.docs.replyToComment.mockImplementationOnce(async (...args) => {
        if (posts) await send(...args);
        throw new Error("The operation was aborted due to timeout");
      });
      expect(await run.apply(id)).toMatch(/^Google Docs did not confirm whether this was posted/);
      return id;
    }

    it("binds the reply it finds, sending nothing again", async () => {
      let run = harness();
      let id = await lostReply(run);
      expect(await run.apply(id)).toBeNull();
      expect(run.docs.replyToComment).toHaveBeenCalledTimes(1);
      expect(run.threads[0].replies).toHaveLength(1);
    });

    it("waits while the window is open, and sends again once it closed with nothing found", async () => {
      let run = harness();
      let id = await lostReply(run, { posts: false });
      expect(await run.apply(id)).toMatch(/^Google Docs may still be posting this, so it wasn't sent again/);
      run.age(id);
      expect(await run.apply(id)).toBeNull();
      expect(run.docs.replyToComment).toHaveBeenCalledTimes(2);
      expect(run.threads[0].replies).toHaveLength(1);
    });

    it("takes nothing found for proof only from an account that can still comment", async () => {
      let run = harness();
      let id = await lostReply(run, { posts: false });
      run.age(id);
      run.setCanComment(false);
      expect(await run.apply(id)).toBe("The connected account can no longer comment on that file, " +
        "and Google Docs shows a file's comments only to accounts that can, so whether this was " +
        "posted can't be checked, and it won't be sent again. Reject it to clear it.");
      expect(run.docs.replyToComment).toHaveBeenCalledTimes(1);
    });

    it("cannot tell which of two identical replies it posted", async () => {
      let run = harness();
      let id = await lostReply(run);
      run.threads[0].replies.push({ ...run.threads[0].replies[0], postId: "doco.twin" });
      expect(await run.apply(id)).toMatch(/^The connected account has more than one identical comment/);
    });

    it("cannot tell once the comment is gone", async () => {
      let run = harness();
      let id = await lostReply(run);
      run.threads.splice(0);
      expect(await run.apply(id)).toBe("Google Docs no longer shows this file or comment to the " +
        "connected account, so whether this was posted can't be checked, and it won't be sent " +
        "again. Reject it to clear it.");
    });

    it("finds a comment attached to text by its text, among every thread", async () => {
      let run = harness();
      run.docs.insertComment.mockImplementationOnce(async (_doc, content) => {
        run.threads.push(thread({
          commentId: "doco.mine", headPost: { postId: "doco.mine", content,
            author: { displayName: "Me", me: true }, createTime: new Date().toISOString() },
        }));
        throw new Error("The operation was aborted due to timeout");
      });
      let id = await run.submit("createComment",
        { ...TARGET, content: "Hm.", anchor: { tabId: "t.0", text: "Costs are final" } });
      expect(await run.apply(id)).toMatch(/did not confirm/);
      expect(await run.apply(id)).toBeNull();
      expect(run.docs.insertComment).toHaveBeenCalledTimes(1);
    });
  });

  it("never posts a comment attached to no text", async () => {
    let run = harness();
    let id = await run.submit("createComment", { ...TARGET, content: "Whole file." });
    expect(await run.apply(id)).toBe("A comment on a bound Google Doc must be attached to text in it.");
    expect(run.journal.get(id)?.state).toBe("failed");
  });

  it("shares the edit store's counter, so interleaved submits get unique, rising IDs", async () => {
    let run = harness();
    // The edit store allocates as PendingActionStore does: read, then bump, the same key.
    let edit = () => {
      let id = run.kv.get<number>("pending:nextActionId") ?? 1;
      run.kv.put("pending:nextActionId", id + 1);
      run.kv.put(`pending:action:${id}`, { type: "appendText" });
      return id;
    };
    let ids = [
      edit(),
      await run.submit("createReply", await replyPayload()),
      edit(),
      edit(),
      await run.submit("suggestEdit", { ...TARGET, tabId: "t.0", oldText: "May", newText: "June" }),
    ];
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(run.journal.get(2)).toBeDefined();
    expect(run.journal.get(3)).toBeUndefined();
  });
});
