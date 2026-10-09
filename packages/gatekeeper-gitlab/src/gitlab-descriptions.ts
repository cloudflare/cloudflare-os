// The approver-facing text of each queued GitLab action, rendered from the staged payload apply
// will send. Mirrors gatekeeper-github's `describeGitHubAction`.

import {
  type ActionDescriptionBuilder, buildDescription, type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import {
  type EntityKind,
  escapeQuickActions,
  type GitLabAction,
  referenceBearingTexts,
  replaceProvisionalReferences,
} from "./gitlab-action-types";
import { mergeRequestCreateTitle } from "./gitlab-normalize";
import type { GitLabDiffCommentTarget } from "./types";

/** `#42` for an issue, `!42` for a merge request; a provisional id reads `#~1` / `!~1`. */
function reference(kind: EntityKind, id: string): string {
  return `${kind === "issue" ? "#" : "!"}${id}`;
}

// Apply posts every text `referenceBearingTexts` names with `#~N` / `!~N` replaced by the GitLab
// number of the issue or merge request created in this workspace as `~N`, and with quick-action
// lines escaped. The card shows the text as the agent wrote it and tells the approver of each.
function noteTextRewrites(builder: ActionDescriptionBuilder, action: GitLabAction): ActionDescriptionBuilder {
  const texts = referenceBearingTexts(action);
  if (texts.some(text => replaceProvisionalReferences(text, () => "") !== text)) {
    builder.prose(
      "References like #~N (issues) and !~N (merge requests) to ones created in this workspace are " +
      "replaced with their GitLab numbers when applied.");
  }
  if (texts.some(text => escapeQuickActions(text) !== text)) {
    builder.prose(
      "Lines like /approve are posted with a backslash before the slash, so GitLab does not run them " +
      "as quick actions; the backslash shows inside code blocks.");
  }
  return builder;
}

// Every coordinate apply sends: a multi-line range carries its own start side.
function diffAnchor(target: GitLabDiffCommentTarget): string {
  if (target.subjectType === "file") return `${target.path} (whole file)`;
  const start = target.startLine === undefined
    ? ""
    : `${target.startLine}${target.startSide ? ` (${target.startSide})` : ""}-`;
  return `${target.path}:${start}${target.line} (${target.side})`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * The approver-facing text for a staged action, rendered from the payload that will be applied so
 * every title, description, label, comment and commit message the agent wrote is there to read in
 * full. A push is the one action whose content (git objects) cannot be shown as text, so its
 * description never claims to be complete. Prose interpolates only the gatekeeper's logical ids
 * and the bound project; agent arguments, enums included, sit in fields.
 */
export function describeGitLabAction(action: GitLabAction): RenderedDescription {
  const project = action.projectPath;
  switch (action.type) {
    case "createIssue": {
      const { options } = action;
      return noteTextRewrites(buildDescription(`Create a new issue in ${project}.`)
        .inline("Provisional ID", action.provisionalId)
        .inline("Title", options.title)
        .verbatim("Description", options.bodyMarkdown ?? "", "markdown")
        .list("Labels", options.labels ?? [])
        .list("Assignees", options.assignees ?? []), action)
        .finish();
    }
    case "createMergeRequest": {
      const { options } = action;
      const builder = buildDescription(`Create a new merge request in ${project}.`)
        .inline("Provisional ID", action.provisionalId)
        // What GitLab receives, `Draft:` prefix included; GitLab derives draft status from it.
        .inline("Title", mergeRequestCreateTitle(options))
        .inline("Source branch", options.sourceBranch)
        .inline("Target branch", options.targetBranch)
        .verbatim("Description", options.bodyMarkdown ?? "", "markdown")
        .list("Labels", options.labels ?? [])
        .list("Assignees", options.assignees ?? []);
      if (options.removeSourceBranch !== undefined) {
        builder.inline("Delete source branch when merged", yesNo(options.removeSourceBranch));
      }
      if (options.squash !== undefined) builder.inline("Squash commits when merged", yesNo(options.squash));
      return noteTextRewrites(builder, action).finish();
    }
    case "setTitle":
      return buildDescription(`Change the title of ${reference(action.targetKind, action.targetId)}.`)
        .inline("Current title", action.previousTitle)
        .inline("New title", action.title)
        .finish();
    case "setBody":
      return noteTextRewrites(
        buildDescription(`Replace the Markdown description of ${reference(action.targetKind, action.targetId)}.`)
          .verbatim("New description", action.bodyMarkdown, "markdown"), action)
        .finish();
    case "addLabels":
      return buildDescription(`Add labels to ${reference(action.targetKind, action.targetId)}.`)
        .list("Labels", action.labels)
        .finish();
    case "removeLabels":
      return buildDescription(`Remove labels from ${reference(action.targetKind, action.targetId)}.`)
        .list("Labels", action.labels)
        .finish();
    case "changeState":
      return buildDescription(
        `${action.state === "closed" ? "Close" : "Reopen"} ${reference(action.targetKind, action.targetId)}.`)
        .finish();
    case "postComment":
      return noteTextRewrites(
        buildDescription(`Post a new Markdown comment on ${reference(action.targetKind, action.targetId)}.`)
          .verbatim("Comment", action.bodyMarkdown, "markdown"), action)
        .finish();
    case "postReview": {
      const { review } = action;
      const builder = buildDescription(
        `Submit a review for merge request !${action.mergeRequestId}. It is refused if the merge ` +
        "request's head is no longer the reviewed head when it applies.")
        .inline("Decision", review.decision)
        .inline("Reviewed head", review.revision.headSha)
        .verbatim("Summary", review.bodyMarkdown ?? "", "markdown");
      for (const [index, comment] of (review.diffComments ?? []).entries()) {
        builder
          .inline(`Diff comment ${index + 1} on`, diffAnchor(comment.target))
          .inline(`Diff comment ${index + 1} provisional ID`, comment.provisionalCommentId)
          .verbatim(`Diff comment ${index + 1}`, comment.bodyMarkdown, "markdown");
      }
      return noteTextRewrites(builder, action).finish();
    }
    case "replyToDiffComment":
      return noteTextRewrites(
        buildDescription(`Reply to a diff discussion thread on merge request !${action.mergeRequestId}.`)
          .inline("In reply to comment", action.commentId)
          .inline("Provisional ID", action.provisionalCommentId)
          .verbatim("Reply", action.bodyMarkdown, "markdown"), action)
        .finish();
    case "resolveDiffThread":
      return buildDescription(
        `${action.resolved ? "Resolve" : "Reopen"} a diff discussion thread on merge request ` +
        `!${action.mergeRequestId}.`)
        .inline("Thread", action.threadId)
        .finish();
    case "mergeMergeRequest": {
      const options = action.options ?? {};
      const builder = buildDescription(
        `Merge merge request !${action.mergeRequestId}. GitLab refuses the merge if its source ` +
        "branch's head is no longer the expected head.")
        .inline("Expected head", action.expectedHeadSha);
      if (options.squash !== undefined) builder.inline("Squash commits", yesNo(options.squash));
      if (options.removeSourceBranch !== undefined) {
        builder.inline("Delete source branch", yesNo(options.removeSourceBranch));
      }
      if (options.commitMessage !== undefined) builder.verbatim("Merge commit message", options.commitMessage);
      if (options.squashCommitMessage !== undefined) {
        builder.verbatim("Squash commit message", options.squashCommitMessage);
      }
      return builder.finish();
    }
    case "push": {
      const creating = action.expectedOldSha === ZERO_OID;
      const builder = buildDescription(creating
        ? `Push a commit to ${project}, creating the branch.`
        : `Push a commit to ${project}, moving the branch from its current head. The push is refused ` +
          "if the branch has moved from that head by the time it applies." +
          (action.force ? " This is a force push: it rewrites the branch's history." : ""))
        .inline("Branch", action.branch);
      if (!creating) builder.inline("Current head", action.expectedOldSha);
      // The commits themselves cannot be reviewed as text here, so no completeness claim.
      const { description, fields } = builder.inline("New head", action.newSha).finish();
      return { description, fields };
    }
  }
}
