import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'

/** The start of a new conversation, in a new workspace: sending the first message creates both. */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

const greet = (name: string) => {
  const [firstName] = name.trim().split(/\s+/)
  return `Hello${firstName ? ` ${firstName}` : ''}, what should we do today?`
}

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  return (
    <NewChatPane
      greeting={greet(user.name)}
      start={(text, modelId) => startConversation(() => api.newWorkspace(), text, modelId)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
