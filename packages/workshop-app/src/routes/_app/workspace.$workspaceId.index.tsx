import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { WorkspacePane } from '@/workspaces/WorkspacePane'

/** One workspace, listing its chats. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/')({
  component: Workspace,
})

function Workspace() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  return (
    <WorkspacePane
      // Keyed, so each workspace loads its own chats rather than showing the previous one's.
      key={workspaceId}
      workspaceId={workspaceId}
      onOpenChat={({ id, title }) =>
        navigate({ to: '/workspace/$workspaceId/$chatId', params: { workspaceId, chatId: id }, state: { chatTitle: title } })
      }
      onNewChat={() => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId } })}
    />
  )
}
