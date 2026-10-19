// Which actions a user may let apply without a person, as the real `GitHubGatekeeperImpl` submits
// them: every action carries its kind, every one may auto-apply once the user enables that kind
// except a merge and an approving review, and each binding advertises only the kinds it can carry.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperProps, GitHubActionData, Outcome } from "./worker";

const OWNER = "acme";
const REPO = "widgets";

class RecordingQueue extends RpcTarget {
  readonly submitted: ActionDescription[] = [];

  async submitAction(_action: number, description: ActionDescription): Promise<void> {
    this.submitted.push(description);
  }
}

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

let nextScenario = 0;

function gatekeeper(resourceKind: GatekeeperProps["resourceKind"] = "repo") {
  const scenario = `auto-approval-${nextScenario++}`;
  const props: GatekeeperProps = {
    userObjectId: env.USER_ACCOUNT.newUniqueId().toString(), resourceKind, owner: OWNER, repo: REPO,
    ...(resourceKind === "repo" ? {} : { issueNumber: 7 }),
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return {
    advertised: async () => (await unwrap(hooks.autoApprovableActions(scenario, props))).map(kind => kind.tag),
    /** Submits each action and returns the [kind tag, verdict] the approval queue received. */
    submit: async (actions: GitHubActionData[]) => {
      const queue = new RecordingQueue();
      for (const action of actions) {
        await unwrap(hooks.submitAction(scenario, props, new RpcStub(queue) as never, action,
          { title: action.type, description: action.type, implementsRevert: false }));
      }
      return queue.submitted.map(({ actionKind, autoApprovable }) => [actionKind?.tag, autoApprovable]);
    },
  };
}

let nextApprovalId = 1;
const base = () => ({ approvalId: nextApprovalId++, submittedAt: 0, owner: OWNER, repo: REPO });
const entity = () => ({ ...base(), targetKind: "pull" as const, targetId: "7" });
const review = (decision: "comment" | "approve" | "requestChanges"): GitHubActionData => ({
  ...base(), type: "postReview", pullId: "7", provisionalReviewId: `~review${nextApprovalId}`,
  review: { revision: { baseSha: "a".repeat(40), headSha: "b".repeat(40) }, decision, bodyMarkdown: "Summary" },
});
const push = (force: boolean): GitHubActionData => ({
  ...base(), type: "push", branch: "feature", expectedOldSha: "a".repeat(40), newSha: "b".repeat(40), force,
});

describe("auto-approval", () => {
  it("lets every action but a merge apply once its kind is enabled, closing, reopening and force-pushing included", async () => {
    const submitted = await gatekeeper().submit([
      { ...base(), type: "createIssue", provisionalId: "~1", options: { title: "Bug" } },
      { ...base(), type: "createPullRequest", provisionalId: "~2", options: { title: "Fix", head: "feature", base: "main" } },
      { ...entity(), type: "setTitle", title: "New", previousTitle: "Old" },
      { ...entity(), type: "setBody", bodyMarkdown: "New", previousBodyMarkdown: "Old" },
      { ...entity(), type: "addLabels", labels: ["bug"], previousLabels: [] },
      { ...entity(), type: "removeLabels", labels: ["bug"], previousLabels: ["bug"] },
      { ...entity(), type: "changeState", state: "closed", reason: "completed", previousState: "open" },
      { ...entity(), type: "changeState", state: "open", previousState: "closed" },
      { ...entity(), type: "postComment", bodyMarkdown: "Hi", provisionalCommentId: "~comment1" },
      { ...base(), type: "replyToDiffComment", pullId: "7", commentId: "9", bodyMarkdown: "Done", provisionalCommentId: "~comment2" },
      push(false),
      push(true),
      { ...base(), type: "mergePullRequest", pullId: "7", expectedHeadSha: "b".repeat(40), headBranch: "feature" },
    ]);
    expect(submitted).toEqual([
      ["github.createIssue", true],
      ["github.createPullRequest", true],
      ["github.setTitle", true],
      ["github.setBody", true],
      ["github.addLabels", true],
      ["github.removeLabels", true],
      ["github.changeState", true],
      ["github.changeState", true],
      ["github.postComment", true],
      ["github.replyToDiffComment", true],
      ["github.push", true],
      // Its own kind: enabling ordinary pushes does not let history be rewritten.
      ["github.forcePush", true],
      ["github.mergePullRequest", false],
    ]);
  });

  it("keeps an approving review manual under the kind that lets comment and request-changes reviews apply", async () => {
    expect(await gatekeeper("pull").submit([review("comment"), review("requestChanges"), review("approve")])).toEqual([
      ["github.postReview", true],
      ["github.postReview", true],
      ["github.postReview", false],
    ]);
  });

  it("advertises, per binding, exactly the eligible kinds its actions can carry, and never a merge", async () => {
    const issue = ["setTitle", "setBody", "addLabels", "removeLabels", "changeState", "postComment"]
      .map(type => `github.${type}`);
    const pull = [...issue, "github.postReview", "github.replyToDiffComment"];
    expect(await gatekeeper("issue").advertised()).toEqual(issue);
    expect(await gatekeeper("pull").advertised()).toEqual(pull);
    expect(await gatekeeper("repo").advertised()).toEqual(
      ["github.createIssue", "github.createPullRequest", ...pull, "github.push", "github.forcePush"]);
  });
});
