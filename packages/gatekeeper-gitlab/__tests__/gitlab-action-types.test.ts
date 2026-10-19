// GitLab runs a line of posted Markdown that starts with `/name` as a quick action on the issue
// or merge request, whatever the approved action said; every text this gatekeeper posts is escaped
// so that no such line runs. Also: which actions a user may let apply without a person.

import { describe, expect, it } from "vitest";
import {
  autoApprovableKinds, autoApprovalOf, escapeQuickActions, type GitLabAction,
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
  const push = (force: boolean): GitLabAction =>
    ({ ...base, type: "push", branch: "main", expectedOldSha: "a", newSha: "b", force });
  const merge: GitLabAction =
    { ...base, type: "mergeMergeRequest", mergeRequestId: "7", expectedHeadSha: "b", sourceBranch: null };

  it("lets every action but a merge and an approving review apply once its kind is enabled", () => {
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
      push(true),
    ];
    for (const action of eligible) {
      expect(autoApprovalOf(action), action.type).toMatchObject({ autoApprovable: true });
    }
    expect(autoApprovalOf(merge)).toEqual({
      actionKind: { tag: "gitlab.mergeMergeRequest", label: "Merge merge requests" },
      autoApprovable: false,
    });
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

  it("advertises, per binding, exactly the eligible kinds its actions can carry, and never a merge", () => {
    const issue = ["setTitle", "setBody", "addLabels", "removeLabels", "changeState", "postComment"]
      .map(type => `gitlab.${type}`);
    const mergeRequest = [...issue, "gitlab.postReview", "gitlab.replyToDiffComment", "gitlab.resolveDiffThread"];
    expect(tags("issue")).toEqual(issue);
    expect(tags("mergeRequest")).toEqual(mergeRequest);
    expect(tags("project")).toEqual(
      ["gitlab.createIssue", "gitlab.createMergeRequest", ...mergeRequest, "gitlab.push", "gitlab.forcePush"]);
  });
});
