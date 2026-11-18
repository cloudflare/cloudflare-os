import { isAdminWorkspaceAccess, type AdminSettingsView } from '@gadgets/workshop-shared/api'

/** The deployment's settings the Audit part shows and changes: how far admins may inspect, and how long records are kept. */
export type AuditSettings = Pick<AdminSettingsView, 'adminWorkspaceAccess' | 'adminAuditRetentionDays'>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * The audit settings a settings view carries, or null where it lacks them or holds them malformed.
 * A backend older than the admin audit log sends neither, and has none of the methods the Audit
 * part calls either, so null is a deployment whose backend has no audit log yet. Ported from main.
 */
export const auditSettingsOf = (view: Partial<AuditSettings>): AuditSettings | null => {
  const access: unknown = view.adminWorkspaceAccess
  const retention: unknown = view.adminAuditRetentionDays
  if (!isRecord(access) || !isRecord(retention)) return null
  if (![access.effective, access.chosen, access.max].every(isAdminWorkspaceAccess)) return null
  if (![retention.effective, retention.chosen, retention.min].every((days) => typeof days === 'number')) return null
  return { adminWorkspaceAccess: view.adminWorkspaceAccess!, adminAuditRetentionDays: view.adminAuditRetentionDays! }
}
