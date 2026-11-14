import {
  ADMIN_SETTING_METHODS,
  ADMIN_WORKSPACE_METHODS,
  ADMIN_WRITE_ACTIONS,
  type AdminAuditKind,
  type AdminAuditRecord,
} from '@gadgets/workshop-shared/api'

/** A method an audit record can name, which the Audit tab can filter by. */
export type AuditMethod = AdminAuditRecord['method']

/** The kinds of record, as the filter lists them. */
export const AUDIT_KINDS: readonly AdminAuditKind[] = ['workspace', 'write', 'setting']

/**
 * The Audit tab's filters, kept in the admin page's URL as search parameters of these names, so a
 * filtered view can be linked. Each is passed to AdminApi.listAdminAudit() as is.
 */
export type AuditFilter = {
  /** Only this admin's records, by canonical user id. */
  admin?: string
  /** Only records of calls to this method, or of steps in a write of this action. */
  method?: AuditMethod
  /** Only records of this kind. */
  kind?: AdminAuditKind
  /** Only records of access to, or a write to, this workspace, by id. */
  workspace?: string
  /** Only records of access to, or a write to, workspaces this user owns, by canonical user id. */
  owner?: string
}

/** The methods the Audit tab offers as filters, grouped as its Action filter lists them. */
export const AUDIT_METHOD_GROUPS: { label: string; methods: readonly AuditMethod[] }[] = [
  { label: 'Workspace calls', methods: ADMIN_WORKSPACE_METHODS },
  { label: 'Workspace writes', methods: ADMIN_WRITE_ACTIONS },
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
