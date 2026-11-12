import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { validateAsideParam } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { ChatHeader } from '@/blocks/ChatHeader'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

/**
 * The start of a new chat in a workspace: sending the first message creates it. What is shown
 * beside it (`?open=`) stays beside the chat.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/new')({
  validateSearch: (search: Record<string, unknown>): { open?: string } => ({ open: validateAsideParam(search.open) }),
  component: NewChat,
})

function NewChat() {
  const { workspaceId } = Route.useParams()
  const { open } = Route.useSearch()
  const { api } = useApi()
  const navigate = useNavigate()
  const workspaces = useWorkspaces()
  const title = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId)?.title : undefined

  return (
    <NewChatPane
      // Keyed, so a message being sent in one workspace is not shown in another's.
      key={workspaceId}
      header={(
        <ChatHeader
          workspace={title === undefined ? undefined : {
            id: workspaceId,
            title,
            label: workspaceLabel(title),
            onOpen: () => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } }),
          }}
          title="New chat"
        />
      )}
      start={(text, modelId) => startConversation(() => api.openWorkspace(workspaceId), text, modelId)}
      // In its place, so that going back goes to the workspace rather than to an empty chat.
      onStarted={({ chatId }) => {
        if (open) rememberShown(workspaceId, chatId, open)
        return navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open }, replace: true })
      }}
    />
  )
}
