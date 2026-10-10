// The events a GitLab webhook delivers, as the driver queues them for hooks, and how each
// delivery's payload is read into one. Kept out of the driver (gitlab-hooks.ts), which needs the
// Workers runtime, so the contract checks in `__tests__/contract` can run it on what GitLab
// really sends.

import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import type { EntityKind } from "./gitlab-action-types";
import { actorFromUsername } from "./gitlab-normalize";
import type { GitLabActor, GitLabIssueEvent, GitLabMergeRequestEvent, GitLabReviewDecision } from "./types";

/** The issue or merge request an event concerns, or a hook watches. */
export type GitLabEventTarget = { kind: EntityKind; iid: number };

/** One event a webhook delivered, as the driver queues it for each hook and the facet delivers it. */
export type GitLabWebhookEvent = {
  /** The delivery's `webhook-id`, the same for each delivery of one event. */
  id: string;
  projectId: number;
  actor: GitLabActor | null;
} & (
  | { kind: "issue"; action: GitLabIssueEvent["action"]; target: GitLabEventTarget }
  | { kind: "mergeRequest"; action: GitLabMergeRequestEvent["action"]; target: GitLabEventTarget }
  /** Named only: the facet reads the comment from GitLab, which a payload need not match. */
  | { kind: "comment"; target: GitLabEventTarget; noteId: number; discussionId: string }
  | { kind: "review"; target: GitLabEventTarget; decision: GitLabReviewDecision }
  | { kind: "push"; branch: string; before?: string; after?: string }
  | { kind: "tag"; tag: string; before?: string; after?: string }
);

/** A user as a webhook names one: in an issue, merge request or note payload's `user`. */
type WebhookUser = { id?: unknown; username?: unknown; name?: unknown; avatar_url?: unknown };

/** What `parseWebhookEvent` reads of a payload. */
export type WebhookPayload = {
  object_kind?: unknown;
  project_id?: unknown;
  project?: { id?: unknown } | null;
  user?: WebhookUser | null;
  object_attributes?: Record<string, unknown> | null;
  changes?: {
    draft?: { previous?: unknown; current?: unknown };
    /** The reviewers before and after, with their review states. */
    reviewers?: [Array<WebhookUser & { state?: unknown }>, Array<WebhookUser & { state?: unknown }>];
  } | null;
  issue?: { iid?: unknown } | null;
  merge_request?: { iid?: unknown } | null;
  ref?: unknown;
  before?: unknown;
  after?: unknown;
  user_id?: unknown;
  user_username?: unknown;
  user_name?: unknown;
  user_avatar?: unknown;
} | null;

const ISSUE_ACTIONS = new Map<unknown, GitLabIssueEvent["action"]>([
  ["open", "opened"], ["close", "closed"], ["reopen", "reopened"],
]);

const MERGE_REQUEST_ACTIONS = new Map<unknown, GitLabMergeRequestEvent["action"]>([
  ["open", "opened"], ["close", "closed"], ["reopen", "reopened"], ["merge", "merged"],
]);

/** The review decisions a reviewer's new state reports, from GitLab 19.3 (approvals are their own action). */
const REVIEW_STATES = new Map<unknown, GitLabReviewDecision>([
  ["requested_changes", "requestChanges"], ["reviewed", "comment"],
]);

/**
 * The event a delivery reports, if it is one a hook can receive (an issue opened, closed or
 * reopened; a merge request opened, closed, merged, reopened, marked ready or pushed to; a new
 * comment on an issue or merge request; an approval or review; or a branch or tag push), with who
 * caused it.
 */
export function parseWebhookEvent(name: string, id: string, projectId: number, payload: WebhookPayload,
                           webUrl: string): { event: GitLabWebhookEvent; senderId?: number } | undefined {
  if (!payload) return undefined;
  const attributes = payload.object_attributes ?? {};
  const senderId = typeof payload.user?.id === "number" ? payload.user.id : undefined;
  const base = { id, projectId, actor: actorOf(webUrl, payload.user) };
  switch (name) {
    case "Issue Hook": {
      const action = ISSUE_ACTIONS.get(attributes.action);
      // `object_kind: "work_item"` is another kind of work item reported under the same name.
      if (payload.object_kind !== "issue" || !action || typeof attributes.iid !== "number") return undefined;
      return { event: { ...base, kind: "issue", action, target: { kind: "issue", iid: attributes.iid } }, senderId };
    }
    case "Merge Request Hook": {
      if (typeof attributes.iid !== "number") return undefined;
      const target = { kind: "mergeRequest", iid: attributes.iid } as const;
      const action = mergeRequestAction(attributes, payload.changes);
      if (action) return { event: { ...base, kind: "mergeRequest", action, target }, senderId };
      const decision = reviewDecision(attributes, payload.changes, senderId);
      if (!decision) return undefined;
      return { event: { ...base, kind: "review", decision, target }, senderId };
    }
    case "Note Hook": {
      // A comment created on an issue or merge request: not one on a commit or snippet, an edit,
      // or GitLab's own activity.
      const kind = attributes.noteable_type === "Issue" ? "issue"
        : attributes.noteable_type === "MergeRequest" ? "mergeRequest" : undefined;
      const noteable = kind === "issue" ? payload.issue : payload.merge_request;
      if (!kind || typeof noteable?.iid !== "number" || attributes.action !== "create") return undefined;
      if (attributes.system === true || attributes.internal === true) return undefined;
      if (typeof attributes.id !== "number" || typeof attributes.discussion_id !== "string") return undefined;
      return {
        event: {
          ...base, kind: "comment", target: { kind, iid: noteable.iid }, noteId: attributes.id,
          discussionId: attributes.discussion_id,
        },
        senderId,
      };
    }
    case "Push Hook":
    case "Tag Push Hook": {
      const { ref, before, after } = payload;
      if (typeof ref !== "string" || typeof before !== "string" || typeof after !== "string") return undefined;
      const pushed = {
        id, projectId,
        actor: actorOf(webUrl, {
          username: payload.user_username, name: payload.user_name, avatar_url: payload.user_avatar,
        }),
        // Git's all-zero id stands for no object: the push created or deleted the ref.
        ...before === ZERO_OID ? {} : { before },
        ...after === ZERO_OID ? {} : { after },
      };
      if (name === "Push Hook" && ref.startsWith("refs/heads/")) {
        return { event: { ...pushed, kind: "push", branch: ref.slice("refs/heads/".length) } };
      }
      if (name === "Tag Push Hook" && ref.startsWith("refs/tags/")) {
        return { event: { ...pushed, kind: "tag", tag: ref.slice("refs/tags/".length) } };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** What a merge request event's action and changes say happened to the merge request itself. */
function mergeRequestAction(attributes: Record<string, unknown>, changes: NonNullable<WebhookPayload>["changes"]):
    GitLabMergeRequestEvent["action"] | undefined {
  if (attributes.action !== "update") return MERGE_REQUEST_ACTIONS.get(attributes.action);
  // `oldrev` is set only when the update moved the source branch.
  if (typeof attributes.oldrev === "string" && attributes.oldrev !== "") return "pushed";
  if (changes?.draft?.previous === true && changes.draft.current === false) return "readyForReview";
  return undefined;
}

/**
 * The review a merge request event reports by `senderId`: an approval, or a review the sender
 * submitted, which GitLab 19.3 reports as their new reviewer state.
 */
function reviewDecision(attributes: Record<string, unknown>, changes: NonNullable<WebhookPayload>["changes"],
                        senderId: number | undefined): GitLabReviewDecision | undefined {
  // An approval GitLab removes or adds itself, as on a push, is no one's review.
  if (attributes.action === "approval") return attributes.system === true ? undefined : "approve";
  if (attributes.action !== "update" || senderId === undefined || !Array.isArray(changes?.reviewers)) return undefined;
  const [before, after] = changes.reviewers;
  // A re-request moves the reviewer back to `unreviewed`, which is no review.
  const now = after?.find(reviewer => reviewer.id === senderId);
  if (!now || before?.find(reviewer => reviewer.id === senderId)?.state === now.state) return undefined;
  return REVIEW_STATES.get(now.state);
}

/** The actor a webhook's user fields name, if they name one. */
function actorOf(webUrl: string, user: WebhookUser | null | undefined): GitLabActor | null {
  if (typeof user?.username !== "string") return null;
  return {
    ...actorFromUsername(webUrl, user.username),
    ...typeof user.name === "string" ? { displayName: user.name } : {},
    ...typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {},
  };
}
