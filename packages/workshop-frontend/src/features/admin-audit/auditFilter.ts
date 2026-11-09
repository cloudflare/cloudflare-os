import {
  ADMIN_SETTING_METHODS,
  ADMIN_WORKSPACE_METHODS,
  ADMIN_WRITE_ACTIONS,
  type AdminAuditQuery,
  type AdminAuditRecord,
} from '@gadgets/workshop-shared/api'

/** A method an audit record can name, which the Audit tab can filter by. */
export type AuditMethod = AdminAuditRecord['method']

/**
 * How sensitive a record is, by what it changed or exposed: "write" for a step in a write to a
 * workspace, "content" for a call into a workspace whose answer held content
 * (AdminAccessRecord.exposed), "metadata" for any other call into a workspace, and "setting" for a
 * change to the deployment's settings.
 */
export type AuditSensitivity = 'write' | 'content' | 'metadata' | 'setting'

/** The sensitivities, most sensitive first. */
export const AUDIT_SENSITIVITIES: readonly AuditSensitivity[] = ['write', 'content', 'metadata', 'setting']

/** How sensitive `record` is (see AuditSensitivity). */
export const sensitivityOf = (record: AdminAuditRecord): AuditSensitivity =>
  record.kind === 'workspace' ? record.exposed : record.kind

/**
 * The Audit tab's filters, kept in the admin page's URL as search parameters of these names, so a
 * filtered view can be linked.
 */
export type AuditFilter = {
  /** Only this admin's records, by canonical user id. */
  admin?: string
  /** Only records of calls to this method, or of steps in a write of this action. */
  method?: AuditMethod
  /** Only records this sensitive. */
  sensitivity?: AuditSensitivity
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

const isSensitivity = (value: unknown): value is AuditSensitivity =>
  (AUDIT_SENSITIVITIES as readonly unknown[]).includes(value)

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : undefined

/** The audit filters `search` holds, leaving out any that is malformed. */
export const auditFilterOf = (search: Record<string, unknown>): AuditFilter => {
  const filter: AuditFilter = {}
  const admin = text(search.admin)
  if (admin !== undefined) filter.admin = admin
  if (isAuditMethod(search.method)) filter.method = search.method
  if (isSensitivity(search.sensitivity)) filter.sensitivity = search.sensitivity
  const workspace = text(search.workspace)
  if (workspace !== undefined) filter.workspace = workspace
  const owner = text(search.owner)
  if (owner !== undefined) filter.owner = owner
  return filter
}

/** Whether any filter is set. */
export const isFiltered = (filter: AuditFilter) => Object.values(filter).some((value) => value !== undefined)

/** The listAdminAudit() query for `filter`: a sensitivity is what the records exposed, or their kind. */
export const auditQueryOf = ({ sensitivity, ...filter }: AuditFilter): AdminAuditQuery => ({
  ...filter,
  ...(sensitivity === 'setting' || sensitivity === 'write'
    ? { kind: sensitivity }
    : sensitivity ? { exposed: sensitivity } : {}),
})
