import { describe, expect, it } from "vitest";
import {
  resolveActionVetoes,
  type GitHubAction,
  type StoredActionRecord,
} from "../src/github";

function action(id: number, fields: Partial<GitHubAction>): GitHubAction {
  return {
    approvalId: id,
    submittedAt: id,
    owner: "cloudflare",
    repo: "gadgets",
    type: "postComment",
    targetKind: "issue",
    targetId: "1",
    bodyMarkdown: "body",
    provisionalCommentId: `~comment${id}`,
    ...fields,
  } as GitHubAction;
}

function record(storedAction: GitHubAction, state: StoredActionRecord["state"] = "pending"):
    StoredActionRecord {
  return { action: storedAction, state };
}

describe("resolveActionVetoes", () => {
  it("invalidates future resource dependencies and reports them on retry", () => {
    const root = record(action(1, {
      type: "createIssue", provisionalId: "~issue1", options: { title: "Issue" },
    }));
    const edit = record(action(7, {
      type: "setTitle", targetKind: "issue", targetId: "~issue1", title: "New", previousTitle: "Old",
    }));
    const comment = record(action(9, { targetKind: "issue", targetId: "~issue1" }));
    const records = [root, edit, comment];

    const first = resolveActionVetoes(records, new Set([1]), 100);
    const retry = resolveActionVetoes(records, new Set([1]), 200);

    expect(first.invalidatedByVeto).toEqual([
      { action: 7, invalidatedBy: 1 },
      { action: 9, invalidatedBy: 1 },
    ]);
    expect(retry.invalidatedByVeto).toEqual(first.invalidatedByVeto);
    expect(root).toMatchObject({ state: "rejected", rejectedAt: 100 });
    expect(edit).toMatchObject({ state: "rejected", invalidatedByVeto: 1 });
  });

  it("does not let a veto overwrite an approved action", () => {
    const approved = record(action(1, {
      type: "createIssue", provisionalId: "~issue1", options: { title: "Issue" },
    }), "approved");

    const result = resolveActionVetoes([approved], new Set([1]), 100);

    expect(result.invalidatedByVeto).toBeUndefined();
    expect(result.changed).toHaveLength(0);
    expect(approved.state).toBe("approved");
  });

  it("tracks transitive reply invalidation with direct-veto precedence", () => {
    const review = record(action(1, {
      type: "postReview",
      pullId: "1",
      provisionalReviewId: "~review1",
      review: {
        revision: { baseSha: "base", headSha: "head" },
        decision: "comment",
        diffComments: [{
          provisionalCommentId: "~review-comment",
          target: { path: "file.ts", line: 1, side: "new", subjectType: "line" },
          bodyMarkdown: "review",
        }],
      },
    }));
    const directReply = record(action(2, {
      type: "replyToDiffComment", pullId: "1", commentId: "~review-comment",
      bodyMarkdown: "reply", provisionalCommentId: "~reply1",
    }));
    const nestedReply = record(action(3, {
      type: "replyToDiffComment", pullId: "1", commentId: "~reply1",
      bodyMarkdown: "nested", provisionalCommentId: "~reply2",
    }));

    const result = resolveActionVetoes([review, directReply, nestedReply], new Set([1, 2]), 100);

    expect(result.invalidatedByVeto).toEqual([{ action: 3, invalidatedBy: 2 }]);
    expect(directReply.state).toBe("rejected");
    expect(directReply.invalidatedByVeto).toBeUndefined();
    expect(nestedReply).toMatchObject({ state: "rejected", invalidatedByVeto: 2 });
  });
});
