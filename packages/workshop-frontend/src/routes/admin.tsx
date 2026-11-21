import { createFileRoute } from '@tanstack/react-router'
import AdminPage from '../AdminPage'
import { isAdminTab, type AdminTab } from '../adminTab'
import { auditFilterOf, type AuditFilter } from '../features/admin-audit/auditFilter'
import { reportSearchOf, type ReportSearch } from '../features/admin-reports/reportFilter'

// The Audit tab and the Reports tab both filter by `workspace`: a change of tab keeps no filter,
// so the one in the URL is always the shown tab's.
type AdminSearch = { tab?: AdminTab } & AuditFilter & ReportSearch

export const Route = createFileRoute('/admin')({
  component: AdminPage,
  validateSearch: (search: Record<string, unknown>): AdminSearch => ({
    tab: isAdminTab(search.tab) ? search.tab : undefined,
    ...auditFilterOf(search),
    ...reportSearchOf(search),
  }),
})
