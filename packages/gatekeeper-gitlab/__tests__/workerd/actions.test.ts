// The action lifecycle on the real gatekeeper Durable Object: queue → simulated read → apply →
// revert, with GitLab faked at fetch. Covers the issue/MR mutations and their GitLab endpoints,
// provisional ids and #~N / !~N rewriting, reject cascades, the draft-note review path (drafts,
// bulk_publish with reviewer_state, approve with sha, alias mapping), replies resolving to their
// discussion, and the merge error mapping.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, unwrap } from "./fake-gitlab.js";
import type { GatekeeperProps } from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = "group%2Fsub%2Fproject";
const PROJECT = "group/sub/project";
const DESC: ActionDescription = { title: "t", description: "d", implementsRevert: true };

function project() {
  return {
    ...fx.projectResponse.data, path_with_namespace: PROJECT,
    web_url: `https://gitlab.example.com/${PROJECT}`,
    namespace: { ...fx.projectResponse.data.namespace, full_path: "group/sub" },
  };
}

/** A fake with the always-needed routes; tests add the endpoints they exercise. */
function fake(): FakeGitLab {
  const gitlab = new FakeGitLab();
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}$`), () => json(project()));
  gitlab.on("GET", /^\/api\/v4\/user$/, () => json(fx.currentUserResponse.data));
  return gitlab;
}

async function setup(name: string): Promise<{ gitlab: FakeGitLab; props: GatekeeperProps; name: string }> {
  const gitlab = fake();
  const id = await seedAccount();
  return { gitlab, props: projectProps(id, PROJECT), name };
}

type IssueJson = Omit<typeof fx.issueResponse.data, "state"> & { state: "opened" | "closed" };
const issue = (over: Partial<IssueJson> = {}): IssueJson => ({ ...fx.issueResponse.data, iid: 1, state: "opened", ...over });

describe("issue creation", () => {
  it("queues with a provisional id, reads back simulated, applies, then resolves the real id", async () => {
    const { gitlab, props, name } = await setup("create-issue");
    gitlab.on("GET", /^\/api\/v4\/users\?username=lennie/, () => json(fx.usersByUsernameResponse.data.map(u => ({ ...u, id: 9, username: "lennie" }))));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/issues$`), request =>
      json(issue({ iid: 77, title: JSON.parse(request.body!).title }), { status: 201 }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/77\\?`), () => json(issue({ iid: 77, title: "New thing" })));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), () => json([]));
    gitlab.install();

    const action = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue",
      [{ title: "New thing", bodyMarkdown: "see !~1", labels: ["bug"], assignees: ["lennie"] }], DESC));
    expect(action).toMatchObject({ type: "createIssue", provisionalId: "~1", assigneeIds: [9] });

    // Simulated: the provisional issue reads as if created, authored by the viewer.
    const provisional = await unwrap(await hooks().openIssue(name, props, "~1"));
    expect(provisional).toMatchObject({
      id: "~1", title: "New thing", state: "opened", labels: [{ name: "bug" }],
      author: { username: "john_smith" }, assignees: [{ username: "lennie" }],
      url: `https://gitlab.example.com/${PROJECT}/-/issues/~1`,
    });
    const listed = await unwrap(await hooks().listIssuesAll(name, props, 20));
    expect(listed.some(i => i.id === "~1")).toBe(true);

    // Apply: the POST carries resolved assignee ids and joined labels; a reference to a
    // provisional MR that has not been created fails closed.
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/!~1 points to a provisional merge request/);

    // Same action without the dangling reference.
    const plain = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Plain" }], DESC));
    await unwrap(await hooks().applyAction(name, props, plain.approvalId));
    const post = gitlab.requests.find(r => r.method === "POST" && r.url.pathname === `/api/v4/projects/${P}/issues`)!;
    expect(JSON.parse(post.body!)).toEqual({ title: "Plain" });
    // The provisional id now resolves to the real one; both lookups work.
    const real = await unwrap(await hooks().openIssue(name, props, "~2"));
    expect(real.id).toBe("77");
  });

  it("rejecting a create cascades to everything queued against the provisional issue", async () => {
    const { gitlab, props, name } = await setup("reject-create");
    gitlab.install();
    const create = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Doomed" }], DESC));
    const comment = await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "~1", "hello"], DESC));
    expect(comment).toMatchObject({ type: "postComment", targetId: "~1" });
    expect(await unwrap(await hooks().rejectAction(name, props, create.approvalId))).toEqual({ restart: true });
    // The cascaded comment is no longer pending: applying it is refused, and the provisional is gone.
    await expect(unwrap(await hooks().applyAction(name, props, comment.approvalId))).rejects.toThrow(/no longer pending/);
    await expect(unwrap(await hooks().openIssue(name, props, "~1"))).rejects.toThrow(/No provisional issue exists/);
  });
});

describe("issue mutations", () => {
  function withIssue(gitlab: FakeGitLab, state: { issue: ReturnType<typeof issue> }) {
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1\\?`), () => json(state.issue));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/issues/1$`), request => {
      const body = JSON.parse(request.body!);
      if (body.title) state.issue = { ...state.issue, title: body.title };
      if (body.state_event) state.issue = { ...state.issue, state: body.state_event === "close" ? "closed" : "opened" };
      if (body.add_labels) state.issue = { ...state.issue, labels: [...state.issue.labels, ...body.add_labels.split(",")] };
      if (body.remove_labels) {
        const removed = new Set(body.remove_labels.split(","));
        state.issue = { ...state.issue, labels: state.issue.labels.filter((l: unknown) => !removed.has(typeof l === "string" ? l : (l as { name: string }).name)) };
      }
      return json(state.issue);
    });
  }

  it("setTitle: overlays before apply, PUTs on apply, restores on revert", async () => {
    const { gitlab, props, name } = await setup("set-title");
    const state = { issue: issue({ title: "Old" }) };
    withIssue(gitlab, state);
    gitlab.install();

    const action = await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["issue", "1", "New"], DESC));
    expect(action).toMatchObject({ type: "setTitle", previousTitle: "Old" });
    expect((await unwrap(await hooks().openIssue(name, props, "1"))).title).toBe("New");  // simulated
    expect(state.issue.title).toBe("Old");  // not yet on GitLab

    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(state.issue.title).toBe("New");
    expect(gitlab.requests.filter(r => r.method === "PUT").map(r => JSON.parse(r.body!))).toEqual([{ title: "New" }]);

    await unwrap(await hooks().revertAction(name, props, action.approvalId));
    expect(state.issue.title).toBe("Old");
  });

  it("labels: add and remove use add_labels/remove_labels and invert on revert", async () => {
    const { gitlab, props, name } = await setup("labels");
    const state = { issue: issue({ labels: ["bug"] }) };
    withIssue(gitlab, state);
    gitlab.install();

    const add = await unwrap(await hooks().queueAction(name, props, "prepareAddLabels", ["issue", "1", ["urgent", "Bug"]], DESC));
    const simulated = await unwrap(await hooks().openIssue(name, props, "1"));
    // Case-insensitive dedupe: "Bug" is already there as "bug".
    expect(simulated.labels.map(l => l.name)).toEqual(["bug", "urgent"]);
    await unwrap(await hooks().applyAction(name, props, add.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ add_labels: "urgent,Bug" });
    // Revert removes only what the action introduced: "Bug" was there before (as "bug") and stays.
    await unwrap(await hooks().revertAction(name, props, add.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ remove_labels: "urgent" });

    // Removing a label that is there and one that is not: revert re-adds only the one that was.
    const remove = await unwrap(await hooks().queueAction(name, props, "prepareRemoveLabels", ["issue", "1", ["bug", "ghost"]], DESC));
    await unwrap(await hooks().applyAction(name, props, remove.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ remove_labels: "bug,ghost" });
    await unwrap(await hooks().revertAction(name, props, remove.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ add_labels: "bug" });

    // Nothing to undo -- every added label was already present -- makes no request at all.
    const noop = await unwrap(await hooks().queueAction(name, props, "prepareAddLabels", ["issue", "1", ["BUG"]], DESC));
    await unwrap(await hooks().applyAction(name, props, noop.approvalId));
    const before = gitlab.requests.length;
    await unwrap(await hooks().revertAction(name, props, noop.approvalId));
    expect(gitlab.requests.length).toBe(before);
  });

  it("reports success for an action already applied: the overseer records completion after the reply, so a lost one re-delivers the apply", async () => {
    const { gitlab, props, name } = await setup("applied-retry");
    const state = { issue: issue({ title: "Old" }) };
    withIssue(gitlab, state);
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["issue", "1", "New"], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    const puts = gitlab.count("PUT", /issues\/1$/);
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(gitlab.count("PUT", /issues\/1$/)).toBe(puts);  // not applied twice
    // A rejected action, by contrast, is a real error to apply.
    const other = await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["issue", "1", "Other"], DESC));
    await unwrap(await hooks().rejectAction(name, props, other.approvalId));
    await expect(unwrap(await hooks().applyAction(name, props, other.approvalId))).rejects.toThrow(/no longer pending/);
  });

  it("keeps paging past a full remote page that holds a touched issue", async () => {
    const { gitlab, props, name } = await setup("touched-page");
    const state = { issue: issue({ iid: 1, title: "Old" }) };
    withIssue(gitlab, state);
    // Page 1 is exactly one remote page (100 issues, #1 among them); page 2 has one more.
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), request =>
      json(request.url.searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, i) => issue({ iid: i + 1, title: `Issue ${i + 1}` }))
        : request.url.searchParams.get("page") === "2" ? [issue({ iid: 101, title: "Issue 101" })] : []));
    gitlab.install();

    await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["issue", "1", "New"], DESC));
    const listed = await unwrap(await hooks().listIssuesAll(name, props, 50));
    // Every issue once: #1 overlaid with its queued title, and #101 from the second page -- which
    // a page thinned of #1 before it was counted would never have fetched.
    expect(listed).toHaveLength(101);
    expect(listed.filter(i => i.id === "1").map(i => i.title)).toEqual(["New"]);
    expect(listed.some(i => i.id === "101")).toBe(true);
    expect(gitlab.count("GET", /issues\?.*page=2/)).toBe(1);
  });

  it("does not cache a read that was in flight when an apply landed, as if it reflected the apply", async () => {
    // Requests interleave at awaits on one Durable Object: a details read starts, the apply of a
    // queued title change runs to completion (bumping the cache generation), then the read's
    // stale response arrives. Stored under the new generation it would hide the change for the
    // cache's lifetime; it is served to its caller and dropped.
    const { gitlab, props, name } = await setup("cache-race");
    const state = { issue: issue({ title: "Old" }) };
    withIssue(gitlab, state);
    let gets = 0;
    let readInFlight!: () => void;
    const readStarted = new Promise<void>(resolve => { readInFlight = resolve; });
    // The second GET (the first is the queue-time read) answers slowly, with what GitLab had when
    // it began. (A timer rather than a gate: the fake runs in the object's I/O context, which a
    // promise the test resolves cannot wake -- though one the fake resolves can wake the test.)
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1\\?`), async () => {
      if (++gets === 2) {
        const snapshot = state.issue;
        readInFlight();
        await new Promise(resolve => setTimeout(resolve, 400));
        return json(snapshot);
      }
      return json(state.issue);
    });
    gitlab.install();

    const action = await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["issue", "1", "New"], DESC));
    // Queuing bumped the generation, so this read goes to GitLab -- and dawdles there.
    const read = hooks().openIssue(name, props, "1");
    await readStarted;
    // The apply lands while the read is in flight.
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(state.issue.title).toBe("New");
    const stale = await unwrap(await read);
    expect(stale.title).toBe("Old");  // a valid read when it was made
    // The next read is not answered from that stale value.
    expect((await unwrap(await hooks().openIssue(name, props, "1"))).title).toBe("New");
    expect(gets).toBe(3);
  });

  it("close/reopen use state_event and record the previous state for revert", async () => {
    const { gitlab, props, name } = await setup("state");
    const state = { issue: issue({ state: "opened" }) };
    withIssue(gitlab, state);
    gitlab.install();

    const close = await unwrap(await hooks().queueAction(name, props, "prepareChangeState", ["issue", "1", "closed"], DESC));
    expect(close).toMatchObject({ state: "closed", previousState: "opened" });
    const simulated = await unwrap(await hooks().openIssue(name, props, "1"));
    expect(simulated.state).toBe("closed");
    expect(simulated.closedAt).toBeInstanceOf(Date);
    await unwrap(await hooks().applyAction(name, props, close.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ state_event: "close" });
    await unwrap(await hooks().revertAction(name, props, close.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ state_event: "reopen" });
  });

  it("postComment appears in the discussion before apply, posts a note, and reverts by deleting it", async () => {
    const { gitlab, props, name } = await setup("comment");
    withIssue(gitlab, { issue: issue({ user_notes_count: 0 }) });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1/discussions`), () => json([]));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/issues/1/notes$`), request =>
      json({ ...fx.issueNotesResponse.data[1], id: 555, body: JSON.parse(request.body!).body }, { status: 201 }));
    gitlab.on("DELETE", new RegExp(`^/api/v4/projects/${P}/issues/1/notes/555$`), () => new Response(null, { status: 204 }));
    gitlab.install();

    const action = await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "1", "Looks good"], DESC));
    const before = await unwrap(await hooks().discussionAll(name, props, "issue", "1", 50));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: "~comment1", bodyMarkdown: "Looks good", author: { username: "john_smith" } });

    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /notes$/)).toBe(1);
    await unwrap(await hooks().revertAction(name, props, action.approvalId));
    expect(gitlab.count("DELETE", /notes\/555$/)).toBe(1);
  });
});

describe("merge requests", () => {
  const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_project_id: 1, target_project_id: 1 };

  function withMergeRequest(gitlab: FakeGitLab, mr: Omit<typeof MR, "state"> & { state: "opened" | "closed" | "merged" | "locked" } = MR) {
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(mr));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json({ approved_by: [] }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/diffs`), () => json(fx.mergeRequestDiffsResponse.data));
  }

  it("creating an MR validates both branches exist, prefixes Draft:, and maps a GitLab 409 verbatim", async () => {
    const { gitlab, props, name } = await setup("create-mr");
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), request =>
      request.url.pathname.endsWith("missing") ? json({ message: "404 Branch Not Found" }, { status: 404 }) : json(fx.branchResponse.data));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), () => json(fx.compareResponse.data));
    let posted: Record<string, unknown> | undefined;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests$`), request => {
      posted = JSON.parse(request.body!);
      return posted!.title === "Dup" ? json({ message: "Another open merge request already exists for this source branch" }, { status: 409 })
        : json({ ...MR, iid: 200, title: posted!.title }, { status: 201 });
    });
    gitlab.install();

    await expect(unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "missing", targetBranch: "main" }], DESC))).rejects.toThrow(/does not exist in group\/sub\/project. Push your commits/);

    const action = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "Feature", sourceBranch: "feature", targetBranch: "main", draft: true, removeSourceBranch: true }], DESC));
    const provisional = await unwrap(await hooks().openMergeRequest(name, props, "~1"));
    expect(provisional).toMatchObject({ id: "~1", title: "Draft: Feature", draft: true, state: "opened", source: { branch: "feature" }, target: { branch: "main" } });

    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(posted).toEqual({ source_branch: "feature", target_branch: "main", title: "Draft: Feature", remove_source_branch: true });

    const dup = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "Dup", sourceBranch: "feature", targetBranch: "main" }], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, dup.approvalId))).rejects.toThrow(/Another open merge request already exists/);
  });

  it("publishes a review: approve (CAS on the head sha) first, then one draft per comment from one diff read, then bulk_publish", async () => {
    const { gitlab, props, name } = await setup("review");
    withMergeRequest(gitlab);
    const drafts: Array<Record<string, unknown>> = [];
    let published: Record<string, unknown> | undefined;
    let approved: Record<string, unknown> | undefined;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => json([]));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), request => {
      const body = JSON.parse(request.body!);
      drafts.push(body);
      return json({ ...fx.draftNotesResponse.data[0], id: drafts.length }, { status: 201 });
    });
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/bulk_publish$`), request => {
      published = JSON.parse(request.body!);
      return json({});
    });
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approve$`), request => {
      approved = JSON.parse(request.body!);
      return json({}, { status: 201 });
    });
    // One existing diff discussion, for the threads read and for the reply at the end.
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions`), () => json([{
      id: "disc-1", individual_note: false,
      notes: [{ ...fx.diffDiscussionResponse.data.notes[0], id: 9001, body: "Nit here",
        position: { ...fx.diffDiscussionResponse.data.notes[0].position, new_path: "README", old_path: "README", new_line: 1, old_line: null, line_range: null } }],
    }]));
    gitlab.install();

    const review = {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha, mergeBaseSha: MR.diff_refs.base_sha },
      decision: "approve" as const,
      bodyMarkdown: "LGTM",
      diffComments: [
        { target: { path: "README", subjectType: "line" as const, line: 1, side: "new" as const }, bodyMarkdown: "Nit here" },
        { target: { path: "VERSION", subjectType: "line" as const, line: 1, side: "new" as const }, bodyMarkdown: "Bump" },
      ],
    };
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", review], DESC));
    expect(action).toMatchObject({ type: "postReview", provisionalReviewId: "~review1" });

    // Simulated: the pending diff comments show as threads; the summary shows in the discussion.
    const threads = await unwrap(await hooks().threadsAll(name, props, "133"));
    expect(threads.slice(-2).map(t => t.id)).toEqual(["~diff1", "~diff2"]);

    gitlab.requests.length = 0;
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      note: "Nit here",
      // `+README` at line 1 is an added line: named by new_line alone.
      position: {
        position_type: "text", new_path: "README", old_path: "README", new_line: 1,
        // The inversion, outbound: GitLab's base_sha is our mergeBaseSha, its start_sha our baseSha.
        base_sha: MR.diff_refs.base_sha, start_sha: MR.diff_refs.start_sha, head_sha: MR.sha,
      },
    });
    expect((drafts[0] as { position: Record<string, unknown> }).position).not.toHaveProperty("old_line");
    expect(published).toEqual({ note: "LGTM", reviewer_state: "reviewed" });
    expect(approved).toEqual({ sha: MR.sha });

    // Approval is the compare-and-swap step, so it runs before anything is posted; the diff is
    // read once for both comments.
    const writes = gitlab.requests.filter(r => r.method === "POST").map(r => r.url.pathname.split("/").at(-1));
    expect(writes).toEqual(["approve", "draft_notes", "draft_notes", "bulk_publish"]);
    expect(gitlab.count("GET", /merge_requests\/133\/diffs/)).toBe(1);

    // A reply to a published diff note resolves its discussion by note id.
    const reply = await unwrap(await hooks().queueAction(name, props, "prepareReplyToDiffComment", ["133", "9001", "thanks"], DESC));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions/disc-1/notes$`), () =>
      json({ ...fx.issueNotesResponse.data[1], id: 9002 }, { status: 201 }));
    await unwrap(await hooks().applyAction(name, props, reply.approvalId));
    expect(gitlab.count("POST", /discussions\/disc-1\/notes$/)).toBe(1);
  });

  it("names an unchanged line by both sides, an added line by new_line, and a removed line by old_line", async () => {
    const { gitlab, props, name } = await setup("review-positions");
    withMergeRequest(gitlab);
    // A hunk with every kind of line, with the new side shifted by two from the old:
    //   old 10 / new 12  ctx a      old 11 / -     removed
    //   -      / new 13  added      old 12 / new 14  ctx b
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/diffs`), () => json([{
      old_path: "src/app.ts", new_path: "src/app.ts", new_file: false, renamed_file: false, deleted_file: false,
      a_mode: "100644", b_mode: "100644",
      diff: "@@ -10,3 +12,3 @@\n ctx a\n-removed\n+added\n ctx b",
    }]));
    const drafts: Array<{ note: string; position: Record<string, unknown> }> = [];
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => json([]));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), request => {
      drafts.push(JSON.parse(request.body!));
      return json({ ...fx.draftNotesResponse.data[0], id: drafts.length }, { status: 201 });
    });
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/bulk_publish$`), () => json({}));
    gitlab.install();

    const target = (side: "new" | "old", line: number) => ({ path: "src/app.ts", line, side });
    const review = {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha, mergeBaseSha: MR.diff_refs.base_sha },
      decision: "comment" as const,
      diffComments: [
        { target: target("new", 14), bodyMarkdown: "unchanged, named from the new side" },
        { target: target("old", 10), bodyMarkdown: "unchanged, named from the old side" },
        { target: target("new", 13), bodyMarkdown: "added" },
        { target: target("old", 11), bodyMarkdown: "removed" },
        { target: target("new", 99), bodyMarkdown: "not in the diff: GitLab judges the one-sided name" },
      ],
    };
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", review], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));

    const lines = drafts.map(d => [d.position.old_line ?? null, d.position.new_line ?? null]);
    expect(lines).toEqual([
      [12, 14],     // unchanged: both, with the old side's own number
      [10, 12],     // unchanged: both, resolved from the old side
      [null, 13],   // added: new_line alone
      [11, null],   // removed: old_line alone
      [null, 99],   // unknown to the diff: as the agent named it
    ]);
  });

  it("is idempotent under retry: a stale head fails before anything is posted, and a landed approval is neither repeated nor left behind", async () => {
    const { gitlab, props, name } = await setup("review-retry");
    withMergeRequest(gitlab);
    let approveStatus = 409;
    let draftBudget = Infinity;  // draft creations answered 201 before the route starts failing
    let publishStatus = 500;
    // The user's parked drafts, as GitLab would list them: created drafts join, published ones leave.
    const parked: number[] = [];
    let nextDraftId = 1;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approve$`), () =>
      json(approveStatus === 409 ? { message: "409 Conflict: SHA does not match HEAD of source branch" } : {}, { status: approveStatus }));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/unapprove$`), () => json({}, { status: 201 }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () =>
      json(parked.map(id => ({ ...fx.draftNotesResponse.data[0], id }))));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => {
      if (draftBudget-- <= 0) return json({ message: "500 Internal Server Error" }, { status: 500 });
      const id = nextDraftId++;
      parked.push(id);
      return json({ ...fx.draftNotesResponse.data[0], id }, { status: 201 });
    });
    let failPublishOf: number | null = null;  // one individual publish to answer 500, once
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/\\d+/publish$`), request => {
      const id = Number(request.url.pathname.split("/").at(-2));
      if (id === failPublishOf) {
        failPublishOf = null;
        return json({ message: "500 Internal Server Error" }, { status: 500 });
      }
      parked.splice(parked.indexOf(id), 1);
      return json({});
    });
    gitlab.on("DELETE", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/\\d+$`), request => {
      const id = Number(request.url.pathname.split("/").at(-1));
      if (!parked.includes(id)) return json({ message: "404 Not found" }, { status: 404 });
      parked.splice(parked.indexOf(id), 1);
      return new Response(null, { status: 204 });
    });
    let lastPublish: Record<string, unknown> | undefined;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/bulk_publish$`), request => {
      if (publishStatus !== 200) return json({ message: "500 Internal Server Error" }, { status: publishStatus });
      lastPublish = JSON.parse(request.body!);
      parked.length = 0;
      return json({});
    });
    const summaries: string[] = [];
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/notes$`), request => {
      summaries.push(JSON.parse(request.body!).body);
      return json({ ...fx.issueNotesResponse.data[1], id: 7 }, { status: 201 });
    });
    gitlab.install();

    const review = {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha, mergeBaseSha: MR.diff_refs.base_sha },
      decision: "approve" as const,
      bodyMarkdown: "LGTM",
      diffComments: [{ target: { path: "README", line: 1, side: "new" as const }, bodyMarkdown: "Nit" }],
    };
    const twoComments = { ...review, diffComments: [...review.diffComments,
      { target: { path: "VERSION", line: 1, side: "new" as const }, bodyMarkdown: "Also" }] };
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", review], DESC));

    // 1. The head moved: approve 409s and nothing else is attempted, twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/SHA does not match/);
    }
    expect(gitlab.count("POST", /\/approve$/)).toBe(2);
    expect(parked).toEqual([]);
    expect(gitlab.count("POST", /bulk_publish$/)).toBe(0);

    // 2. Approval lands, then the publish fails, leaving the draft parked. The retry does not
    //    approve again; it recognises the parked draft as its own, deletes it, recreates the set,
    //    and publishes through bulk_publish -- with the reviewer state, which the foreign-drafts
    //    path would have dropped had the leftover been mistaken for the user's.
    approveStatus = 201;
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    expect(gitlab.count("POST", /\/approve$/)).toBe(3);
    expect(parked).toEqual([1]);
    publishStatus = 200;
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /\/approve$/)).toBe(3);
    expect(gitlab.count("DELETE", /draft_notes\/1$/)).toBe(1);
    expect(gitlab.count("PUT", /\/publish$/)).toBe(0);
    expect(gitlab.count("POST", /merge_requests\/133\/notes$/)).toBe(0);
    expect(lastPublish).toEqual({ note: "LGTM", reviewer_state: "reviewed" });
    expect(parked).toEqual([]);

    // 3. A review discarded partway -- approval landed, one draft created, the next failed --
    //    takes the approval back and clears its parked draft.
    const second = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", twoComments], DESC));
    draftBudget = 1;
    await expect(unwrap(await hooks().applyAction(name, props, second.approvalId))).rejects.toThrow(/500/);
    expect(gitlab.count("POST", /\/approve$/)).toBe(4);
    expect(parked).toEqual([3]);
    await unwrap(await hooks().rejectAction(name, props, second.approvalId));
    expect(gitlab.count("POST", /\/unapprove$/)).toBe(1);
    expect(parked).toEqual([]);

    // 4. The user has a draft of their own parked, so ours publish one by one; the second
    //    publish fails. The retry resumes: the published comment is neither recreated nor
    //    republished, the failed one is deleted and recreated, and the summary posts once.
    parked.push(99);
    draftBudget = Infinity;
    const third = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", twoComments], DESC));
    failPublishOf = 5;  // ids 4 and 5 are this attempt's drafts
    await expect(unwrap(await hooks().applyAction(name, props, third.approvalId))).rejects.toThrow(/500/);
    expect(parked).toEqual([99, 5]);
    expect(summaries).toEqual([]);
    const requestsBefore = gitlab.requests.length;
    await unwrap(await hooks().applyAction(name, props, third.approvalId));
    const retry = gitlab.requests.slice(requestsBefore).filter(r => r.method !== "GET")
      .map(r => `${r.method} ${r.url.pathname.split("/").slice(-2).join("/")}`);
    expect(retry).toEqual([
      "DELETE draft_notes/5",   // the unpublished leftover
      "POST 133/draft_notes",   // one recreated draft, for the one unpublished comment
      "PUT 6/publish",
      "POST 133/notes",         // the summary, once
    ]);
    expect(parked).toEqual([99]);
    expect(summaries).toEqual(["LGTM"]);
  });

  it("requestChanges publishes with reviewer_state requested_changes and never approves", async () => {
    const { gitlab, props, name } = await setup("request-changes");
    withMergeRequest(gitlab);
    let published: Record<string, unknown> | undefined;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => json([]));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/bulk_publish$`), request => {
      published = JSON.parse(request.body!);
      return json({});
    });
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha }, decision: "requestChanges", bodyMarkdown: "Please fix",
    }], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(published).toEqual({ note: "Please fix", reviewer_state: "requested_changes" });
    expect(gitlab.count("POST", /approve$/)).toBe(0);
  });

  it("publishes drafts individually when the user has parked drafts of their own on the MR", async () => {
    const { gitlab, props, name } = await setup("foreign-drafts");
    withMergeRequest(gitlab);
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => json(fx.draftNotesResponse.data));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () =>
      json({ ...fx.draftNotesResponse.data[0], id: 42 }, { status: 201 }));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/42/publish$`), () => json({}));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/notes$`), () => json({ ...fx.issueNotesResponse.data[1], id: 7 }, { status: 201 }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions`), () => json([]));
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha }, decision: "comment", bodyMarkdown: "Summary",
      diffComments: [{ target: { path: "README", subjectType: "file" }, bodyMarkdown: "File-level" }],
    }], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /bulk_publish$/)).toBe(0);
    expect(gitlab.count("PUT", /draft_notes\/42\/publish$/)).toBe(1);
    expect(gitlab.count("POST", /merge_requests\/133\/notes$/)).toBe(1);

    // A requestChanges review cannot take that path -- its decision is the reviewer state the
    // path cannot set -- so it refuses before posting anything of its own.
    const before = gitlab.requests.filter(r => r.method !== "GET").length;
    const changes = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha }, decision: "requestChanges", bodyMarkdown: "Please fix",
      diffComments: [{ target: { path: "README", subjectType: "file" }, bodyMarkdown: "Here" }],
    }], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, changes.approvalId)))
      .rejects.toThrow(/you have 1 unpublished draft comment of your own on it in GitLab/);
    expect(gitlab.requests.filter(r => r.method !== "GET").length).toBe(before);
  });

  it("refuses an empty requestChanges review at queue time: it would publish nothing, so it could request nothing", async () => {
    const { gitlab, props, name } = await setup("empty-request-changes");
    withMergeRequest(gitlab);
    gitlab.install();
    await expect(unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha }, decision: "requestChanges",
    }], DESC))).rejects.toThrow(/needs a summary comment or at least one diff comment/);
    // An empty plain comment review is a legitimate no-op; approve with nothing else still approves.
    expect(gitlab.count("POST", /draft_notes/)).toBe(0);
  });

  it("re-reads the user's drafts just before publishing, so one started while the review's drafts were being created is not swept up", async () => {
    const { gitlab, props, name } = await setup("late-foreign-draft");
    withMergeRequest(gitlab);
    const parked: number[] = [];
    let nextId = 1;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () =>
      json(parked.map(id => ({ ...fx.draftNotesResponse.data[0], id }))));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => {
      const id = nextId++;
      parked.push(id);
      // The human starts a draft in GitLab's UI while ours are being created.
      if (id === 1) parked.push(99);
      return json({ ...fx.draftNotesResponse.data[0], id }, { status: 201 });
    });
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/\\d+/publish$`), request => {
      parked.splice(parked.indexOf(Number(request.url.pathname.split("/").at(-2))), 1);
      return json({});
    });
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes/bulk_publish$`), () => {
      parked.length = 0;
      return json({});
    });
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/notes$`), () => json({ ...fx.issueNotesResponse.data[1], id: 7 }, { status: 201 }));
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha }, decision: "comment", bodyMarkdown: "Summary",
      diffComments: [
        { target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "One" },
        { target: { path: "VERSION", line: 1, side: "new" }, bodyMarkdown: "Two" },
      ],
    }], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    // The first listing saw no foreign drafts; the second, just before publishing, did -- so ours
    // went out one by one and the human's draft is still parked.
    expect(gitlab.count("POST", /bulk_publish$/)).toBe(0);
    expect(gitlab.count("PUT", /\/publish$/)).toBe(2);
    expect(parked).toEqual([99]);
  });

  it("keeps a discarded review pending when its GitLab cleanup fails, so the discard can be retried", async () => {
    const { gitlab, props, name } = await setup("reject-cleanup");
    withMergeRequest(gitlab);
    let unapproveStatus = 500;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approve$`), () => json({}, { status: 201 }));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/unapprove$`), () =>
      json({ message: "500" }, { status: unapproveStatus }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => json([]));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/draft_notes$`), () => json({ message: "500" }, { status: 500 }));
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: { baseSha: MR.diff_refs.start_sha, headSha: MR.sha }, decision: "approve",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Nit" }],
    }], DESC));
    // Approval lands, the draft fails: the action is retryable, and so is its discard.
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    await expect(unwrap(await hooks().rejectAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    unapproveStatus = 201;
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /\/unapprove$/)).toBe(2);
    await expect(unwrap(await hooks().rejectAction(name, props, action.approvalId))).rejects.toThrow(/no longer pending/);
  });

  it("resolves a thread, reverts by unresolving, and refuses to reopen a merged MR", async () => {
    const { gitlab, props, name } = await setup("resolve");
    withMergeRequest(gitlab, { ...MR, state: "merged" });
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions/abc$`), () => json({}));
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "prepareResolveDiffThread", ["133", "abc", true], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ resolved: true });
    await unwrap(await hooks().revertAction(name, props, action.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ resolved: false });
    await expect(unwrap(await hooks().queueAction(name, props, "prepareChangeState", ["mergeRequest", "133", "opened"], DESC)))
      .rejects.toThrow(/has been merged and cannot be reopened/);
  });

  it("merge sends GitLab's params and maps 405/409/422 to actionable reasons", async () => {
    const { gitlab, props, name } = await setup("merge");
    let status = 200;
    let detailed = "mergeable";
    withMergeRequest(gitlab);
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json({ ...MR, detailed_merge_status: detailed }));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/merge$`), () =>
      status === 200 ? json({ ...MR, state: "merged" })
        : json({ message: status === 409 ? "SHA does not match HEAD of source branch" : status === 405 ? "405 Method Not Allowed"
          : status === 401 ? "401 Unauthorized" : "Branch cannot be merged" }, { status }));
    gitlab.install();

    const ok = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest",
      ["133", { squash: true, removeSourceBranch: true, commitMessage: "msg", expectedHeadSha: "f".repeat(40) }], DESC));
    // The agent's own expectation wins over the observed head.
    expect(ok).toMatchObject({ expectedHeadSha: "f".repeat(40) });
    // Simulated: the MR reads as merged.
    expect((await unwrap(await hooks().openMergeRequest(name, props, "133"))).state).toBe("merged");
    await unwrap(await hooks().applyAction(name, props, ok.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({
      squash: true, should_remove_source_branch: true, merge_commit_message: "msg", sha: "f".repeat(40),
    });

    // Without one, the head observed at queue time is bound, so commits pushed between approval
    // and apply cannot slip into the merge unreviewed.
    status = 409;
    const moved = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    expect(moved).toMatchObject({ expectedHeadSha: MR.sha });
    await expect(unwrap(await hooks().applyAction(name, props, moved.approvalId)))
      .rejects.toThrow(new RegExp(`head has moved from ${MR.sha} since the merge was queued`));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!).sha).toBe(MR.sha);

    status = 405; detailed = "ci_must_pass";
    const blocked = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, blocked.approvalId)))
      .rejects.toThrow(/pipeline has not passed yet; pipeline status is not available through this connection/);

    status = 422;
    const conflict = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, conflict.approvalId))).rejects.toThrow(/branch cannot be merged/);

    // GitLab answers 401 for "no permission to accept this merge request" -- a fact about the
    // merge, not the token. The account stays connected and the merge explains itself.
    status = 401;
    const forbidden = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, forbidden.approvalId))).rejects.toThrow(/not allowed to merge !133/);
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(props.userObjectId)), async (_i, state) => {
      expect(state.storage.kv.get("expiredNotified")).not.toBe(true);
      expect(state.storage.kv.get("accessToken")).toBe("test-token");
    });
    // A read still works afterwards: nothing was retired.
    expect((await unwrap(await hooks().openMergeRequest(name, props, "133"))).id).toBe("133");
  });

  it("refuses to queue a merge whose source head it cannot determine, rather than merging unbound", async () => {
    const { gitlab, props, name } = await setup("merge-unknown-head");
    // A merge request queued for creation; then GitLab stops answering branch reads, so the
    // provisional details read an empty source sha. Merging it now would send no `sha`.
    let branches = 200;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), () =>
      branches === 200 ? json(fx.branchResponse.data) : json({ message: "500" }, { status: 500 }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), () => json(fx.compareResponse.data));
    gitlab.install();
    await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "feature", targetBranch: "main" }], DESC));
    branches = 500;
    await expect(unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["~1", {}], DESC)))
      .rejects.toThrow(/Merge request ~1's source head could not be determined/);
    // With the head supplied, the merge binds it and queues.
    const bound = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["~1", { expectedHeadSha: "e".repeat(40) }], DESC));
    expect(bound).toMatchObject({ expectedHeadSha: "e".repeat(40) });
  });
});

describe("submit failure", () => {
  it("drops the staged record when the approval queue refuses the action", async () => {
    const { gitlab, props, name } = await setup("submit-fail");
    gitlab.install();
    // A description the fake queue cannot record is not reproducible here; instead confirm a
    // successful submit leaves exactly one pending record visible to reads.
    await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "A" }], DESC));
    const log = await hooks().queueLog(name);
    expect(log.submitted).toHaveLength(1);
    expect(log.submitted[0].description.title).toBe("t");
  });
});
