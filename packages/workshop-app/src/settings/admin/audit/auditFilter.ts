import {
  ADMIN_SETTING_METHODS,
  ADMIN_USER_METHODS,
  ADMIN_WORKSPACE_METHODS,
  type AdminAuditKind,
  type AdminAuditRecord,
} from '@gadgets/workshop-shared/api'

/** A method an audit record can name, which the log can be narrowed to. */
export type AuditMethod = AdminAuditRecord['method']

/** The kinds of record, in the order the filter lists them. */
export const AUDIT_KINDS: readonly AdminAuditKind[] = ['workspace', 'user', 'setting']

/**
 * What the audit log is narrowed to, each passed to `AdminApi.listAdminAudit()` as it is. Kept for
 * the visit to the part: the settings' address names only the part. Ported from main's Audit tab,
 * which kept them in its address.
 */
export type AuditFilter = {
  /** Only this admin's records, by canonical user id. */
  admin?: string
  /** Only records of calls to this method. */
  method?: AuditMethod
  /** Only records of this kind. */
  kind?: AdminAuditKind
  /** Only records of calls into this workspace, by id. */
  workspace?: string
  /**
   * Only records of calls that reached this user's data: the workspaces they own and their
   * account, by canonical user id.
   */
  owner?: string
}

/**
 * The user `record` reached: the owner of the workspace a call was made into, or the user whose
 * account it was made into. Nobody for a workspace whose owner is not known, and for a setting
 * change, which reaches everyone.
 */
export const targetUserOf = (record: AdminAuditRecord): string | undefined => {
  if (record.kind === 'setting') return undefined
  return (record.kind === 'user' ? record.userId : record.workspaceOwner) || undefined
}

/**
 * The methods the log can be narrowed to, in groups, each in alphabetical order. A workspace's view
 * and a user account's share method names (describe, say), and narrowing to one lists both views'
 * calls to it, so their methods are one group that names each once.
 */
export const AUDIT_METHOD_GROUPS: { label: string; methods: readonly AuditMethod[] }[] = [
  { label: 'Inspection calls', methods: [...new Set([...ADMIN_WORKSPACE_METHODS, ...ADMIN_USER_METHODS])].toSorted() },
  { label: 'Settings changes', methods: ADMIN_SETTING_METHODS.toSorted() },
]

/** Whether anything is narrowed. */
export const isFiltered = (filter: AuditFilter) => Object.values(filter).some((value) => value !== undefined)

/** Says which filter it is, so that the pages turned under one are forgotten once it changes. */
export const filterKey = ({ admin, method, kind, workspace, owner }: AuditFilter) =>
  JSON.stringify([admin, method, kind, workspace, owner].map((value) => value ?? null))
