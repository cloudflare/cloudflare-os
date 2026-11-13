import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'

/** The start of a new conversation, in a new workspace: sending the first message creates both. */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  return (
    <NewChatPane
      greeting={greeting(user.name)}
      start={(text, files, modelId) => startConversation(() => api.newWorkspace(), text, files, modelId)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
