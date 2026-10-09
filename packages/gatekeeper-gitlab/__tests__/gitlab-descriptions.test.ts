// The approval cards whose text binds what the approver agrees to: a merge names the head it will
// merge, a push names the ref move it will make but can never show the commits themselves, so it
// must never claim to be complete, and a comment says that its quick-action lines will not run.

import { describe, expect, it } from "vitest";
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import { describeGitLabAction } from "../src/gitlab-descriptions";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const BASE = { approvalId: 1, submittedAt: 0, projectPath: "group/project" };

describe("push card", () => {
  it("names the branch and both heads, and never claims to be complete", () => {
    const card = describeGitLabAction({ ...BASE, type: "push", branch: "main", expectedOldSha: OLD, newSha: NEW, force: false });
    expect(card.fields).toEqual([
      { label: "Branch", kind: "inline", value: "main" },
      { label: "Current head", kind: "inline", value: OLD },
      { label: "New head", kind: "inline", value: NEW },
    ]);
    expect(card.descriptionIsComplete).not.toBe(true);
    expect(card.description).not.toMatch(/force push/);
  });

  it("warns of a force push", () => {
    const card = describeGitLabAction({ ...BASE, type: "push", branch: "main", expectedOldSha: OLD, newSha: NEW, force: true });
    expect(card.description).toMatch(/force push: it rewrites the branch's history/);
    expect(card.descriptionIsComplete).not.toBe(true);
  });

  it("has no current head for a push that creates the branch", () => {
    const card = describeGitLabAction({ ...BASE, type: "push", branch: "feature", expectedOldSha: ZERO_OID, newSha: NEW, force: false });
    expect(card.fields).toEqual([
      { label: "Branch", kind: "inline", value: "feature" },
      { label: "New head", kind: "inline", value: NEW },
    ]);
    expect(card.descriptionIsComplete).not.toBe(true);
  });
});

describe("merge card", () => {
  it("names the head the merge is bound to and every option it sends", () => {
    const card = describeGitLabAction({
      ...BASE, type: "mergeMergeRequest", mergeRequestId: "7", expectedHeadSha: NEW, sourceBranch: "feature",
      options: { squash: true, removeSourceBranch: false, commitMessage: "Merge it", squashCommitMessage: "Squashed" },
    });
    expect(card.fields).toEqual([
      { label: "Expected head", kind: "inline", value: NEW },
      { label: "Squash commits", kind: "inline", value: "yes" },
      { label: "Delete source branch", kind: "inline", value: "no" },
      expect.objectContaining({ label: "Merge commit message", kind: "text", value: "Merge it" }),
      expect.objectContaining({ label: "Squash commit message", kind: "text", value: "Squashed" }),
    ]);
    expect(card.descriptionIsComplete).toBe(true);
  });

  it("shows only the head when no options are given", () => {
    const card = describeGitLabAction({
      ...BASE, type: "mergeMergeRequest", mergeRequestId: "7", expectedHeadSha: NEW, sourceBranch: null,
    });
    expect(card.fields).toEqual([{ label: "Expected head", kind: "inline", value: NEW }]);
  });
});

describe("comment card", () => {
  const COMMENT = { ...BASE, type: "postComment", targetKind: "mergeRequest", targetId: "7", provisionalCommentId: "~comment1" } as const;

  it("shows the comment as written and warns that escaped lines carry a backslash code blocks show", () => {
    // GitLab would never run a line inside a fence, but it is escaped anyway, so it posts changed.
    const body = "Try this:\n```\n/help\n```";
    const card = describeGitLabAction({ ...COMMENT, bodyMarkdown: body });
    expect(card.fields).toEqual([expect.objectContaining({ label: "Comment", value: body })]);
    expect(card.description).toMatch(/backslash/);
    expect(card.description).toMatch(/code block/);
  });

  it("says nothing of quick actions when no line would run one", () => {
    const card = describeGitLabAction({ ...COMMENT, bodyMarkdown: "see /approve" });
    expect(card.description).not.toMatch(/quick action/);
  });
});
