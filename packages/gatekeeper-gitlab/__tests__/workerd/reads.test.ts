// The gatekeeper Durable Object's reads against a fake GitLab, driven through the TestHooks
// facet the way the overseer instantiates it: normalization of the documented response shapes,
// the `diff_refs` inversion, the merge request commit order, discussion filtering, diff threads,
// caching, and the Access service-token passthrough.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, unwrap } from "./fake-gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = "group%2Fsub%2Fproject";
const PROJECT = "group/sub/project";

/** The documented fixtures re-homed under the test project so URLs and paths line up. */
function project() {
  return { ...fx.projectResponse.data, path_with_namespace: PROJECT, web_url: `https://gitlab.example.com/${PROJECT}`,
    namespace: { ...fx.projectResponse.data.namespace, full_path: "group/sub" } };
}

function fakeProject(): FakeGitLab {
  const gitlab = new FakeGitLab();
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}$`), () => json(project()));
  gitlab.on("GET", /^\/api\/v4\/user$/, () => json(fx.currentUserResponse.data));
  return gitlab;
}

describe("project", () => {
  it("describes the project binding from cached metadata", async () => {
    const fake = fakeProject();
    fake.install();
    const id = await seedAccount();
    const props = projectProps(id, PROJECT);
    const description = await unwrap(await hooks().describe("describe-project", props));
    expect(description).toMatchObject({
      url: `https://gitlab.example.com/${PROJECT}`,
      title: PROJECT,
      suggestedBindingName: "GITLAB_PROJECT",
      tsType: "GitLabProject",
    });
    const metadata = await unwrap(await hooks().projectMetadata("describe-project", props));
    expect(metadata).toMatchObject({ path: PROJECT, namespace: "group/sub", name: "Diaspora Project Site", defaultBranch: "main", visibility: "private" });
    // Second read served from the TTL cache.
    expect(fake.count("GET", new RegExp(`^/api/v4/projects/${P}$`))).toBe(1);
  });

  it("attaches the Access service-token headers when configured", async () => {
    // The worker env has no CF_ACCESS_* set; the header rule itself is covered in the node suite.
    const fake = fakeProject();
    fake.install();
    const id = await seedAccount();
    await unwrap(await hooks().projectMetadata("access-headers", projectProps(id, PROJECT)));
    const request = fake.requests.find(r => r.url.pathname === `/api/v4/projects/${P}`)!;
    expect(request.headers.get("user-agent")).toBe("Cloudflare-Gadgets");
    expect(request.headers.has("cf-access-client-id")).toBe(false);
  });
});

describe("issues", () => {
  it("normalizes an issue with label details and its discussion, skipping system notes", async () => {
    const fake = fakeProject();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1\\?`), () =>
      json({ ...fx.issueResponse.data, labels: [fx.labelDetailsResponse.data, "plain"] }));
    // The thread is read from the discussions endpoint: a system note (GitLab's "closed"
    // activity), a two-note thread whose second note is a reply, and a standalone comment.
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/issues/1/discussions`), () => json([
      { id: "sys", individual_note: true, notes: [fx.issueNotesResponse.data[0]] },
      ...fx.issueDiscussionsResponse.data,
    ]));
    fake.install();
    const id = await seedAccount();
    const props = projectProps(id, PROJECT);

    const issue = await unwrap(await hooks().openIssue("issue-read", props, "1"));
    expect(issue).toMatchObject({
      id: "1",
      url: `https://gitlab.example.com/${PROJECT}/-/issues/1`,
      state: "closed",
      labels: [{ name: "bug", color: "#d9534f", description: "Bug reported by user" }, { name: "plain" }],
      author: { username: "root", displayName: "Administrator", url: "https://gitlab.example.com/root" },
      assignees: [{ username: "lennie" }],
      commentCount: 1,
      bodyMarkdown: "Omnis vero earum sunt corporis dolor et placeat.",
    });
    expect(issue.closedAt).toEqual(new Date("2016-01-05T15:31:46.176Z"));

    const discussion = await unwrap(await hooks().discussionAll("issue-read", props, "issue", "1", 50));
    // The system note is dropped; the thread's reply is *kept* -- the notes endpoint would have
    // omitted it -- and everything reads oldest first across threads.
    expect(discussion.map(entry => [entry.id, entry.bodyMarkdown])).toEqual([
      ["1126", "discussion text"],
      ["1128", "a single comment"],
      ["1129", "reply to the discussion"],
    ]);
    expect(discussion[0]).toMatchObject({
      kind: "comment", author: { username: "root" },
      url: `https://gitlab.example.com/${PROJECT}/-/issues/1#note_1126`,
    });
    expect(fake.count("GET", /issues\/1\/notes/)).toBe(0);
  });

  it("lists issues, passing the documented query params", async () => {
    const fake = fakeProject();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/issues\\?`), () => json([fx.issueResponse.data]));
    fake.install();
    const id = await seedAccount();
    const issues = await unwrap(await hooks().listIssuesAll("issue-list", projectProps(id, PROJECT), 20));
    expect(issues.map(i => i.id)).toEqual(["1"]);
    const request = fake.requests.find(r => r.url.pathname === `/api/v4/projects/${P}/issues`)!;
    expect(request.url.searchParams.get("with_labels_details")).toBe("true");
    expect(request.url.searchParams.get("order_by")).toBe("created_at");
    expect(request.url.searchParams.get("sort")).toBe("desc");
    expect(request.url.searchParams.get("per_page")).toBe("100");
  });
});

describe("merge requests", () => {
  const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_project_id: 1, target_project_id: 1 };

  function fakeMergeRequest(): FakeGitLab {
    const fake = fakeProject();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(MR));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json(fx.approvalsResponse.data));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/diffs`), () => json(fx.mergeRequestDiffsResponse.data));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/commits`), request =>
      // GitLab lists newest first.
      json(request.url.searchParams.get("page") === "1"
        ? [{ ...fx.commitResponse.data, id: "b".repeat(40) }, { ...fx.commitResponse.data, id: "a".repeat(40) }]
        : []));
    // A diff thread whose reply GitLab returns as a positionless DiscussionNote, and a plain note.
    const diffReply = { ...fx.issueNotesResponse.data[1], id: 1130, body: "reply on the diff", type: "DiscussionNote" as const, position: undefined };
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/discussions`), () => json([
      { ...fx.diffDiscussionResponse.data, notes: [...fx.diffDiscussionResponse.data.notes, diffReply] },
      { id: "plain", individual_note: true, notes: [fx.issueNotesResponse.data[1]] },
    ]));
    return fake;
  }

  it("normalizes details: state, source/target, approvers, merge status, changes_count", async () => {
    const fake = fakeMergeRequest();
    fake.install();
    const id = await seedAccount();
    const mr = await unwrap(await hooks().openMergeRequest("mr-read", projectProps(id, PROJECT), "133"));
    expect(mr).toMatchObject({
      id: "133",
      url: `https://gitlab.example.com/${PROJECT}/-/merge_requests/133`,
      state: "opened",
      draft: false,
      source: { branch: "manual-job-rules", sha: MR.sha, project: { path: PROJECT } },
      target: { branch: "main", sha: MR.diff_refs.start_sha, project: { path: PROJECT } },
      mergeStatus: "mergeable",
      hasConflicts: false,
      canMerge: true,
      approvedBy: [{ username: "root" }],
      changedFiles: 1,
    });
    expect(mr).not.toHaveProperty("changedFilesTruncated");
    expect(mr.author?.username).toBe("marcel.amirault");
  });

  it("maps diff_refs the right way round: start_sha is our baseSha, base_sha the merge base", async () => {
    const fake = fakeMergeRequest();
    fake.install();
    const id = await seedAccount();
    const props = projectProps(id, PROJECT);
    const diff = await unwrap(await hooks().diffAll("mr-diff", props, "133"));
    expect(diff.revision).toEqual({
      baseSha: MR.diff_refs.start_sha,
      headSha: MR.diff_refs.head_sha,
      mergeBaseSha: MR.diff_refs.base_sha,
    });
    expect(diff.files.map(f => f.path)).toEqual(["README", "VERSION"]);
    expect(diff.files[0]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(diff.files[0].hunks[0].lines.map(l => l.kind)).toEqual(["removed", "added"]);
    // The merge base comes from diff_refs without a /merge_base call.
    expect(await unwrap(await hooks().mergeBase("mr-diff", props, "133"))).toBe(MR.diff_refs.base_sha);
    expect(fake.count("GET", /merge_base/)).toBe(0);
  });

  it("returns merge request commits oldest first, reversing GitLab's order", async () => {
    fakeMergeRequest().install();
    const id = await seedAccount();
    const commits = await unwrap(await hooks().mergeRequestCommitsAll("mr-commits", projectProps(id, PROJECT), "133"));
    expect(commits.map(c => c.id)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  it("groups diff discussions into threads with targets and resolution, ignoring plain notes", async () => {
    fakeMergeRequest().install();
    const id = await seedAccount();
    const threads = await unwrap(await hooks().threadsAll("mr-threads", projectProps(id, PROJECT), "133"));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: fx.diffDiscussionResponse.data.id,
      target: { path: "package.json", subjectType: "line", line: 11, side: "old", startLine: 10, startSide: "new" },
      isResolved: false,
      // The fixture's position head differs from the merge request's current head.
      isOutdated: true,
      comments: [
        { id: "1128", bodyMarkdown: "diff comment", author: { username: "root" } },
        { id: "1130", bodyMarkdown: "reply on the diff" },
      ],
    });
    expect(threads[0].comments[0].url).toBe(`https://gitlab.example.com/${PROJECT}/-/merge_requests/133#note_1128`);
  });

  it("keeps a diff thread's replies out of the discussion, whether or not GitLab repeats the position on them", async () => {
    fakeMergeRequest().install();
    const id = await seedAccount();
    const discussion = await unwrap(await hooks().discussionAll("mr-discussion", projectProps(id, PROJECT), "mergeRequest", "133", 50));
    // The thread is classified by its root note, so the reply follows it to readDiffThreads();
    // only the plain note remains.
    expect(discussion.map(entry => entry.id)).toEqual(["305"]);
  });

  it("lists merge requests with the wip draft filter spelling and state=all", async () => {
    const fake = fakeMergeRequest();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests\\?`), () => json([MR]));
    fake.install();
    const id = await seedAccount();
    const mrs = await unwrap(await hooks().listMergeRequestsAll("mr-list", projectProps(id, PROJECT), 20));
    expect(mrs.map(m => m.id)).toEqual(["133"]);
    const request = fake.requests.find(r => r.url.pathname === `/api/v4/projects/${P}/merge_requests`)!;
    expect(request.url.searchParams.get("state")).toBe("all");
    expect(request.url.searchParams.has("wip")).toBe(false);
  });
});

describe("repository", () => {
  it("resolves refs and reads commits via the single commit endpoint, encoding names whole", async () => {
    const fake = fakeProject();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/commits/`), request =>
      request.url.pathname.endsWith("/nope") ? json({ message: "404 Commit Not Found" }, { status: 404 }) : json(fx.commitResponse.data));
    fake.install();
    const id = await seedAccount();
    const props = projectProps(id, PROJECT);

    const resolved = await unwrap(await hooks().resolveRef("repo-refs", props, "release/1"));
    expect(resolved).toEqual({ id: fx.commitResponse.data.id, fromCache: false });
    expect(fake.requests.at(-1)!.url.pathname).toBe(`/api/v4/projects/${P}/repository/commits/release%2F1`);

    const byDefault = await unwrap(await hooks().getCommit("repo-refs", props, undefined));
    expect(byDefault.details).toMatchObject({
      id: fx.commitResponse.data.id,
      message: "Sanitize for network graph",
      author: { name: "randx", email: "user@example.com" },
      parents: ["ae1d9fb46aa2b07ee9836d49862ec4e2c46fbbba"],
      stats: { additions: 15, deletions: 10, total: 25 },
    });
    // The default branch came from project metadata.
    expect(fake.requests.at(-1)!.url.pathname).toBe(`/api/v4/projects/${P}/repository/commits/main`);

    await expect(unwrap(await hooks().resolveRef("repo-refs", props, "nope"))).rejects.toThrow(/No commit found for ref "nope"/);
  });

  it("lists branches and history with the documented params", async () => {
    const fake = fakeProject();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches\\?`), () => json([fx.branchResponse.data]));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/commits\\?`), () => json([fx.commitResponse.data]));
    fake.install();
    const id = await seedAccount();
    const props = projectProps(id, PROJECT);

    const branches = await unwrap(await hooks().listBranchesAll("repo-lists", props, 20));
    expect(branches).toEqual([{ name: "main", headCommit: fx.branchResponse.data.commit.id, protected: true, default: true }]);

    const commits = await unwrap(await hooks().listCommitsAll("repo-lists", props, 20));
    expect(commits).toHaveLength(1);
    const request = fake.requests.find(r => r.url.pathname === `/api/v4/projects/${P}/repository/commits`)!;
    expect(request.url.searchParams.get("ref_name")).toBe("main");
  });
});
