import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { NewWorkspacePane } from '@/workspaces/NewWorkspacePane'

/** Making a workspace by name, from the workspaces page. */
export const Route = createFileRoute('/_app/workspaces_/new')({
  component: NewWorkspace,
})

function NewWorkspace() {
  const navigate = useNavigate()
  return (
    <NewWorkspacePane
      onBack={() => navigate({ to: '/workspaces' })}
      // In place of this page, so going back from the workspace does not offer to make it again.
      onCreated={(workspaceId) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, replace: true })}
    />
  )
}
