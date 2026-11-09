import type {
  AdminWorkspaceAccess, AdminWriteAction, AdminWriteArgs,
} from '@gadgets/workshop-shared/api'

/** What each write does, as the approval page names it. */
export const WRITE_ACTION_LABELS: Record<AdminWriteAction, string> = {
  stopAgent: 'Stop the agent',
  retryAgent: 'Retry the agent',
  restartWorkspace: 'Restart the workspace',
  addCollaborator: 'Add a collaborator',
  deleteChat: 'Delete a chat',
  revertChat: 'Revert a chat',
  revertGadget: "Restore a gadget's earlier version",
  deleteGadget: 'Delete a gadget',
  deleteWorkspace: 'Delete the workspace',
  rejectPendingActions: 'Reject pending actions',
  removeConnection: 'Remove a connection',
}

/** What each argument of a write is called, in the order the approval page lists them. */
export const WRITE_ARG_LABELS: Record<keyof AdminWriteArgs, string> = {
  chatId: 'Chat',
  modelId: 'Model',
  revertFrom: 'Revert from message',
  gadgetId: 'Gadget',
  commitId: 'Version',
  gatekeeperId: 'Connection',
  username: 'User',
  grant: 'Grant',
  note: 'Note',
}

// What a write covers when the optional argument that would narrow it is left out.
const WIDENED: Partial<Record<AdminWriteAction, Partial<Record<keyof AdminWriteArgs, string>>>> = {
  retryAgent: { modelId: "The chat's most recent one" },
  rejectPendingActions: { gatekeeperId: 'Every connection' },
}

const shownArg = (
  action: AdminWriteAction, args: AdminWriteArgs, key: keyof AdminWriteArgs,
): string | undefined => {
  if (key === 'grant') {
    if (args.grant === undefined) return undefined
    return args.grant === 'workspace' ? 'The whole workspace' : `Gadget ${args.grant.gadgetId}`
  }
  const value = args[key]
  return value === undefined ? WIDENED[action]?.[key] : String(value)
}

/**
 * A request's arguments as rows of label and value, in the order of WRITE_ARG_LABELS. An optional
 * argument that widens the write when left out gets a row saying what the write then covers, so
 * that an absent argument never reads as nothing.
 */
export const writeArgRows = (
  action: AdminWriteAction, args: AdminWriteArgs,
): { label: string; value: string }[] => {
  const rows: { label: string; value: string }[] = []
  for (const key of Object.keys(WRITE_ARG_LABELS) as (keyof AdminWriteArgs)[]) {
    const value = shownArg(action, args, key)
    if (value !== undefined) rows.push({ label: WRITE_ARG_LABELS[key], value })
  }
  return rows
}

/**
 * Whether the arguments name a chat, gadget, connection or version by id. The approval page shows
 * such an id as the request gives it and cannot say what it names.
 */
export const namesWorkspaceIds = (args: AdminWriteArgs): boolean =>
  args.chatId !== undefined || args.gadgetId !== undefined || args.gatekeeperId !== undefined
  || args.commitId !== undefined || (args.grant !== undefined && args.grant !== 'workspace')

/**
 * Who reads a write's reason once it is approved: those who read the workspace's action log, which
 * a collaborator who only uses a gadget does not.
 */
export const REASON_SHOWN_NOTE =
  "Once approved, this reason is shown, word for word, in the workspace's activity, to its owner "
  + 'and everyone invited to the workspace. People who were only given a gadget do not see it.'

/**
 * What the approval page says of the ids it cannot resolve. Writes are not held to the level admin
 * inspections are, so where that level is "off" the page does not advise an inspection that would
 * be refused.
 */
export const idsNote = (access: AdminWorkspaceAccess): string =>
  'Chats, gadgets, connections and versions are shown by the ids the request names. '
  + (access === 'off'
    ? 'This page does not look them up, and admin inspection of workspaces is off on this '
      + 'deployment, so what an id names cannot be checked here before you approve.'
    : 'This page does not look them up: inspect the workspace to see what an id names before you '
      + 'approve.')

/**
 * The writes nothing can take back. Reverting a chat is one, since it erases the chat's proposed
 * changes. Restoring a gadget's earlier version is not: it adds a commit on top of the head and
 * keeps the history, so the gadget can be put back the same way.
 */
export const DESTRUCTIVE_WRITES: ReadonlySet<AdminWriteAction> = new Set([
  'deleteChat', 'deleteGadget', 'deleteWorkspace', 'removeConnection', 'revertChat',
  'rejectPendingActions',
])

/** What an approver must know before confirming that the request itself does not say. */
export const WRITE_CONSEQUENCES: Partial<Record<AdminWriteAction, string>> = {
  retryAgent: "The turn runs on the owner's model and account, so the owner pays for it.",
  addCollaborator:
    'This person gets access as if the owner had added them, also in a workspace where only the '
    + 'owner may add people, and reads it as a collaborator whatever level admin inspections are '
    + "held to. They are still checked against the workspace's connected accounts before they see "
    + 'anything.',
  deleteWorkspace:
    'If the deletion completes, nobody who uses the workspace is told: its activity log is deleted '
    + 'with it, and only the audit log keeps who deleted it and why. If it fails partway, the '
    + "workspace's activity shows the attempt, with this reason.",
  rejectPendingActions:
    'A pending creation is rejected together with the connection it would have created: that '
    + 'connection is removed, with everything queued on it, as when a member rejects the creation.',
}
