import type { AdminSettingsView } from '@gadgets/workshop-shared/api'

/** The deployment settings the admin Audit tab shows and changes: the audit retention. */
export type AuditSettings = Pick<AdminSettingsView, 'adminAuditRetentionDays'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The audit settings a settings view carries, or null when it lacks them or holds them malformed.
 * A backend older than the admin audit log sends none, and has none of the methods the Audit tab
 * calls either, so null means the deployment has no Audit tab yet.
 */
export const auditSettingsOf = (view: Partial<AuditSettings>): AuditSettings | null => {
  const retention: unknown = view.adminAuditRetentionDays
  if (!isRecord(retention)) return null
  if (![retention.effective, retention.chosen, retention.min].every((days) => typeof days === 'number')) {
    return null
  }
  return { adminAuditRetentionDays: view.adminAuditRetentionDays! }
}
