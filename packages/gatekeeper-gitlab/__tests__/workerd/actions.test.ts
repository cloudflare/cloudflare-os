// The action lifecycle on the real gatekeeper Durable Object: queue → simulated read → apply →
// revert, with GitLab faked at fetch. Covers the issue/MR mutations and their GitLab endpoints,
// provisional ids and #~N / !~N rewriting, quick-action lines posted as text, reject cascades and
// what a discarded action answers, reviews (the approval bound to the head, drafts published as
// the decision requires, every step safe to retry after a lost reply, and what a discard takes
// back), replies resolving to their discussion, thread resolution, the merge error mapping, the
// approval card rendered from the staged payload, and a refused submission.

import { env, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { GitLabGatekeeperImpl } from "../../src/gitlab-gatekeeper.js";
import { GitLabMergeRequestImpl } from "../../src/gitlab-sessions.js";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, unwrap, type FakeRequest } from "./fake-gitlab.js";
import type { ActionPresentation, GatekeeperProps } from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = "group%2Fsub%2Fproject";
const PROJECT = "group/sub/project";
const DESC: ActionPresentation = { title: "t", implementsRevert: true };
/** What applying an action answers once a discard has retired it, directly or by a cascade. */
const DISCARDED = /was discarded, or something it depended on was, so it cannot be applied/;

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

/** The writes the fake has received since request `from`, as `METHOD <last two path segments>`. */
function writes(gitlab: FakeGitLab, from = 0): string[] {
  return gitlab.requests.slice(from).filter(r => r.method !== "GET")
    .map(r => `${r.method} ${r.url.pathname.split("/").slice(-2).join("/")}`);
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

  it("serves a created issue once from a listing that was opened before its create applied", async () => {
    const { gitlab, props, name } = await setup("listing-across-apply");
    let created = false;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/issues$`), () => {
      created = true;
      return json(issue({ iid: 77, title: "New" }), { status: 201 });
    });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), () => json(created ? [issue({ iid: 77, title: "New" })] : []));
    gitlab.install();
    const create = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "New" }], DESC));
    // The listing took the provisional ~1 when it was opened, and reads GitLab's page when
    // drained -- by which time the issue is #77 there. It is one issue, served once.
    const rows = await unwrap(await hooks().listIssuesAcrossDecision(name, props, create.approvalId, 20));
    expect(rows).toHaveLength(1);
    expect(["~1", "77"]).toContain(rows[0].id);
  });

  it("serves a created issue once when its provisional row was served before its create applied", async () => {
    // Oldest first: the provisional ~1 sorts by its queue time, before #6, which someone else
    // opened after it was queued; GitLab lists the real #77 by its creation at apply, after #6
    // and on a later page. The listing served ~1 from its first page, then the create applied,
    // then page 2 arrived with #77 -- the same issue, already served under its provisional id.
    const { gitlab, props, name } = await setup("listing-served-across-apply");
    let created = false;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/issues$`), () => {
      created = true;
      return json(issue({ iid: 77, title: "New", created_at: "2101-01-01T00:00:00.000Z" }), { status: 201 });
    });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), request => request.url.searchParams.get("page") === "1"
      ? json([issue({ iid: 5, created_at: "2000-01-01T00:00:00.000Z" }), issue({ iid: 6, created_at: "2100-01-01T00:00:00.000Z" })],
        { headers: { "x-next-page": "2" } })
      : json(created ? [issue({ iid: 77, title: "New", created_at: "2101-01-01T00:00:00.000Z" })] : [],
        { headers: { "x-next-page": "" } }));
    gitlab.install();
    const create = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "New" }], DESC));
    const rows = await unwrap(await hooks().listIssuesAcrossDecision(name, props, create.approvalId, 2, {
      filter: { sort: "created", direction: "asc" }, pagesBefore: 1,
    }));
    expect(rows.map(row => row.id)).toEqual(["5", "~1", "6"]);
  });

  it("drops a provisional issue from a listing opened before its create was rejected", async () => {
    // The listing took ~1 when it was opened; by the time it is drained the create is discarded
    // and opening ~1 fails, so the listing must not offer it.
    const { gitlab, props, name } = await setup("listing-across-reject");
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), () => json([issue({ iid: 5 })]));
    gitlab.install();
    const create = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "New" }], DESC));
    const rows = await unwrap(await hooks().listIssuesAcrossDecision(name, props, create.approvalId, 20, { reject: true }));
    expect(rows.map(row => row.id)).toEqual(["5"]);
  });

  it("rejecting a create cascades to everything queued against the provisional issue, whose cards then discard cleanly", async () => {
    const { gitlab, props, name } = await setup("reject-create");
    gitlab.install();
    const create = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Doomed" }], DESC));
    const comment = await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "~1", "hello"], DESC));
    expect(comment).toMatchObject({ type: "postComment", targetId: "~1" });
    expect(await unwrap(await hooks().rejectAction(name, props, create.approvalId))).toEqual({ restart: true });
    await expect(unwrap(await hooks().openIssue(name, props, "~1"))).rejects.toThrow(/No provisional issue exists/);
    // The Workshop still shows the cascaded comment as pending (it heard back about the create
    // alone): applying it says why it cannot run, and discarding it succeeds -- as does
    // discarding the create a second time.
    await expect(unwrap(await hooks().applyAction(name, props, comment.approvalId))).rejects.toThrow(DISCARDED);
    await expect(unwrap(await hooks().rejectAction(name, props, comment.approvalId))).resolves.toBeUndefined();
    await expect(unwrap(await hooks().rejectAction(name, props, create.approvalId))).resolves.toBeUndefined();
  });

  it("rejecting a create also cascades to actions whose text names the provisional (#~N), which could never apply", async () => {
    const { gitlab, props, name } = await setup("reject-create-textual");
    gitlab.install();
    const doomed = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Doomed" }], DESC));
    await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Kept" }], DESC));
    // A third issue whose body cites the first, and a comment on the second citing the first:
    // both would fail every apply once #~1 can never resolve. ("#~1." names it: the token ends
    // at the punctuation.)
    const citing = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Follow-up", bodyMarkdown: "See #~1." }], DESC));
    const comment = await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "~2", "as in #~1"], DESC));
    // A comment citing the kept issue and a *merge request* ~1: unrelated, and stays pending.
    await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "~2", "see #~2 and !~1"], DESC));
    // Nor does #~10 name #~1: a reference is a whole token, as the apply-time rewrite reads it.
    await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "~2", "unlike #~10"], DESC));
    expect(await unwrap(await hooks().rejectAction(name, props, doomed.approvalId))).toEqual({ restart: true });
    await expect(unwrap(await hooks().applyAction(name, props, citing.approvalId))).rejects.toThrow(DISCARDED);
    await expect(unwrap(await hooks().applyAction(name, props, comment.approvalId))).rejects.toThrow(DISCARDED);
    expect((await unwrap(await hooks().openIssue(name, props, "~2"))).title).toBe("Kept");
    const discussion = await unwrap(await hooks().discussionAll(name, props, "issue", "~2", 50));
    expect(discussion.map(entry => entry.bodyMarkdown)).toEqual(["see #~2 and !~1", "unlike #~10"]);
    // The retired create's own provisional (~3) will never exist either: it is gone, and so is
    // the comment queued on it -- otherwise that comment would fail every apply forever.
    await expect(unwrap(await hooks().openIssue(name, props, "~3"))).rejects.toThrow(/No provisional issue exists/);
  });

  it("recurses the cascade through a dependent create: a comment on an issue that cited a rejected MR is retired too", async () => {
    const { gitlab, props, name } = await setup("reject-recursive");
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), () => json(fx.branchResponse.data));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), () => json(fx.compareResponse.data));
    gitlab.install();
    const mr = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest", [{ title: "x", sourceBranch: "feature", targetBranch: "main" }], DESC));
    await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Tracks", bodyMarkdown: "Tracks !~1" }], DESC));
    const onIssue = await unwrap(await hooks().queueAction(name, props, "preparePostComment", ["issue", "~2", "note"], DESC));
    expect(await unwrap(await hooks().rejectAction(name, props, mr.approvalId))).toEqual({ restart: true });
    await expect(unwrap(await hooks().openIssue(name, props, "~2"))).rejects.toThrow(/No provisional issue exists/);
    await expect(unwrap(await hooks().applyAction(name, props, onIssue.approvalId))).rejects.toThrow(DISCARDED);
  });
});

describe("issue mutations", () => {
  const labelNames = (labels: ReadonlyArray<string | { name: string }>) => labels.map(l => typeof l === "string" ? l : l.name);

  /** Issue #1 as GitLab serves and edits it; label titles match exactly, so `bug` and `Bug` are distinct. */
  function withIssue(gitlab: FakeGitLab, state: { issue: IssueJson }) {
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1\\?`), () => json(state.issue));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/issues/1$`), request => {
      const body = JSON.parse(request.body!);
      if (body.title) state.issue = { ...state.issue, title: body.title };
      if (body.state_event) state.issue = { ...state.issue, state: body.state_event === "close" ? "closed" : "opened" };
      if (body.add_labels) state.issue = { ...state.issue, labels: [...new Set([...labelNames(state.issue.labels), ...body.add_labels.split(",")])] };
      if (body.remove_labels) {
        const removed = new Set(body.remove_labels.split(","));
        state.issue = { ...state.issue, labels: labelNames(state.issue.labels).filter(l => !removed.has(l)) };
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

  it("labels: add and remove use add_labels/remove_labels, match titles exactly as GitLab does, and invert on revert", async () => {
    const { gitlab, props, name } = await setup("labels");
    const state = { issue: issue({ labels: ["bug"] }) };
    withIssue(gitlab, state);
    gitlab.install();
    const simulatedLabels = async () => (await unwrap(await hooks().openIssue(name, props, "1"))).labels.map(l => l.name);

    // `Bug` is a label of its own beside `bug`: the simulation shows what GitLab will hold.
    const add = await unwrap(await hooks().queueAction(name, props, "prepareAddLabels", ["issue", "1", ["urgent", "Bug"]], DESC));
    expect(await simulatedLabels()).toEqual(["bug", "urgent", "Bug"]);
    await unwrap(await hooks().applyAction(name, props, add.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ add_labels: "urgent,Bug" });
    expect(labelNames(state.issue.labels)).toEqual(["bug", "urgent", "Bug"]);
    // Revert removes only what the action introduced: `bug` was there before and stays.
    await unwrap(await hooks().revertAction(name, props, add.approvalId));
    expect(labelNames(state.issue.labels)).toEqual(["bug"]);

    // `BUG` was never there: removing it changes nothing, and revert does not create it.
    const remove = await unwrap(await hooks().queueAction(name, props, "prepareRemoveLabels", ["issue", "1", ["bug", "BUG"]], DESC));
    expect(await simulatedLabels()).toEqual([]);
    await unwrap(await hooks().applyAction(name, props, remove.approvalId));
    expect(labelNames(state.issue.labels)).toEqual([]);
    await unwrap(await hooks().revertAction(name, props, remove.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({ add_labels: "bug" });
    expect(labelNames(state.issue.labels)).toEqual(["bug"]);

    // Nothing to undo -- every added label was already present -- makes no request at all.
    const noop = await unwrap(await hooks().queueAction(name, props, "prepareAddLabels", ["issue", "1", ["bug"]], DESC));
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
    await expect(unwrap(await hooks().applyAction(name, props, other.approvalId))).rejects.toThrow(DISCARDED);
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

  it("posts a quick-action line as text, and reads it back before apply as GitLab will store it", async () => {
    // Unescaped, GitLab would run /clone on the issue -- copying it and its thread out of the
    // bound project -- though the approver agreed only to a comment.
    const { gitlab, props, name } = await setup("comment-quick-action");
    withIssue(gitlab, { issue: issue({ user_notes_count: 0 }) });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1/discussions`), () => json([]));
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/issues/1/notes$`), request =>
      json({ ...fx.issueNotesResponse.data[1], id: 555, body: JSON.parse(request.body!).body }, { status: 201 }));
    gitlab.install();
    const posted = "Done.\n\\/clone other/project --with_notes";

    const action = await unwrap(await hooks().queueAction(name, props, "preparePostComment",
      ["issue", "1", "Done.\n/clone other/project --with_notes"], DESC));
    const [simulated] = await unwrap(await hooks().discussionAll(name, props, "issue", "1", 50));
    expect(simulated.bodyMarkdown).toBe(posted);
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(JSON.parse(gitlab.requests.find(r => r.method === "POST")!.body!)).toEqual({ body: posted });
  });
});

const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_project_id: 1, target_project_id: 1 };
type MergeRequestJson = Omit<typeof MR, "state"> & { state: "opened" | "closed" | "merged" | "locked" };
/** The revision a review of `MR` is written against. */
const REVISION = { baseSha: MR.diff_refs.start_sha, headSha: MR.sha, mergeBaseSha: MR.diff_refs.base_sha };

function withMergeRequest(gitlab: FakeGitLab, mr: MergeRequestJson = MR) {
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(mr));
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json({ user_has_approved: false, approved_by: [] }));
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/diffs`), () => json(fx.mergeRequestDiffsResponse.data));
}

describe("merge requests", () => {
  it("creating an MR validates both branches exist, resolves assignees, prefixes Draft:, and maps a GitLab 409 verbatim", async () => {
    const { gitlab, props, name } = await setup("create-mr");
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), request =>
      request.url.pathname.endsWith("missing") ? json({ message: "404 Branch Not Found" }, { status: 404 }) : json(fx.branchResponse.data));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), () => json(fx.compareResponse.data));
    gitlab.on("GET", /^\/api\/v4\/users\?username=/, request => json(request.url.searchParams.get("username") === "lennie"
      ? fx.usersByUsernameResponse.data.map(u => ({ ...u, id: 9, username: "lennie" })) : []));
    let posted: Record<string, unknown> | undefined;
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests$`), request => {
      posted = JSON.parse(request.body!);
      return posted!.title === "Dup" ? json({ message: "Another open merge request already exists for this source branch" }, { status: 409 })
        : json({ ...MR, iid: 200, title: posted!.title }, { status: 201 });
    });
    gitlab.install();

    await expect(unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "missing", targetBranch: "main" }], DESC))).rejects.toThrow(/does not exist in group\/sub\/project. Push your commits/);
    // An assignee who does not exist is refused now, not at apply.
    await expect(unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "feature", targetBranch: "main", assignees: ["nobody"] }], DESC)))
      .rejects.toThrow('No GitLab user named "nobody" exists on this instance.');

    const action = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest", [{
      title: "Feature", sourceBranch: "feature", targetBranch: "main", draft: true, removeSourceBranch: true,
      labels: ["backend"], assignees: ["lennie"],
    }], DESC));
    expect(action).toMatchObject({ provisionalId: "~1", assigneeIds: [9] });
    const provisional = await unwrap(await hooks().openMergeRequest(name, props, "~1"));
    expect(provisional).toMatchObject({
      id: "~1", title: "Draft: Feature", draft: true, state: "opened", source: { branch: "feature" }, target: { branch: "main" },
      labels: [{ name: "backend" }], assignees: [{ username: "lennie" }],
    });

    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(posted).toEqual({
      source_branch: "feature", target_branch: "main", title: "Draft: Feature", labels: "backend", assignee_ids: [9],
      remove_source_branch: true,
    });

    const dup = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "Dup", sourceBranch: "feature", targetBranch: "main" }], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, dup.approvalId))).rejects.toThrow(/Another open merge request already exists/);
  });

  it("reads draft status from the title GitLab will see, on creation and after a queued retitle", async () => {
    const { gitlab, props, name } = await setup("draft-title");
    withMergeRequest(gitlab);
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), () => json(fx.branchResponse.data));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), () => json(fx.compareResponse.data));
    gitlab.install();
    // GitLab derives draft status from the title alone: `draft: false` with a `Draft:` title lands
    // as a draft, and the simulation says so rather than echoing the flag.
    await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "Draft: Work", sourceBranch: "feature", targetBranch: "main", draft: false }], DESC));
    expect(await unwrap(await hooks().openMergeRequest(name, props, "~1"))).toMatchObject({ title: "Draft: Work", draft: true });
    // A queued retitle of an existing merge request moves the flag with the prefix, both ways.
    expect((await unwrap(await hooks().openMergeRequest(name, props, "133"))).draft).toBe(false);
    await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["mergeRequest", "133", "[Draft] Manual job rules"], DESC));
    expect(await unwrap(await hooks().openMergeRequest(name, props, "133"))).toMatchObject({ title: "[Draft] Manual job rules", draft: true });
    await unwrap(await hooks().queueAction(name, props, "prepareSetTitle", ["mergeRequest", "133", "Manual job rules"], DESC));
    expect((await unwrap(await hooks().openMergeRequest(name, props, "133"))).draft).toBe(false);
  });

  it("refuses a provisional merge request's diff when GitLab's comparison timed out, rather than serving part of it", async () => {
    const { gitlab, props, name } = await setup("compare-timeout");
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), () => json(fx.branchResponse.data));
    let timedOut = true;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), () =>
      json({ ...fx.compareResponse.data, compare_timeout: timedOut }));
    gitlab.install();
    await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "feature", targetBranch: "main" }], DESC));
    // `diffs` may be incomplete under `compare_timeout`, and nothing in them says which files are
    // missing; a reviewer shown them would approve a change they had not seen.
    expect(await hooks().diffAll(name, props, "~1")).toEqual({ error: expect.stringMatching(/timed out comparing .* may be incomplete/) });
    // The provisional details degrade (changedFiles unknown) rather than fail.
    const details = await unwrap(await hooks().openMergeRequest(name, props, "~1"));
    expect(details.changedFiles).toBeUndefined();
    // A refused comparison is not cached: once GitLab completes it, the diff reads.
    timedOut = false;
    expect((await unwrap(await hooks().diffAll(name, props, "~1"))).files).toHaveLength(fx.compareResponse.data.diffs.length);
  });

  it("resolves a thread and reverts it to the state it was queued in, leaving alone one that was already resolved", async () => {
    const { gitlab, props, name } = await setup("resolve");
    withMergeRequest(gitlab, { ...MR, state: "merged" });
    const resolved: Record<string, boolean> = { abc: false, done: true };
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions`), () =>
      json(Object.entries(resolved).map(([id, isResolved], index) => ({
        id, individual_note: false, notes: [{ ...fx.diffDiscussionResponse.data.notes[0], id: 4001 + index, resolved: isResolved }],
      }))));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions/\\w+$`), request => {
      resolved[request.url.pathname.split("/").at(-1)!] = JSON.parse(request.body!).resolved;
      return json({});
    });
    gitlab.install();

    await expect(unwrap(await hooks().queueAction(name, props, "prepareResolveDiffThread", ["133", "nope", true], DESC)))
      .rejects.toThrow("Diff thread nope was not found on merge request !133.");
    const action = await unwrap(await hooks().queueAction(name, props, "prepareResolveDiffThread", ["133", "abc", true], DESC));
    expect(action).toMatchObject({ resolved: true, previouslyResolved: false });
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(resolved.abc).toBe(true);
    await unwrap(await hooks().revertAction(name, props, action.approvalId));
    expect(resolved.abc).toBe(false);

    // Already resolved: still queued (the request is the caller's) and applied harmlessly, but
    // its revert changes nothing -- it must not reopen a thread it found resolved.
    const again = await unwrap(await hooks().queueAction(name, props, "prepareResolveDiffThread", ["133", "done", true], DESC));
    expect(again).toMatchObject({ resolved: true, previouslyResolved: true });
    await unwrap(await hooks().applyAction(name, props, again.approvalId));
    const puts = gitlab.count("PUT", /discussions\//);
    await unwrap(await hooks().revertAction(name, props, again.approvalId));
    expect(gitlab.count("PUT", /discussions\//)).toBe(puts);
    expect(resolved.done).toBe(true);

    // The state recorded is the one the caller sees, queued resolutions included.
    await unwrap(await hooks().queueAction(name, props, "prepareResolveDiffThread", ["133", "abc", true], DESC));
    const reopen = await unwrap(await hooks().queueAction(name, props, "prepareResolveDiffThread", ["133", "abc", false], DESC));
    expect(reopen).toMatchObject({ resolved: false, previouslyResolved: true });

    await expect(unwrap(await hooks().queueAction(name, props, "prepareChangeState", ["mergeRequest", "133", "opened"], DESC)))
      .rejects.toThrow(/has been merged and cannot be reopened/);
  });

  it("merge sends GitLab's params, binds the head, and maps 405/409/422/401 to actionable reasons", async () => {
    const { gitlab, props, name } = await setup("merge");
    withMergeRequest(gitlab);
    // The merge request as GitLab holds it: pushes move its head, and a merge lands only at the
    // head it names (409 otherwise) -- unless GitLab refuses it outright first.
    const live: { sha: string; state: MergeRequestJson["state"]; detailed: string } = { sha: MR.sha, state: "opened", detailed: "mergeable" };
    let refusal: 405 | 422 | 401 | null = null;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () =>
      json({ ...MR, sha: live.sha, state: live.state, detailed_merge_status: live.detailed }));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/merge$`), request => {
      if (refusal !== null) {
        return json({ message: refusal === 405 ? "405 Method Not Allowed" : refusal === 401 ? "401 Unauthorized" : "Branch cannot be merged" },
          { status: refusal });
      }
      if (JSON.parse(request.body!).sha !== live.sha) return json({ message: "SHA does not match HEAD of source branch" }, { status: 409 });
      live.state = "merged";
      return json({ ...MR, sha: live.sha, state: "merged" });
    });
    gitlab.install();

    // The agent's own expectation wins over the observed head -- here it knows of a push this
    // read has not shown yet.
    const ok = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest",
      ["133", { squash: true, removeSourceBranch: true, commitMessage: "msg", expectedHeadSha: "f".repeat(40) }], DESC));
    expect(ok).toMatchObject({ expectedHeadSha: "f".repeat(40) });
    // Simulated: the MR reads as merged.
    expect((await unwrap(await hooks().openMergeRequest(name, props, "133"))).state).toBe("merged");
    live.sha = "f".repeat(40);
    await unwrap(await hooks().applyAction(name, props, ok.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toEqual({
      squash: true, should_remove_source_branch: true, merge_commit_message: "msg", sha: "f".repeat(40),
    });

    // Without one, the head observed at queue time is bound, so commits pushed between approval
    // and apply cannot slip into the merge unreviewed.
    Object.assign(live, { sha: MR.sha, state: "opened" });
    const moved = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    expect(moved).toMatchObject({ expectedHeadSha: MR.sha });
    live.sha = "e".repeat(40);
    await expect(unwrap(await hooks().applyAction(name, props, moved.approvalId)))
      .rejects.toThrow(new RegExp(`head has moved from ${MR.sha} since the merge was queued`));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!).sha).toBe(MR.sha);

    // 405 is "cannot merge"; the re-read names the reason.
    Object.assign(live, { sha: MR.sha, detailed: "ci_must_pass" });
    refusal = 405;
    const blocked = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, blocked.approvalId)))
      .rejects.toThrow(/pipeline has not passed yet; pipeline status is not available through this connection/);

    // It is also the answer for a merge request already merged -- as when this apply retries one
    // whose reply was lost. Merged at the bound head, that merge landed and this apply succeeds;
    // at any other head the merge was someone else's, and this one fails.
    live.detailed = "not_open";
    const landed = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    live.state = "merged";
    await unwrap(await hooks().applyAction(name, props, landed.approvalId));
    live.state = "opened";
    const elsewhere = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    Object.assign(live, { state: "merged", sha: "d".repeat(40) });
    await expect(unwrap(await hooks().applyAction(name, props, elsewhere.approvalId)))
      .rejects.toThrow("Merge request !133 cannot be merged: GitLab reports not_open.");
    Object.assign(live, { state: "opened", sha: MR.sha, detailed: "mergeable" });

    refusal = 422;
    const conflict = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, conflict.approvalId))).rejects.toThrow(/branch cannot be merged/);

    // GitLab answers 401 for "no permission to accept this merge request" -- a fact about the
    // merge, not the token. The account stays connected and the merge explains itself.
    refusal = 401;
    const forbidden = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, forbidden.approvalId))).rejects.toThrow(/not allowed to merge !133/);
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(props.userObjectId)), async (_i, state) => {
      expect(state.storage.kv.get("expiredNotified")).not.toBe(true);
    });
    expect(await unwrap(await hooks().accountToken(props.userObjectId))).toBe("test-token");
    // A read still works afterwards: nothing was retired.
    expect((await unwrap(await hooks().openMergeRequest(name, props, "133"))).id).toBe("133");
  });

  it("refuses to queue a merge whose source head it cannot determine, rather than merging unbound", async () => {
    const { gitlab, props, name } = await setup("merge-unknown-head");
    // A merge request queued for creation; then GitLab stops answering branch reads, so the
    // provisional details read no source sha. Merging it now would send no `sha`.
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

/** The account `fake()` serves at `/user`, as GitLab nests a user in approvals and notes. */
const VIEWER = {
  id: fx.currentUserResponse.data.id, username: fx.currentUserResponse.data.username,
  name: fx.currentUserResponse.data.name, web_url: fx.currentUserResponse.data.web_url,
};

type ReviewStep = "approve" | "unapprove" | "draft" | "publish" | "bulkPublish" | "note";

/**
 * GitLab's review endpoints for !133, with the state they act on: the merge request's live head,
 * the user's draft notes (a created draft joins the listing, a published or deleted one leaves
 * it), the user's approval and when it was given, the merge request's notes, and the discussions
 * published drafts become. `loseReply` makes a step carry out its effect and then fail its
 * request -- a reply lost on its way back -- and `refuse` makes one answer 500 having done nothing.
 */
class ReviewGitLab {
  head = MR.sha;
  version = "19.2.0-ee";
  /** Whether approvals carry `approved_at`, which an older instance does not report. */
  datesApprovals = true;
  approval: { at: string } | null = null;
  readonly drafts: Array<{ id: number; note: string; position: unknown }> = [];
  readonly discussions: Array<{ id: string; noteId: number; note: string; position: unknown }> = [];
  readonly notes: Array<{ id: number; body: string }> = [];
  readonly bulkPublishes: unknown[] = [];
  /** A push that lands just after the next read of the merge request. */
  pushAfterNextRead: string | null = null;
  /** Runs as each draft is created, before its reply: where a test has the user act meanwhile. */
  onDraftCreated: (id: number) => void = () => {};
  #faults = new Map<ReviewStep, { kind: "lose" | "refuse"; after: number }>();
  #nextDraftId = 1;
  #nextNoteId = 701;
  #approvals = 0;

  constructor(gitlab: FakeGitLab) {
    const on = (method: string, path: string, handler: (request: FakeRequest) => Response) =>
      gitlab.on(method, new RegExp(`^/api/v4/projects/${P}/merge_requests/133${path}`), handler);
    gitlab.on("GET", /^\/api\/v4\/metadata$/, () => json({ version: this.version }));
    on("GET", "\\?", () => {
      const response = json({ ...MR, sha: this.head });
      if (this.pushAfterNextRead !== null) [this.head, this.pushAfterNextRead] = [this.pushAfterNextRead, null];
      return response;
    });
    on("GET", "/diffs", () => json(fx.mergeRequestDiffsResponse.data));
    on("GET", "/approvals$", () => json(this.#approvalsJson()));
    on("POST", "/approve$", request => this.#step("approve", () => {
      if (JSON.parse(request.body!).sha !== this.head) return json({ message: "409 Conflict: SHA does not match HEAD of source branch" }, { status: 409 });
      if (this.approval) return json({ message: "401 Unauthorized" }, { status: 401 });
      this.approval = { at: `2026-10-02T10:00:0${++this.#approvals}.000Z` };
      return json(this.#approvalsJson(), { status: 201 });
    }));
    on("POST", "/unapprove$", () => this.#step("unapprove", () => {
      if (!this.approval) return json({ message: "404 Not found" }, { status: 404 });
      this.approval = null;
      return json(this.#approvalsJson(), { status: 201 });
    }));
    on("GET", "/draft_notes(\\?.*)?$", request => {
      // GitLab does not paginate this listing: a reader that pages it reads the whole list per page.
      if (request.url.searchParams.has("page")) throw new Error("fake GitLab: the draft notes listing is not paginated");
      return json(this.drafts.map(draft => ({ ...fx.draftNotesResponse.data[0], ...draft })));
    });
    on("POST", "/draft_notes$", request => this.#step("draft", () => {
      const { note, position } = JSON.parse(request.body!);
      const draft = { id: this.#nextDraftId++, note, position };
      this.drafts.push(draft);
      this.onDraftCreated(draft.id);
      return json({ ...fx.draftNotesResponse.data[0], ...draft }, { status: 201 });
    }));
    on("PUT", "/draft_notes/\\d+/publish$", request => this.#step("publish", () =>
      this.#publish(Number(request.url.pathname.split("/").at(-2)))
        ? new Response(null, { status: 204 }) : json({ message: "404 Not found" }, { status: 404 })));
    on("DELETE", "/draft_notes/\\d+$", request => {
      const index = this.drafts.findIndex(draft => draft.id === Number(request.url.pathname.split("/").at(-1)));
      if (index < 0) return json({ message: "404 Not found" }, { status: 404 });
      this.drafts.splice(index, 1);
      return new Response(null, { status: 204 });
    });
    on("POST", "/draft_notes/bulk_publish$", request => this.#step("bulkPublish", () => {
      this.bulkPublishes.push(JSON.parse(request.body!));
      while (this.drafts.length > 0) this.#publish(this.drafts[0].id);
      return new Response(null, { status: 204 });
    }));
    on("POST", "/notes$", request => this.#step("note", () => {
      const note = { id: this.#nextNoteId++, body: JSON.parse(request.body!).body };
      this.notes.push(note);
      return json(this.#noteJson(note), { status: 201 });
    }));
    on("GET", "/discussions", () => json(this.discussions.map(discussion => ({
      id: discussion.id, individual_note: false,
      notes: [{ ...fx.diffDiscussionResponse.data.notes[0], id: discussion.noteId, body: discussion.note, position: discussion.position }],
    }))));
  }

  /** Carry out the next `step` after `after` more of them, then fail its request: a lost reply. */
  loseReply(step: ReviewStep, after = 0): void {
    this.#faults.set(step, { kind: "lose", after });
  }

  /** Answer the next `step` after `after` more of them with a 500, having done nothing. */
  refuse(step: ReviewStep, after = 0): void {
    this.#faults.set(step, { kind: "refuse", after });
  }

  #step(step: ReviewStep, effect: () => Response): Response {
    const fault = this.#faults.get(step);
    const strikes = fault?.after === 0;
    if (strikes) this.#faults.delete(step);
    else if (fault) fault.after -= 1;
    if (strikes && fault.kind === "refuse") return json({ message: "500 Internal Server Error" }, { status: 500 });
    const response = effect();
    if (strikes && response.ok) throw new Error(`fake GitLab: the ${step} reply was lost`);
    return response;
  }

  #publish(id: number): boolean {
    const index = this.drafts.findIndex(draft => draft.id === id);
    if (index < 0) return false;
    const [draft] = this.drafts.splice(index, 1);
    this.discussions.push({ id: `disc-${id}`, noteId: 9000 + id, note: draft.note, position: draft.position });
    return true;
  }

  #approvalsJson() {
    return {
      user_has_approved: this.approval !== null,
      approved_by: this.approval ? [{ user: VIEWER, ...(this.datesApprovals ? { approved_at: this.approval.at } : {}) }] : [],
    };
  }

  #noteJson(note: { id: number; body: string }) {
    return { ...fx.issueNotesResponse.data[1], id: note.id, body: note.body, author: VIEWER, system: false };
  }
}

/** A line of `src/app.ts`, the file the positions test's diff changes. */
function appLine(side: "new" | "old", line: number) {
  return { path: "src/app.ts", line, side };
}

describe("reviews", () => {
  it("publishes an approving review: the approval bound to the head first, then each comment's draft on its own, then the summary", async () => {
    const { gitlab, props, name } = await setup("review");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();

    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve", bodyMarkdown: "LGTM",
      diffComments: [
        { target: { path: "README", subjectType: "line", line: 1, side: "new" }, bodyMarkdown: "Nit here" },
        { target: { path: "VERSION", subjectType: "line", line: 1, side: "new" }, bodyMarkdown: "Bump" },
      ],
    }], DESC));
    expect(action).toMatchObject({ type: "postReview", provisionalReviewId: "~review1" });
    // Simulated: the pending comments read as threads, under provisional ids.
    expect((await unwrap(await hooks().threadsAll(name, props, "133"))).map(thread => thread.id)).toEqual(["~diff1", "~diff2"]);

    gitlab.requests.length = 0;
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    // The approval is the compare-and-swap on the head, so it runs before anything is posted.
    // No bulk_publish: an approving review has no reviewer state to record (the approval sets
    // its own), and publishing draft by draft never touches the user's own drafts.
    expect(writes(gitlab)).toEqual([
      "POST 133/approve", "POST 133/draft_notes", "POST 133/draft_notes", "PUT 1/publish", "PUT 2/publish", "POST 133/notes",
    ]);
    expect(JSON.parse(gitlab.requests.find(r => r.url.pathname.endsWith("/approve"))!.body!)).toEqual({ sha: MR.sha });
    const drafts = gitlab.requests.filter(r => r.method === "POST" && r.url.pathname.endsWith("/draft_notes")).map(r => JSON.parse(r.body!));
    expect(drafts[0]).toMatchObject({
      note: "Nit here",
      // `+README` at line 1 is an added line: named by new_line alone.
      position: {
        position_type: "text", new_path: "README", old_path: "README", new_line: 1,
        // The inversion, outbound: GitLab's base_sha is our mergeBaseSha, its start_sha our baseSha.
        base_sha: MR.diff_refs.base_sha, start_sha: MR.diff_refs.start_sha, head_sha: MR.sha,
      },
    });
    expect(drafts[0].position).not.toHaveProperty("old_line");
    expect(gitlab.count("GET", /merge_requests\/133\/diffs/)).toBe(1);  // one diff read for both comments
    expect(review.notes.map(note => note.body)).toEqual(["LGTM"]);
    expect(review.approval).not.toBeNull();

    // Published, the comments are GitLab's threads, under its ids; a reply to one resolves its
    // discussion by note id.
    expect((await unwrap(await hooks().threadsAll(name, props, "133"))).map(thread => thread.id)).toEqual(["disc-1", "disc-2"]);
    gitlab.on("POST", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions/disc-1/notes$`), () =>
      json({ ...fx.issueNotesResponse.data[1], id: 9100 }, { status: 201 }));
    const reply = await unwrap(await hooks().queueAction(name, props, "prepareReplyToDiffComment", ["133", "9001", "thanks"], DESC));
    await unwrap(await hooks().applyAction(name, props, reply.approvalId));
    expect(gitlab.count("POST", /discussions\/disc-1\/notes$/)).toBe(1);
  });

  it("names an unchanged line by both sides, an added line by new_line, and a removed line by old_line", async () => {
    const { gitlab, props, name } = await setup("review-positions");
    const review = new ReviewGitLab(gitlab);
    // A hunk with every kind of line, with the new side shifted by two from the old:
    //   old 10 / new 12  ctx a      old 11 / -     removed
    //   -      / new 13  added      old 12 / new 14  ctx b
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/diffs`), () => json([{
      old_path: "src/app.ts", new_path: "src/app.ts", new_file: false, renamed_file: false, deleted_file: false,
      a_mode: "100644", b_mode: "100644",
      diff: "@@ -10,3 +12,3 @@\n ctx a\n-removed\n+added\n ctx b",
    }]));
    gitlab.install();

    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION,
      decision: "comment",
      diffComments: [
        { target: appLine("new", 14), bodyMarkdown: "unchanged, named from the new side" },
        { target: appLine("old", 10), bodyMarkdown: "unchanged, named from the old side" },
        { target: appLine("new", 13), bodyMarkdown: "added" },
        { target: appLine("old", 11), bodyMarkdown: "removed" },
        { target: appLine("new", 99), bodyMarkdown: "not in the diff: GitLab judges the one-sided name" },
        // A range from the added line (new side) to the removed line (old side): each end
        // carries its own side, which is what `commentTargetFromPosition` reads back.
        { target: { ...appLine("old", 11), startLine: 13, startSide: "new" }, bodyMarkdown: "mixed-side range" },
      ],
    }], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));

    const positions = review.discussions.map(discussion => discussion.position as Record<string, unknown>);
    expect(positions.map(position => [position.old_line ?? null, position.new_line ?? null])).toEqual([
      [12, 14],     // unchanged: both, with the old side's own number
      [10, 12],     // unchanged: both, resolved from the old side
      [null, 13],   // added: new_line alone
      [11, null],   // removed: old_line alone
      [null, 99],   // unknown to the diff: as the agent named it
      [11, null],   // the range's end line, as for the single removed line
    ]);
    expect(positions[5].line_range).toMatchObject({ start: { type: "new" }, end: { type: "old" } });
  });

  it("requests changes in one bulk_publish carrying its drafts and the decision, then posts the summary; it never approves", async () => {
    const { gitlab, props, name } = await setup("request-changes");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "requestChanges", bodyMarkdown: "Please fix",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "This" }],
    }], DESC));
    gitlab.requests.length = 0;
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(writes(gitlab)).toEqual(["POST 133/draft_notes", "POST draft_notes/bulk_publish", "POST 133/notes"]);
    expect(review.bulkPublishes).toEqual([{ reviewer_state: "requested_changes" }]);
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["This"]);
    expect(review.notes.map(note => note.body)).toEqual(["Please fix"]);
    expect(review.approval).toBeNull();

    // With no diff comments, the bulk_publish publishes nothing but still records the decision.
    const summaryOnly = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "requestChanges", bodyMarkdown: "And this",
    }], DESC));
    const before = gitlab.requests.length;
    await unwrap(await hooks().applyAction(name, props, summaryOnly.approvalId));
    expect(writes(gitlab, before)).toEqual(["POST draft_notes/bulk_publish", "POST 133/notes"]);
  });

  it("refuses to request changes on an instance older than 19.2, which would publish it as a plain comment", async () => {
    const { gitlab, props, name } = await setup("request-changes-old");
    const review = new ReviewGitLab(gitlab);
    review.version = "19.1.4-ee";
    gitlab.install();
    await expect(unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "requestChanges", bodyMarkdown: "Please fix",
    }], DESC))).rejects.toThrow("Requesting changes needs GitLab 19.2 or later, and this instance runs 19.1.4-ee. Post a comment review instead.");
    // A comment review records no reviewer state, so it queues.
    await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "comment", bodyMarkdown: "Please fix",
    }], DESC));
  });

  it("refuses an empty comment or requestChanges review at queue time; an empty approval still approves", async () => {
    const { gitlab, props, name } = await setup("empty-review");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();
    for (const decision of ["comment", "requestChanges"] as const) {
      await expect(unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", { revision: REVISION, decision }], DESC)))
        .rejects.toThrow(`A ${decision} review needs a summary comment or at least one diff comment.`);
    }
    const approve = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", { revision: REVISION, decision: "approve" }], DESC));
    await unwrap(await hooks().applyAction(name, props, approve.approvalId));
    expect(writes(gitlab)).toEqual(["POST 133/approve"]);
    expect(review.approval).not.toBeNull();
  });

  it("publishes a comment review's drafts one at a time, leaving the user's own drafts parked, and reads the draft listing whole", async () => {
    const { gitlab, props, name } = await setup("review-foreign-drafts");
    const review = new ReviewGitLab(gitlab);
    review.drafts.push({ id: 500, note: "my own thought", position: null });
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "comment", bodyMarkdown: "Summary",
      diffComments: [
        { target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "One" },
        { target: { path: "VERSION", line: 1, side: "new" }, bodyMarkdown: "Two" },
      ],
    }], DESC));
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["One", "Two"]);
    expect(review.drafts.map(draft => draft.id)).toEqual([500]);
    expect(gitlab.count("POST", /bulk_publish$/)).toBe(0);
    expect(gitlab.count("DELETE", /draft_notes/)).toBe(0);
    // One GET, unpaged (the fake refuses a paged read): GitLab returns the whole listing at once.
    expect(gitlab.count("GET", /draft_notes/)).toBe(1);
  });

  it("refuses to request changes while the user has drafts of their own, before creating any", async () => {
    const { gitlab, props, name } = await setup("request-changes-foreign");
    const review = new ReviewGitLab(gitlab);
    review.drafts.push({ id: 500, note: "my own thought", position: null });
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "requestChanges", bodyMarkdown: "Please fix",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Here" }],
    }], DESC));
    const before = gitlab.requests.length;
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(
      "Cannot request changes on !133: you have 1 unpublished draft comment of your own on it in GitLab, and publishing this " +
      "review would publish those too. Publish or delete them there first.");
    expect(writes(gitlab, before)).toEqual([]);
    expect(review.drafts.map(draft => draft.id)).toEqual([500]);
  });

  it("re-reads the drafts just before requesting changes, refusing over one the user started meanwhile; the retry publishes what it created", async () => {
    const { gitlab, props, name } = await setup("request-changes-late-draft");
    const review = new ReviewGitLab(gitlab);
    // The user starts a draft in GitLab's UI while the review's drafts are being created.
    review.onDraftCreated = id => {
      if (id === 1) review.drafts.push({ id: 99, note: "mine", position: null });
    };
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "requestChanges", bodyMarkdown: "Please fix",
      diffComments: [
        { target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "One" },
        { target: { path: "VERSION", line: 1, side: "new" }, bodyMarkdown: "Two" },
      ],
    }], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/you have 1 unpublished draft comment/);
    expect(review.drafts.map(draft => draft.id)).toEqual([1, 99, 2]);
    expect(review.bulkPublishes).toEqual([]);
    // The user publishes theirs; the retry knows its own two drafts and creates none.
    review.drafts.splice(review.drafts.findIndex(draft => draft.id === 99), 1);
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /draft_notes$/)).toBe(2);
    expect(review.bulkPublishes).toEqual([{ reviewer_state: "requested_changes" }]);
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["One", "Two"]);
    expect(review.notes.map(note => note.body)).toEqual(["Please fix"]);
  });

  it("repeats no step whose reply was lost, save the summary: a lost draft is adopted, a lost publish counted, a lost summary posted again", async () => {
    const { gitlab, props, name } = await setup("review-lost-replies");
    const review = new ReviewGitLab(gitlab);
    // The user's own draft, in the same words as one of the review's but anchored nowhere: not
    // the review's to adopt.
    review.drafts.push({ id: 500, note: "One", position: null });
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "comment", bodyMarkdown: "Summary",
      diffComments: [
        { target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "One" },
        { target: { path: "VERSION", line: 1, side: "new" }, bodyMarkdown: "Two" },
      ],
    }], DESC));
    const apply = async () => unwrap(await hooks().applyAction(name, props, action.approvalId));

    review.loseReply("draft");
    await expect(apply()).rejects.toThrow(/reply was lost/);
    expect(review.drafts.map(draft => draft.id)).toEqual([500, 1]);  // GitLab made it
    review.loseReply("publish");
    await expect(apply()).rejects.toThrow(/reply was lost/);
    expect(gitlab.count("POST", /draft_notes$/)).toBe(2);  // draft 1 adopted, not made again
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["One"]);  // its publish landed
    review.loseReply("note");
    await expect(apply()).rejects.toThrow(/reply was lost/);
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["One", "Two"]);
    expect(review.notes.map(note => note.body)).toEqual(["Summary"]);

    const before = gitlab.requests.length;
    await apply();
    // Draft 1 is known published though its reply never came. The summary is posted again: no
    // search could tell its lost post from an earlier note in the same words.
    expect(writes(gitlab, before)).toEqual(["POST 133/notes"]);
    expect(gitlab.count("PUT", /draft_notes\/1\/publish$/)).toBe(1);
    expect(review.notes.map(note => note.body)).toEqual(["Summary", "Summary"]);
    expect(review.drafts.map(draft => draft.id)).toEqual([500]);
  });

  it("repeats a request for changes whose bulk_publish reply was lost, and records it once answered", async () => {
    const { gitlab, props, name } = await setup("review-lost-bulk-publish");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "requestChanges", bodyMarkdown: "Please fix",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "This" }],
    }], DESC));
    review.loseReply("bulkPublish");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/reply was lost/);
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["This"]);
    await unwrap(await hooks().applyAction(name, props, action.approvalId));
    // The draft went out with the lost publish and is not made again; the publish is repeated
    // for its decision (GitLab sets the same reviewer state again), and the summary posts once.
    expect(gitlab.count("POST", /draft_notes$/)).toBe(1);
    expect(review.bulkPublishes).toEqual([{ reviewer_state: "requested_changes" }, { reviewer_state: "requested_changes" }]);
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["This"]);
    expect(review.notes.map(note => note.body)).toEqual(["Please fix"]);
  });

  it("fails clean when the head has moved: the live read refuses before anything is posted, and approve's own sha check after it", async () => {
    const { gitlab, props, name } = await setup("review-stale-head");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve", bodyMarkdown: "LGTM",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Nit" }],
    }], DESC));
    const apply = async () => unwrap(await hooks().applyAction(name, props, action.approvalId));

    review.head = "f".repeat(40);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(apply()).rejects.toThrow(
        `Merge request !133 has moved on from the reviewed revision (${MR.sha.slice(0, 12)} -> ffffffffffff)`);
    }
    expect(writes(gitlab)).toEqual([]);
    // A push between that read and the approval: GitLab refuses the stale sha (409). Nothing is
    // posted, and the refusal approved nothing, so the next attempt approves afresh.
    review.head = MR.sha;
    review.pushAfterNextRead = "e".repeat(40);
    await expect(apply()).rejects.toThrow(`Merge request !133 has moved on from the reviewed revision (${MR.sha.slice(0, 12)});`);
    expect(writes(gitlab)).toEqual(["POST 133/approve"]);
    review.head = MR.sha;
    await apply();
    expect(gitlab.count("POST", /\/approve$/)).toBe(2);
    expect(review.approval).not.toBeNull();
    expect(review.discussions.map(discussion => discussion.note)).toEqual(["Nit"]);
  });

  it("counts a lost approval as the review's own: it is not made twice, and a discard takes it back, retrying a cleanup that fails", async () => {
    const { gitlab, props, name } = await setup("review-lost-approval");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Nit" }],
    }], DESC));
    review.loseReply("approve");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/reply was lost/);
    review.refuse("draft");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    expect(gitlab.count("POST", /\/approve$/)).toBe(1);

    // A cleanup that fails keeps the action pending, so the discard can be retried; once done,
    // discarding again succeeds without doing anything more.
    review.refuse("unapprove");
    await expect(unwrap(await hooks().rejectAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    expect(review.approval).not.toBeNull();
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(review.approval).toBeNull();
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /\/unapprove$/)).toBe(2);
  });

  it("leaves alone an approval the account already held: not made again, and not withdrawn by a discard", async () => {
    const { gitlab, props, name } = await setup("review-preexisting-approval");
    const review = new ReviewGitLab(gitlab);
    review.approval = { at: "2026-09-30T08:00:00.000Z" };
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Nit" }],
    }], DESC));
    review.refuse("draft");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /\/approve$/)).toBe(0);
    expect(gitlab.count("POST", /\/unapprove$/)).toBe(0);
    expect(review.approval).toEqual({ at: "2026-09-30T08:00:00.000Z" });
  });

  it("does not withdraw an approval the user gave after the review's: GitLab dates it later", async () => {
    const { gitlab, props, name } = await setup("review-reapproved");
    const review = new ReviewGitLab(gitlab);
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Nit" }],
    }], DESC));
    review.refuse("draft");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    // The user withdraws the review's approval in GitLab and approves again.
    review.approval = { at: "2026-10-02T11:00:00.000Z" };
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /\/unapprove$/)).toBe(0);
    expect(review.approval).toEqual({ at: "2026-10-02T11:00:00.000Z" });
  });

  it("withdraws the review's approval on an instance that does not date approvals, which cannot tell it from a later one", async () => {
    const { gitlab, props, name } = await setup("review-undated-approval");
    const review = new ReviewGitLab(gitlab);
    review.datesApprovals = false;
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve",
      diffComments: [{ target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "Nit" }],
    }], DESC));
    review.refuse("draft");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/500/);
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(gitlab.count("POST", /\/unapprove$/)).toBe(1);
    expect(review.approval).toBeNull();
  });

  it("deletes a discarded review's parked drafts, including one whose creation went unanswered, and not the user's", async () => {
    const { gitlab, props, name } = await setup("review-discard-drafts");
    const review = new ReviewGitLab(gitlab);
    review.drafts.push({ id: 500, note: "mine", position: null });
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "comment",
      diffComments: [
        { target: { path: "README", line: 1, side: "new" }, bodyMarkdown: "One" },
        { target: { path: "VERSION", line: 1, side: "new" }, bodyMarkdown: "Two" },
        { target: { path: "VERSION", subjectType: "file" }, bodyMarkdown: "Three" },
      ],
    }], DESC));
    review.loseReply("draft", 1);
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId))).rejects.toThrow(/reply was lost/);
    expect(review.drafts.map(draft => draft.id)).toEqual([500, 1, 2]);
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(review.drafts.map(draft => draft.id)).toEqual([500]);
    expect(review.discussions).toEqual([]);
  });

  it("adopts no draft in the review's words that sits elsewhere: on an earlier head, or a line comment for a file comment", async () => {
    const { gitlab, props, name } = await setup("review-adopt-exact");
    const review = new ReviewGitLab(gitlab);
    // The user's own parked drafts, in the review's words and its file: one on the line the
    // review comments on but written against an earlier head, one on a line of the file the
    // review comments on as a whole.
    const versionLine = {
      position_type: "text", old_path: "VERSION", new_path: "VERSION", new_line: 1,
      base_sha: MR.diff_refs.base_sha, start_sha: MR.diff_refs.start_sha, head_sha: MR.sha,
    };
    review.drafts.push(
      { id: 500, note: "Two", position: { ...versionLine, head_sha: "0".repeat(40) } },
      { id: 501, note: "Three", position: versionLine },
    );
    gitlab.install();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "comment",
      diffComments: [
        { target: { path: "VERSION", line: 1, side: "new" }, bodyMarkdown: "Two" },
        { target: { path: "VERSION", subjectType: "file" }, bodyMarkdown: "Three" },
      ],
    }], DESC));
    const apply = async () => unwrap(await hooks().applyAction(name, props, action.approvalId));
    // Each creation fails having made nothing, so the next attempt, and then the discard, look
    // for its draft among the user's.
    review.refuse("draft");
    await expect(apply()).rejects.toThrow(/500/);
    review.refuse("draft", 1);
    await expect(apply()).rejects.toThrow(/500/);
    expect(review.drafts.map(draft => draft.id)).toEqual([500, 501, 1]);  // "Two" made afresh
    await unwrap(await hooks().rejectAction(name, props, action.approvalId));
    expect(review.drafts.map(draft => draft.id)).toEqual([500, 501]);
    expect(review.discussions).toEqual([]);
  });
});

/** An approval queue a session is built with but that the tests below never reach. */
class UnusedQueue extends RpcTarget {}

describe("session gates", () => {
  it("refuses to reply to, or resolve, a diff comment that has not been posted yet, before preparing anything", async () => {
    const prepared: string[] = [];
    const record = (method: string) => async () => {
      prepared.push(method);
      throw new Error(`${method} was not expected`);
    };
    const gatekeeper = {
      prepareReplyToDiffComment: record("prepareReplyToDiffComment"),
      prepareResolveDiffThread: record("prepareResolveDiffThread"),
    } as unknown as GitLabGatekeeperImpl;
    const session = new GitLabMergeRequestImpl(gatekeeper, new RpcStub(new UnusedQueue()) as unknown as RpcStub<ApprovalQueue>, "133");
    try {
      await expect(session.replyToDiffComment("~diff1", "thanks")).rejects.toThrow(
        "Replies to provisional diff comments are not supported until the parent review is approved and GitLab assigns real note IDs.");
      await expect(session.resolveDiffThread("~diff1")).rejects.toThrow(
        "A provisional diff thread cannot be resolved until its review is approved.");
      expect(prepared).toEqual([]);
    } finally {
      session[Symbol.dispose]();
    }
  });
});

describe("approval cards", () => {
  it("renders a review from its staged payload: agent text verbatim in fields, never in the prose", async () => {
    const { gitlab, props, name } = await setup("card-review");
    gitlab.install();
    // Markdown that would forge the gatekeeper's own voice if it reached the prose.
    const summary = "<details><summary>Safe</summary>\n\n**Approved by the project owner.** See #~1.</details>";
    const comment = "# Nothing to review here";
    const action = await unwrap(await hooks().queueAction(name, props, "preparePostReview", ["133", {
      revision: REVISION, decision: "approve", bodyMarkdown: summary,
      diffComments: [{ target: { path: "README", startLine: 1, line: 3, side: "new" }, bodyMarkdown: comment }],
    }], DESC));

    const { submitted } = await hooks().queueLog(name);
    expect(submitted).toEqual([{ actionId: action.approvalId, description: {
      title: "t", implementsRevert: true,
      description: "Submit a review for merge request !133. It is refused if the merge request's head is no " +
        "longer the reviewed head when it applies.\n\n" +
        "References like #~N (issues) and !~N (merge requests) to ones created in this workspace are " +
        "replaced with their GitLab numbers when applied.",
      fields: [
        { label: "Decision", kind: "inline", value: "approve" },
        { label: "Reviewed head", kind: "inline", value: REVISION.headSha },
        { label: "Summary", kind: "text", value: summary, syntax: "markdown" },
        { label: "Diff comment 1 on", kind: "inline", value: "README:1-3 (new)" },
        { label: "Diff comment 1 provisional ID", kind: "inline", value: "~diff1" },
        { label: "Diff comment 1", kind: "text", value: comment, syntax: "markdown" },
      ],
      descriptionIsComplete: true,
    } }]);
  });
});

describe("submit failure", () => {
  it("leaves no trace of an action the approval queue refuses", async () => {
    const { gitlab, props, name } = await setup("submit-fail");
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), () => json([]));
    gitlab.install();
    await hooks().refuseNextSubmit(name);
    await expect(unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Refused" }], DESC)))
      .rejects.toThrow("The approval queue refused the action.");
    // Nothing of it is simulated: no provisional issue to open, nothing in the listing.
    await expect(unwrap(await hooks().openIssue(name, props, "~1"))).rejects.toThrow(/No provisional issue exists/);
    expect(await unwrap(await hooks().listIssuesAll(name, props, 20))).toEqual([]);
    // The next action queues as if the refused one had never been.
    const next = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "Accepted" }], DESC));
    expect((await unwrap(await hooks().openIssue(name, props, "~2"))).title).toBe("Accepted");
    expect((await hooks().queueLog(name)).submitted.map(entry => entry.actionId)).toEqual([next.approvalId]);
  });
});
