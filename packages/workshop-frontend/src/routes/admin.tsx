import { createFileRoute } from '@tanstack/react-router'
import AdminPage from '../AdminPage'
import { isAdminTab, type AdminTab } from '../adminTab'

type AdminSearch = { tab?: AdminTab }

export const Route = createFileRoute('/admin')({
  component: AdminPage,
  validateSearch: (search: Record<string, unknown>): AdminSearch => ({
    tab: isAdminTab(search.tab) ? search.tab : undefined,
  }),
})
