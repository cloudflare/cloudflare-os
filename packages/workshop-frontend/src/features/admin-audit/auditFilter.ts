import {
  ADMIN_SETTING_METHODS,
  ADMIN_USER_METHODS,
  ADMIN_WORKSPACE_METHODS,
  type AdminAuditKind,
  type AdminAuditRecord,
} from '@gadgets/workshop-shared/api'

/** A method an audit record can name, which the Audit tab can filter by. */
export type AuditMethod = AdminAuditRecord['method']

/** The kinds of record, as the filter lists them. */
export const AUDIT_KINDS: readonly AdminAuditKind[] = ['workspace', 'user', 'setting']

/**
 * The user `record` targets, as the owner filter matches them: the owner of the workspace a call was
 * made into, or the user whose account it was made into. Undefined for a workspace whose owner is
 * not known and for a setting change, which reaches every user.
 */
export const targetUserOf = (record: AdminAuditRecord): string | undefined => {
  if (record.kind === 'setting') return undefined
  return (record.kind === 'user' ? record.userId : record.workspaceOwner) || undefined
}

/**
 * The Audit tab's filters, kept in the admin page's URL as search parameters of these names, so a
 * filtered view can be linked. Each is passed to AdminApi.listAdminAudit() as is.
 */
export type AuditFilter = {
  /** Only this admin's records, by canonical user id. */
  admin?: string
  /** Only records of calls to this method. */
  method?: AuditMethod
  /** Only records of this kind. */
  kind?: AdminAuditKind
  /** Only records of access to this workspace, by id. */
  workspace?: string
  /** Only records of access to this user's data: the workspaces they own and their account, by
   * canonical user id. */
  owner?: string
}

/**
 * The methods the Audit tab offers as filters, grouped as its Action filter lists them. A workspace's
 * view and a user account's share method names (describe, say), and a filter by one lists both
 * views' calls to it, so their methods are one group that names each once.
 */
export const AUDIT_METHOD_GROUPS: { label: string; methods: readonly AuditMethod[] }[] = [
  { label: 'Inspection calls', methods: [...new Set([...ADMIN_WORKSPACE_METHODS, ...ADMIN_USER_METHODS])] },
  { label: 'Settings changes', methods: ADMIN_SETTING_METHODS },
]

const isAuditMethod = (value: unknown): value is AuditMethod =>
  AUDIT_METHOD_GROUPS.some(({ methods }) => (methods as readonly unknown[]).includes(value))

const isAuditKind = (value: unknown): value is AdminAuditKind =>
  (AUDIT_KINDS as readonly unknown[]).includes(value)

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : undefined

/** The audit filters `search` holds, leaving out any that is malformed. */
export const auditFilterOf = (search: Record<string, unknown>): AuditFilter => {
  const filter: AuditFilter = {}
  const admin = text(search.admin)
  if (admin !== undefined) filter.admin = admin
  if (isAuditMethod(search.method)) filter.method = search.method
  if (isAuditKind(search.kind)) filter.kind = search.kind
  const workspace = text(search.workspace)
  if (workspace !== undefined) filter.workspace = workspace
  const owner = text(search.owner)
  if (owner !== undefined) filter.owner = owner
  return filter
}

/** Whether any filter is set. */
export const isFiltered = (filter: AuditFilter) => Object.values(filter).some((value) => value !== undefined)
