import { createFileRoute } from '@tanstack/react-router'
import AdminWriteApprovalPage from '../pages/admin-write-approval/AdminWriteApprovalPage'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Where an admin approves or denies one write request (AdminWriteRequest.approvalUrl).
 *
 * The file is `admin_.approve.$requestId` (trailing underscore) so the URL is
 * /admin/approve/$requestId without nesting inside the /admin page's component.
 */
export const Route = createFileRoute('/admin_/approve/$requestId')({
  component: AdminWriteApproval,
})

function AdminWriteApproval() {
  const { requestId } = Route.useParams()
  useDocumentTitle('Approve a write')
  // Keyed by the request, so that one request's state is never shown under another's id.
  return <AdminWriteApprovalPage key={requestId} requestId={requestId} />
}
