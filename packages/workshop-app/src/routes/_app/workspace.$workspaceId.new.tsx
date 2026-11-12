import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChatHeader } from '@/blocks/ChatHeader'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

/** The start of a new chat in a workspace: sending the first message creates it. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/new')({
  component: NewChat,
})

function NewChat() {
  const { workspaceId } = Route.useParams()
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
      onStarted={({ chatId }) => navigate({ to: '/workspace/$workspaceId/$chatId', params: { workspaceId, chatId }, replace: true })}
    />
  )
}
