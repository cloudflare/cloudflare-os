// The events a GitHub webhook delivers, as hooks receive them, and how each delivery's payload is
// read into one. Kept out of the driver (github-hooks.ts), which needs the Workers runtime, so the
// contract checks in `__tests__/contract` can run it on what GitHub really sends.

import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import { actorFromUser } from "./git-commits";
import type {
  GitHubIssueCommentResponse, GitHubIssueResponse, GitHubPullRequestResponse,
  GitHubPullRequestReviewResponse, GitHubSimpleUser,
} from "./github-api";
import type { GitHubActor, GitHubIssueEvent, GitHubPullRequestEvent } from "./types";

/**
 * GitHub's JSON for an object a webhook delivered, authenticated by the delivery's signature. Its
 * shape is GitHub's, which webhooks spell a little differently from the REST API (`null` for
 * absent values, for one), so it crosses RPC unvalidated, and the facet reads it as the REST type
 * it matches, as it reads REST responses.
 */
export type WebhookJson = Record<string, unknown>;

/** The issue or pull request a comment or review is on. */
type WebhookSubject = { title: string; pullRequest: boolean };

/** One event a webhook delivered, as the driver queues it for each hook and the facet delivers it. */
export type GitHubWebhookEvent = {
  /** A digest of the delivered payload, the same for each delivery of one event. */
  id: string;
  repoId: number;
  actor: GitHubActor | null;
} & (
  | { kind: "issue"; action: GitHubIssueEvent["action"]; number: number; issue: WebhookJson }
  | { kind: "pullRequest"; action: GitHubPullRequestEvent["action"]; number: number; pullRequest: WebhookJson }
  | { kind: "comment"; number: number; subject: WebhookSubject; comment: WebhookJson }
  | { kind: "comment"; number: number; subject: WebhookSubject; diffComment: WebhookJson }
  | { kind: "review"; number: number; subject: WebhookSubject; review: WebhookJson }
  | { kind: "push"; branch: string; before?: string; after?: string; forced: boolean }
  | { kind: "tag"; tag: string; before?: string; after?: string }
);

/** What `parseWebhookEvent` reads of a payload, in GitHub's REST shapes. */
export type WebhookPayload = {
  action?: unknown;
  repository?: { id?: unknown; pushed_at?: unknown };
  sender?: GitHubSimpleUser | null;
  issue?: GitHubIssueResponse;
  pull_request?: GitHubPullRequestResponse;
  comment?: GitHubIssueCommentResponse;
  review?: GitHubPullRequestReviewResponse;
  ref?: unknown;
  before?: unknown;
  after?: unknown;
  forced?: unknown;
} | null;

const json = (value: object) => value as WebhookJson;

const PULL_REQUEST_ACTIONS = new Map<unknown, GitHubPullRequestEvent["action"]>([
  ["opened", "opened"], ["closed", "closed"], ["reopened", "reopened"],
  ["ready_for_review", "readyForReview"], ["synchronize", "pushed"],
]);

/**
 * The event a delivery reports, if it is one a hook can receive (an issue opened, closed or
 * reopened; a pull request opened, closed, merged, reopened, marked ready or pushed to; a new
 * comment or diff comment; a review with a verdict or a summary; or a branch or tag push), with
 * when it happened and who caused it.
 */
export function parseWebhookEvent(name: string, id: string, payload: WebhookPayload):
    { event: GitHubWebhookEvent; at: number; senderId?: number } | undefined {
  const repoId = payload?.repository?.id;
  if (!payload || typeof repoId !== "number") return undefined;
  const { action, issue, pull_request: pull, comment, review, sender } = payload;
  const base = { id, repoId, actor: actorFromUser(sender) };
  const senderId = sender?.id;
  switch (name) {
    case "issues":
      if (!issue || (action !== "opened" && action !== "closed" && action !== "reopened")) return undefined;
      return {
        event: { ...base, kind: "issue", action, number: issue.number, issue: json(issue) },
        at: Date.parse(issue.updated_at), senderId,
      };
    case "pull_request": {
      const mapped = PULL_REQUEST_ACTIONS.get(action);
      if (!pull || !mapped) return undefined;
      // Webhooks list requested teams among the reviewers, where the REST API lists them apart.
      const reviewers = (pull.requested_reviewers ?? []).filter(reviewer => typeof reviewer?.login === "string");
      return {
        event: {
          ...base, kind: "pullRequest", action: mapped === "closed" && pull.merged_at ? "merged" : mapped,
          number: pull.number, pullRequest: json({ ...pull, requested_reviewers: reviewers }),
        },
        at: Date.parse(pull.updated_at), senderId,
      };
    }
    case "issue_comment":
      if (!issue || !comment || action !== "created") return undefined;
      return {
        event: {
          ...base, kind: "comment", number: issue.number,
          subject: { title: issue.title, pullRequest: !!issue.pull_request }, comment: json(comment),
        },
        at: Date.parse(comment.created_at), senderId,
      };
    case "pull_request_review_comment":
      if (!pull || !comment || action !== "created") return undefined;
      return {
        event: {
          ...base, kind: "comment", number: pull.number,
          subject: { title: pull.title, pullRequest: true }, diffComment: json(comment),
        },
        at: Date.parse(comment.created_at), senderId,
      };
    case "pull_request_review":
      // A review that only adds diff comments, such as a reply to a diff thread, is its comments.
      if (!pull || !review || action !== "submitted") return undefined;
      if (review.state.toUpperCase() === "COMMENTED" && !review.body) return undefined;
      return {
        event: {
          ...base, kind: "review", number: pull.number,
          subject: { title: pull.title, pullRequest: true }, review: json(review),
        },
        at: Date.parse(review.submitted_at ?? ""), senderId,
      };
    case "push": {
      const { ref, before, after, forced } = payload;
      if (typeof ref !== "string" || typeof before !== "string" || typeof after !== "string") return undefined;
      // Git's all-zero id stands for no object: the push created or deleted the ref.
      const moved = { ...before === ZERO_OID ? {} : { before }, ...after === ZERO_OID ? {} : { after } };
      // Seconds since the epoch in a push's payload, though the schema also allows a date string.
      const pushedAt = payload.repository?.pushed_at;
      const at = typeof pushedAt === "number" ? pushedAt * 1000
        : typeof pushedAt === "string" ? Date.parse(pushedAt) : NaN;
      if (ref.startsWith("refs/heads/")) {
        const branch = ref.slice("refs/heads/".length);
        return { event: { ...base, kind: "push", branch, forced: forced === true, ...moved }, at, senderId };
      }
      if (ref.startsWith("refs/tags/")) {
        return { event: { ...base, kind: "tag", tag: ref.slice("refs/tags/".length), ...moved }, at, senderId };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
