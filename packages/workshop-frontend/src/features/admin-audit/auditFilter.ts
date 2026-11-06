import { ADMIN_SETTING_METHODS, type AdminAuditRecord } from '@gadgets/workshop-shared/api'

/** A method an audit record can name, which the Audit tab can filter by. */
export type AuditMethod = AdminAuditRecord['method']

/**
 * The Audit tab's filters, kept in the admin page's URL as search parameters of these names, so a
 * filtered view can be linked. Each is passed to AdminApi.listAdminAudit() as is.
 */
export type AuditFilter = {
  /** Only this admin's records, by canonical user id. */
  admin?: string
  /** Only records of calls to this method. */
  method?: AuditMethod
}

/** The methods the Audit tab offers as filters, grouped as its Action select lists them. */
export const AUDIT_METHOD_GROUPS: { label: string; methods: readonly AuditMethod[] }[] = [
  { label: 'Settings changes', methods: ADMIN_SETTING_METHODS },
]

const isAuditMethod = (value: unknown): value is AuditMethod =>
  AUDIT_METHOD_GROUPS.some(({ methods }) => (methods as readonly unknown[]).includes(value))

/** The audit filters `search` holds, leaving out any that is malformed. */
export const auditFilterOf = (search: Record<string, unknown>): AuditFilter => ({
  ...(typeof search.admin === 'string' && search.admin !== '' ? { admin: search.admin } : {}),
  ...(isAuditMethod(search.method) ? { method: search.method } : {}),
})
