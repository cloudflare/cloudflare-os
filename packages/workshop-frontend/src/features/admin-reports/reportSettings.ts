import type { AdminSettingsView } from '@gadgets/workshop-shared/api'

/** How long issue reports are kept, as a settings view carries it. */
export type ReportRetention = AdminSettingsView['issueReportRetentionDays']

/**
 * The issue reports' retention a settings view carries, or null when it lacks it or holds it
 * malformed. A backend with no issue report store sends none, and has none of the methods the
 * Reports tab calls either, so null means the deployment has no Reports tab.
 */
export const reportRetentionOf = (view: Partial<AdminSettingsView>): ReportRetention | null => {
  const retention: unknown = view.issueReportRetentionDays
  if (typeof retention !== 'object' || retention === null) return null
  const { effective, chosen, min } = retention as Record<string, unknown>
  if (![effective, chosen, min].every((days) => typeof days === 'number')) return null
  return view.issueReportRetentionDays!
}
