// Auto-approval kinds and verdicts for Linear actions. Kept free of Worker imports so the policy
// can be tested on its own.

import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { RawUser } from "./linear-api";
import type { StoredActionDraft } from "./linear";

/**
 * The kind of each action, which users' auto-approval rules key on, so a tag must never change.
 * Archiving and restoring share a stored action but not a kind, so enabling restores never lets
 * an issue be archived.
 */
export const LINEAR_ACTION_KINDS = {
  createIssue: { tag: "create-issues", label: "Create issues" },
  createLabel: { tag: "create-labels", label: "Create team labels" },
  editIssue: { tag: "edit-issues", label: "Edit issue titles and descriptions" },
  planIssue: { tag: "plan-issues", label: "Change issue state, assignee, priority, project, due date and parent" },
  editLabels: { tag: "edit-labels", label: "Add and remove issue labels" },
  postComment: { tag: "post-comments", label: "Comment on issues" },
  archiveIssue: { tag: "archive-issues", label: "Archive issues" },
  restoreIssue: { tag: "restore-issues", label: "Restore archived issues" },
} satisfies Record<string, ActionKind>;

type LinearActionKind = keyof typeof LINEAR_ACTION_KINDS;

// The kinds each binding's session can submit that may be auto-approved. An issue binding cannot
// create team labels, and archiving never appears because it always waits for a person.
const ISSUE_KINDS: LinearActionKind[] =
  ["createIssue", "editIssue", "planIssue", "editLabels", "postComment", "restoreIssue"];
const BINDING_KINDS: Record<"workspace" | "team" | "issue", LinearActionKind[]> = {
  workspace: [...ISSUE_KINDS, "createLabel"],
  team: [...ISSUE_KINDS, "createLabel"],
  issue: ISSUE_KINDS,
};

/** The auto-approvable kinds a binding of `resourceKind` can submit. */
export function autoApprovableKindsOf(resourceKind: "workspace" | "team" | "issue"): ActionKind[] {
  return BINDING_KINDS[resourceKind].map(kind => LINEAR_ACTION_KINDS[kind]);
}

/**
 * Whether handing an issue to `assignee` keeps the action auto-approvable. Linear app users
 * include third-party coding agents, which start a run that executes code and may spend billed
 * credits when assigned, so only a member Linear reports as a person qualifies.
 */
function assigneeAllowsAutoApproval(assignee: RawUser | null | undefined): boolean {
  return assignee?.app === false;
}

// Image syntax in Markdown: inline, reference or shortcut (`![`), or an HTML image tag.
const MARKDOWN_IMAGE = /!\[|<img/i;

/**
 * Whether Markdown the agent wrote keeps the action auto-approvable. Linear loads an image's URL
 * in every viewer's client, so an agent-chosen URL could carry content from another bound resource
 * to its host; any image holds the write for a person, while text and links stay auto-approvable.
 */
function markdownAllowsAutoApproval(markdown: string | null | undefined): boolean {
  return !markdown || !MARKDOWN_IMAGE.test(markdown);
}

/**
 * The action's kind, and whether it may be applied without a person once the user has enabled
 * that kind. Every action may be except archiving an issue, which hides it from teammates,
 * assigning an issue to an app user, and writing Markdown that embeds an image.
 */
export function autoApprovalOf(
  action: StoredActionDraft,
): Pick<ActionDescription, "actionKind" | "autoApprovable"> {
  switch (action.kind) {
    case "createIssue":
      return {
        actionKind: LINEAR_ACTION_KINDS.createIssue,
        autoApprovable: markdownAllowsAutoApproval(action.input.description) &&
          (action.input.assigneeId === undefined || assigneeAllowsAutoApproval(action.synthetic.assignee)),
      };
    case "updateIssue": {
      // Each setter writes one field, so the field names the kind.
      const { input } = action;
      if (input.title !== undefined || input.description !== undefined) {
        return {
          actionKind: LINEAR_ACTION_KINDS.editIssue,
          autoApprovable: markdownAllowsAutoApproval(input.description),
        };
      }
      return {
        actionKind: LINEAR_ACTION_KINDS.planIssue,
        autoApprovable: !input.assigneeId || assigneeAllowsAutoApproval(action.patch.assignee),
      };
    }
    case "addLabels":
    case "removeLabels":
      return { actionKind: LINEAR_ACTION_KINDS.editLabels, autoApprovable: true };
    case "postComment":
      return {
        actionKind: LINEAR_ACTION_KINDS.postComment,
        autoApprovable: markdownAllowsAutoApproval(action.body),
      };
    case "createLabel":
      return { actionKind: LINEAR_ACTION_KINDS.createLabel, autoApprovable: true };
    case "archive":
      return action.archived
        // Opt-out: archiving is Linear's soft delete and hides the issue from teammates' views.
        ? { actionKind: LINEAR_ACTION_KINDS.archiveIssue, autoApprovable: false }
        : { actionKind: LINEAR_ACTION_KINDS.restoreIssue, autoApprovable: true };
    default: {
      const unhandled: never = action;
      throw new Error(`Unknown Linear action ${JSON.stringify(unhandled)}`);
    }
  }
}
