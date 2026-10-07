// The approval cards for the two actions whose card binds what the approver agrees to: a merge
// names the head it will merge, and a push names the ref move it will make but can never show
// the commits themselves, so it must never claim to be complete.

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
