/** The admin page's tabs, in display order. */
export const ADMIN_TABS = ['general', 'gatekeepers', 'formats', 'models', 'access', 'audit', 'updates'] as const

/** One of the admin page's tabs, as named in the URL's `tab` search parameter. */
export type AdminTab = (typeof ADMIN_TABS)[number]

/** Whether `value` names one of the admin page's tabs. */
export const isAdminTab = (value: unknown): value is AdminTab =>
  (ADMIN_TABS as readonly unknown[]).includes(value)

/**
 * The tab to show for the one requested in the URL. The Updates tab exists only for a deployment
 * the deploy flow installed, which is known once the update status has loaded: until then a request
 * for it stands, so a link to it does not flash another tab first. The Audit tab exists only while
 * the backend's settings carry the admin access settings (a backend older than the admin audit log
 * sends none); the settings load before any tab shows, so its availability is never pending.
 */
export const resolveAdminTab = (
  requested: string | undefined,
  { updatesAvailable, auditAvailable }: { updatesAvailable: boolean | 'pending'; auditAvailable: boolean },
): AdminTab => {
  if (!isAdminTab(requested)) return 'general'
  if (requested === 'updates' && updatesAvailable === false) return 'general'
  if (requested === 'audit' && !auditAvailable) return 'general'
  return requested
}
