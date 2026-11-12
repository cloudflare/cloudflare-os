import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'

/** The start of a new conversation, in a new workspace: sending the first message creates both. */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  const { api } = useApi()
  const navigate = useNavigate()
  return (
    <NewChatPane
      start={(text, modelId) => startConversation(() => api.newWorkspace(), text, modelId)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
