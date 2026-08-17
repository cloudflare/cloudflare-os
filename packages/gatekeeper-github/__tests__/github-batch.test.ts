// DO-level batch-resolution tests: exercise applyActionsThrough against a real
// GitHubGatekeeperImpl facet (real storage, real staging flow), on the veto paths that never
// reach the GitHub API.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubAction } from "../src/github.js";
import type { GitHubTestParent } from "./worker.js";

const testEnv = env as unknown as {
  GITHUB_TEST_PARENT: DurableObjectNamespace<GitHubTestParent>;
};

let uniqueParent = 0;
function makeParent() {
  return testEnv.GITHUB_TEST_PARENT.getByName(`parent-${++uniqueParent}`);
}

function description(title: string): ActionDescription {
  return { title, description: title, implementsRevert: false };
}

function createIssue(approvalId: number, provisionalId: string): GitHubAction {
  return {
    type: "createIssue",
    approvalId,
    submittedAt: approvalId,
    owner: "cloudflare",
    repo: "gadgets",
    provisionalId,
    options: { title: `Issue ${approvalId}` },
  } as GitHubAction;
}

function postComment(approvalId: number, targetId: string): GitHubAction {
  return {
    type: "postComment",
    approvalId,
    submittedAt: approvalId,
    owner: "cloudflare",
    repo: "gadgets",
    targetKind: "issue",
    targetId,
    bodyMarkdown: `Comment ${approvalId}`,
    provisionalCommentId: `~comment${approvalId}`,
  } as GitHubAction;
}

describe("GitHubGatekeeperImpl.applyActionsThrough", () => {
  it("cascade-invalidates dependents of a vetoed creation and re-reports on retry", async () => {
    const parent = makeParent();
    await parent.submitAction(createIssue(1, "~issue1"), description("Create issue"));
    await parent.submitAction(postComment(2, "~issue1"), description("Comment on it"));

    const first = await parent.applyActionsThrough(2, [1]);
    const retry = await parent.applyActionsThrough(2, [1]);

    expect(first.invalidatedByVeto).toEqual([{ action: 2, invalidatedBy: 1 }]);
    expect(retry.invalidatedByVeto).toEqual(first.invalidatedByVeto);
    expect(first.stopped).toBeUndefined();
  });

  it("makes the legacy single-action path refuse a cascade-invalidated action", async () => {
    const parent = makeParent();
    await parent.submitAction(createIssue(1, "~issue1"), description("Create issue"));
    await parent.submitAction(postComment(2, "~issue1"), description("Comment on it"));

    await parent.applyActionsThrough(2, [1]);

    // An un-migrated overseer applying the orphan must see a failure, not a silent success.
    await expect(parent.applyAction(2)).rejects.toThrow("no longer pending");
  });

  it("ignores vetoes of unknown actions and returns an empty result", async () => {
    const parent = makeParent();
    await parent.submitAction(createIssue(1, "~issue1"), description("Create issue"));
    await parent.applyActionsThrough(1, [1]);

    const result = await parent.applyActionsThrough(5, [3, 5]);

    expect(result).toEqual({});
  });

  it("rejects an out-of-range veto across the RPC boundary", async () => {
    const parent = makeParent();
    await parent.submitAction(createIssue(1, "~issue1"), description("Create issue"));

    await expect(parent.applyActionsThrough(1, [2])).rejects.toThrow("Invalid veto action ID");
  });

  it("keeps the legacy reject cascading, with attribution durably re-reportable", async () => {
    const parent = makeParent();
    await parent.submitAction(createIssue(1, "~issue1"), description("Create issue"));
    await parent.submitAction(postComment(2, "~issue1"), description("Comment on it"));

    await parent.rejectAction(1);

    // The cascade recorded attribution durably, so a later batch call can still report it.
    const result = await parent.applyActionsThrough(2, [1]);
    expect(result.invalidatedByVeto).toEqual([{ action: 2, invalidatedBy: 1 }]);
  });
});
