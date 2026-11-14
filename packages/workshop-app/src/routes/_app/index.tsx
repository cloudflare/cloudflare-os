import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { skillCommandOf } from '@/chat/slashCommands'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'

/**
 * The start of a new conversation, in a new workspace: sending the first message creates both. A
 * skill chosen to use elsewhere (`useSkill`) is what the draft starts with.
 */
export const Route = createFileRoute('/_app/')({
  component: Home,
})

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  const location = useLocation()
  const skill = location.state.useSkill
  return (
    <NewChatPane
      // A skill chosen again starts the draft again.
      key={location.state.key}
      greeting={greeting(user.name)}
      initialCommand={skill && skillCommandOf(skill, skill.source)}
      start={(text, files, modelId, command) => startConversation(() => api.newWorkspace(), text, files, modelId, command)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
