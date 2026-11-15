import { createFileRoute } from '@tanstack/react-router'
import AdminWorkspacePage from '../pages/admin-workspace/AdminWorkspacePage'
import { useDocumentTitle } from '../useDocumentTitle'

type AdminWorkspaceSearch = {
  /** The issue report the admin came from. */
  report?: string
}

/**
 * An admin's page for one workspace: its owner, its live grants, and where content access is
 * requested.
 *
 * The file is `admin_.workspace.$workspaceId` (trailing underscore) so the URL is
 * /admin/workspace/$workspaceId without nesting inside the /admin page's component.
 */
export const Route = createFileRoute('/admin_/workspace/$workspaceId')({
  component: AdminWorkspace,
  // The router reads a search value as JSON where it can, so an id made of digits is a number.
  validateSearch: (search: Record<string, unknown>): AdminWorkspaceSearch => ({
    report: typeof search.report === 'string' && search.report !== ''
      ? search.report
      : typeof search.report === 'number' ? String(search.report) : undefined,
  }),
})

function AdminWorkspace() {
  const { workspaceId } = Route.useParams()
  const { report } = Route.useSearch()
  useDocumentTitle('Workspace admin view')
  // Keyed by the workspace, so that one workspace's view is never shown under another's id, and is
  // disposed when the page turns to another.
  return <AdminWorkspacePage key={workspaceId} workspaceId={workspaceId} reportId={report} />
}
