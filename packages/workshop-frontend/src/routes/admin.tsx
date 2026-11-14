import { createFileRoute } from '@tanstack/react-router'
import AdminPage from '../AdminPage'
import { isAdminTab, type AdminTab } from '../adminTab'
import { auditFilterOf, type AuditFilter } from '../features/admin-audit/auditFilter'

type AdminSearch = { tab?: AdminTab } & AuditFilter

export const Route = createFileRoute('/admin')({
  component: AdminPage,
  validateSearch: (search: Record<string, unknown>): AdminSearch => ({
    tab: isAdminTab(search.tab) ? search.tab : undefined,
    ...auditFilterOf(search),
  }),
})
