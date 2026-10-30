// GitLab runs a line of posted Markdown that starts with `/name` as a quick action on the issue
// or merge request, whatever the approved action said; every text this gatekeeper posts is escaped
// so that no such line runs. Also: which actions a user may let apply without a person.

import { describe, expect, it } from "vitest";
import {
  autoApprovableKinds, autoApprovalOf, escapeQuickActions, protectedBranchMatches, type GitLabAction,
} from "../src/gitlab-action-types";

describe("escapeQuickActions", () => {
  it("escapes every line GitLab would run, on any line of the text", () => {
    expect(escapeQuickActions("/approve")).toBe("\\/approve");
    expect(escapeQuickActions("Done.\n/clone other/project --with_notes\nThanks"))
      .toBe("Done.\n\\/clone other/project --with_notes\nThanks");
    // GitLab deletes carriage returns before matching, so each of these runs as /approve.
    expect(escapeQuickActions("Done.\r\n/app\rrove\r\n")).toBe("Done.\r\n\\/app\rrove\r\n");
    expect(escapeQuickActions("/\r\rapprove")).toBe("\\/\r\rapprove");
  });

  it("leaves lines GitLab would not run, so paths and escaped text read unchanged", () => {
    for (const text of ["see /approve", " /approve", "/usr/bin/env node", "/", "\\/approve"]) {
      expect(escapeQuickActions(text)).toBe(text);
    }
  });
});

const tags = (kind: "project" | "issue" | "mergeRequest") => autoApprovableKinds(kind).map(k => k.tag);

describe("auto-approval", () => {
  const base = { approvalId: 1, submittedAt: 0, projectPath: "group/project" };
  const entity = { ...base, targetKind: "mergeRequest" as const, targetId: "7" };
  const review = (decision: "comment" | "approve" | "requestChanges"): GitLabAction => ({
    ...base, type: "postReview", mergeRequestId: "7", provisionalReviewId: "~review1",
    review: { revision: { baseSha: "a", startSha: "a", headSha: "b" }, decision, bodyMarkdown: "x" },
  } as GitLabAction);
  const push = (force: boolean, targetProtected = false): GitLabAction =>
    ({ ...base, type: "push", branch: "feature", expectedOldSha: "a", newSha: "b", force, targetProtected });
  const merge: GitLabAction =
    { ...base, type: "mergeMergeRequest", mergeRequestId: "7", expectedHeadSha: "b", sourceBranch: null };

  it("lets every action but a merge, an approving review and a force or protected push apply once its kind is enabled", () => {
    const eligible: GitLabAction[] = [
      { ...base, type: "createIssue", provisionalId: "~1", options: { title: "t" }, assigneeIds: [] },
      { ...base, type: "createMergeRequest", provisionalId: "~1", options: { title: "t", sourceBranch: "f", targetBranch: "main" }, assigneeIds: [] },
      { ...entity, type: "setTitle", title: "t", previousTitle: "p" },
      { ...entity, type: "setBody", bodyMarkdown: "b", previousBodyMarkdown: "p" },
      { ...entity, type: "addLabels", labels: ["l"], previousLabels: [] },
      { ...entity, type: "removeLabels", labels: ["l"], previousLabels: ["l"] },
      { ...entity, type: "changeState", state: "closed", previousState: "opened" },
      { ...entity, type: "changeState", state: "opened", previousState: "closed" },
      { ...entity, type: "postComment", bodyMarkdown: "c", provisionalCommentId: "~c1" },
      review("comment"),
      review("requestChanges"),
      { ...base, type: "replyToDiffComment", mergeRequestId: "7", commentId: "9", bodyMarkdown: "r", provisionalCommentId: "~c1" },
      { ...base, type: "resolveDiffThread", mergeRequestId: "7", threadId: "d", resolved: true, previouslyResolved: false },
      { ...base, type: "resolveDiffThread", mergeRequestId: "7", threadId: "d", resolved: false, previouslyResolved: true },
      push(false),
    ];
    for (const action of eligible) {
      expect(autoApprovalOf(action), action.type).toMatchObject({ autoApprovable: true });
    }
    expect(autoApprovalOf(merge)).toEqual({
      actionKind: { tag: "gitlab.mergeMergeRequest", label: "Merge merge requests" },
      autoApprovable: false,
    });
  });

  it("keeps a push to the default or a protected branch manual under the kind that lets other pushes apply", () => {
    const kind = { tag: "gitlab.push", label: "Push commits" };
    expect(autoApprovalOf(push(false, false))).toEqual({ actionKind: kind, autoApprovable: true });
    expect(autoApprovalOf(push(false, true))).toEqual({ actionKind: kind, autoApprovable: false });
    // A record that does not say the branch was unprotected is taken as protected.
    const { targetProtected: _, ...unrecorded } = push(false) as Extract<GitLabAction, { type: "push" }>;
    expect(autoApprovalOf(unrecorded)).toEqual({ actionKind: kind, autoApprovable: false });
  });

  it("keeps a create with a bot or service account among its assignees manual under the kind that lets other creates apply", () => {
    const issue = (assignee: { assigneeIsBot?: boolean } | null): GitLabAction =>
      ({ ...base, type: "createIssue", provisionalId: "~1", options: { title: "t" }, assigneeIds: assignee ? [9] : [], ...assignee });
    const mergeRequest = (assigneeIsBot: boolean): GitLabAction => ({
      ...base, type: "createMergeRequest", provisionalId: "~1", options: { title: "t", sourceBranch: "f", targetBranch: "main" },
      assigneeIds: [9], assigneeIsBot,
    });
    const issueKind = { tag: "gitlab.createIssue", label: "Create issues" };
    const mergeRequestKind = { tag: "gitlab.createMergeRequest", label: "Create merge requests" };
    expect(autoApprovalOf(issue(null))).toEqual({ actionKind: issueKind, autoApprovable: true });
    expect(autoApprovalOf(issue({ assigneeIsBot: false }))).toEqual({ actionKind: issueKind, autoApprovable: true });
    expect(autoApprovalOf(issue({ assigneeIsBot: true }))).toEqual({ actionKind: issueKind, autoApprovable: false });
    // A record with assignees that does not say none was a bot is taken as assigned to one.
    expect(autoApprovalOf(issue({}))).toEqual({ actionKind: issueKind, autoApprovable: false });
    expect(autoApprovalOf(mergeRequest(false))).toEqual({ actionKind: mergeRequestKind, autoApprovable: true });
    expect(autoApprovalOf(mergeRequest(true))).toEqual({ actionKind: mergeRequestKind, autoApprovable: false });
  });

  it("never auto-approves a force push, whatever its branch", () => {
    const kind = { tag: "gitlab.forcePush", label: "Force-push commits" };
    expect(autoApprovalOf(push(true, false))).toEqual({ actionKind: kind, autoApprovable: false });
    expect(autoApprovalOf(push(true, true))).toEqual({ actionKind: kind, autoApprovable: false });
  });

  it("keeps an approving review manual under the kind that lets other reviews apply", () => {
    const kind = { tag: "gitlab.postReview", label: "Submit reviews that comment or request changes" };
    expect(autoApprovalOf(review("comment"))).toEqual({ actionKind: kind, autoApprovable: true });
    expect(autoApprovalOf(review("requestChanges"))).toEqual({ actionKind: kind, autoApprovable: true });
    expect(autoApprovalOf(review("approve"))).toEqual({ actionKind: kind, autoApprovable: false });
  });

  it("gives a force push its own kind, so enabling pushes does not enable rewriting history", () => {
    expect(autoApprovalOf(push(false)).actionKind?.tag).toBe("gitlab.push");
    expect(autoApprovalOf(push(true)).actionKind?.tag).toBe("gitlab.forcePush");
  });

  it("advertises, per binding, exactly the eligible kinds its actions can carry, never a merge or a force push", () => {
    const issue = ["setTitle", "setBody", "addLabels", "removeLabels", "changeState", "postComment"]
      .map(type => `gitlab.${type}`);
    const mergeRequest = [...issue, "gitlab.postReview", "gitlab.replyToDiffComment", "gitlab.resolveDiffThread"];
    expect(tags("issue")).toEqual(issue);
    expect(tags("mergeRequest")).toEqual(mergeRequest);
    expect(tags("project")).toEqual(
      ["gitlab.createIssue", "gitlab.createMergeRequest", ...mergeRequest, "gitlab.push"]);
  });
});

describe("protectedBranchMatches", () => {
  it("matches a plain rule by exact name only", () => {
    expect(protectedBranchMatches("main", "main")).toBe(true);
    expect(protectedBranchMatches("main", "main2")).toBe(false);
    expect(protectedBranchMatches("main", "Main")).toBe(false);
    expect(protectedBranchMatches("release.1", "releasex1")).toBe(false);
    expect(protectedBranchMatches("", "")).toBe(false);
  });

  it("lets each wildcard match any run of characters, slashes included, anchored at both ends", () => {
    expect(protectedBranchMatches("release/*", "release/9.9")).toBe(true);
    expect(protectedBranchMatches("release/*", "release/9/hotfix")).toBe(true);
    expect(protectedBranchMatches("release/*", "release/")).toBe(true);
    expect(protectedBranchMatches("release/*", "my-release/9")).toBe(false);
    expect(protectedBranchMatches("*-stable", "16-4-stable")).toBe(true);
    expect(protectedBranchMatches("*-stable", "16-4-stable-x")).toBe(false);
    expect(protectedBranchMatches("prod-*-eu", "prod-web-eu")).toBe(true);
    expect(protectedBranchMatches("*", "anything/at/all")).toBe(true);
    // The rest of the pattern is literal, not a regular expression.
    expect(protectedBranchMatches("v1.*", "v1x2")).toBe(false);
    expect(protectedBranchMatches("v1.*", "v1.2")).toBe(true);
    expect(protectedBranchMatches("[ab]*", "a1")).toBe(false);
    expect(protectedBranchMatches("[ab]*", "[ab]1")).toBe(true);
  });
});
