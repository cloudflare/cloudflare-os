import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { asideFor } from '@/aside/useAsideNavigation'
import { WorkspacePane } from '@/workspaces/WorkspacePane'

/** One workspace, listing its chats. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/')({
  component: Workspace,
})

function Workspace() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <WorkspacePane
      // Keyed, so each workspace loads its own chats rather than showing the previous one's.
      key={workspaceId}
      workspaceId={workspaceId}
      onOpenChat={({ id, title }) =>
        navigate({
          to: '/workspace/$workspaceId/chat/$chatId',
          params: { workspaceId, chatId: id },
          search: { open: asideFor({ workspaceId, chatId: id }) },
          state: { chatTitle: title },
        })
      }
      chatHref={(id) => router.buildLocation({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: id } }).href}
      onNewChat={() => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId } })}
    />
  )
}
