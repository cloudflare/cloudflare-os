import {
  ADMIN_GRANT_LIFETIME_SECONDS,
  getAdminAccessErrorCode,
  getAdminGrantErrorCode,
  getAdminWriteErrorCode,
  type AdminWorkspaceAccess,
  type AdminWriteAction,
  type AdminWriteArgs,
  type AdminWriteRequest,
} from '@gadgets/workshop-shared/api'

/** How long a grant lasts, in hours, as the admin pages say it. */
export const GRANT_HOURS = ADMIN_GRANT_LIFETIME_SECONDS / 3600

/** What each write does, as the approval page names it. */
export const WRITE_ACTION_LABELS: Record<AdminWriteAction, string> = {
  stopAgent: 'Stop the agent',
  restartWorkspace: 'Restart the workspace',
  grantContentAccess:
    `Let admins read this workspace's content for ${GRANT_HOURS} hours, without its owner's grant`,
}

/** What each argument of a write is called, in the order the approval page lists them. */
export const WRITE_ARG_LABELS: Record<keyof AdminWriteArgs, string> = {
  chatId: 'Chat',
  gatekeeperId: 'Connection',
}

// What a write covers when the optional argument that would narrow it is left out. No action
// takes an optional argument yet.
const WIDENED: Partial<Record<AdminWriteAction, Partial<Record<keyof AdminWriteArgs, string>>>> = {}

const shownArg = (
  action: AdminWriteAction, args: AdminWriteArgs, key: keyof AdminWriteArgs,
): string | undefined => {
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
 * Whether the arguments name a chat or a connection by id. The approval page shows such an id as
 * the request gives it and cannot say what it names.
 */
export const namesWorkspaceIds = (args: AdminWriteArgs): boolean =>
  args.chatId !== undefined || args.gatekeeperId !== undefined

/**
 * Who reads a write's reason once it is approved. A change to a workspace shows it to those who
 * read the workspace's action log, which a collaborator who only uses a gadget does not. A request
 * to read the workspace's content shows it to nobody there: it stays with the admins.
 */
export const reasonShownNote = (action: AdminWriteAction): string =>
  action === 'grantContentAccess'
    ? "This reason is kept in the admins' audit log. Nobody in the workspace is shown it, and the "
      + "workspace's owner is not told of the request."
    : "Once approved, this reason is shown, word for word, in the workspace's activity, to its owner "
      + 'and everyone invited to the workspace. People who were only given a gadget do not see it.'

/**
 * What the approval page says of the ids it cannot resolve. Where admin inspection is "off" the
 * page does not advise an inspection that would be refused.
 */
export const idsNote = (access: AdminWorkspaceAccess): string =>
  'Chats and connections are shown by the ids the request names. '
  + (access === 'off'
    ? 'This page does not look them up, and admin inspection of workspaces is off on this '
      + 'deployment, so what an id names cannot be checked here before you approve.'
    : 'This page does not look them up: inspect the workspace to see what an id names before you '
      + 'approve.')

/** The writes nothing can take back: none of the writes there are yet. */
export const DESTRUCTIVE_WRITES: ReadonlySet<AdminWriteAction> = new Set()

/** What an approver must know before confirming that the request itself does not say. */
export const WRITE_CONSEQUENCES: Partial<Record<AdminWriteAction, string>> = {
  grantContentAccess:
    `Once approved, every admin can read this workspace's content for ${GRANT_HOURS} hours, through `
    + "a view opened for content. The workspace's owner is not told, and nothing in the workspace "
    + 'shows it. Every read is recorded in the audit log with the grant it ran under, and an admin '
    + 'can end the grant sooner.',
}

// Only ASCII letters are folded, as the server folds them: toLowerCase() also folds some other
// characters onto ASCII ones, which would let a look-alike name read as the requester's.
const asciiLowerCase = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/**
 * Whether `request` waits for an admin other than `userId`: it asks to read a workspace's content,
 * which the admin who asked cannot approve, and `userId` is that admin. Names that differ only by
 * the case of ASCII letters are one admin, as the deployment's list of admins matches them. The
 * server decides: this only spares the requester an approval that would be refused.
 */
export const awaitsAnotherAdmin = (
  request: Pick<AdminWriteRequest, 'action' | 'requestedBy'>, userId: string,
): boolean =>
  request.action === 'grantContentAccess'
  && asciiLowerCase(request.requestedBy) === asciiLowerCase(userId)

// How a person's request reached the deployment. An agent's request is worded apart: no person
// typed it.
const VIA_LABELS: Record<Exclude<AdminWriteRequest['via'], 'gatekeeper'>, string> = {
  cli: 'through the CLI',
  api: 'through the API',
}

/**
 * Who made a request and how, as the approval page says it. A request filed through the admin
 * gatekeeper is its workspace owner's agent's, so that the approver sees no person typed it.
 */
export const requesterLabel = ({ requestedBy, via }: Pick<AdminWriteRequest, 'requestedBy' | 'via'>): string =>
  via === 'gatekeeper' ? `${requestedBy}'s agent` : `${requestedBy} ${VIA_LABELS[via]}`

/**
 * The server's own message for a refusal it names by code (an admin access, write or grant
 * refusal), which says what the admin can do about it. Undefined for any other failure.
 */
export const adminRefusalMessage = (err: unknown): string | undefined => {
  const code = getAdminAccessErrorCode(err) ?? getAdminWriteErrorCode(err) ?? getAdminGrantErrorCode(err)
  return code !== undefined && err instanceof Error ? err.message : undefined
}
