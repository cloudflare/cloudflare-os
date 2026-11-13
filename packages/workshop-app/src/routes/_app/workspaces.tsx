import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { WorkspacesPane } from '@/workspaces/WorkspacesPane'

/** All the user's workspaces, the starred ones first. */
export const Route = createFileRoute('/_app/workspaces')({
  component: Workspaces,
})

function Workspaces() {
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <WorkspacesPane
      onOpenWorkspace={(workspaceId) => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } })}
      workspaceHref={(workspaceId) => router.buildLocation({ to: '/workspace/$workspaceId', params: { workspaceId } }).href}
      // A workspace is made by the first message of a chat started on the home page.
      onNewWorkspace={() => navigate({ to: '/' })}
    />
  )
}
