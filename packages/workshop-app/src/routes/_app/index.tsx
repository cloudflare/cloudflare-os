import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { useApi } from '@/rpc/ApiContext'

/**
 * The start of a new conversation, in a new workspace: sending the first message creates both.
 * `?format=` is what the first message asks for something as, by the format's id (`document`), as
 * the library's New menu starts one.
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: (search: Record<string, unknown>): { format?: string } => ({ format: typeof search.format === 'string' ? search.format : undefined }),
  component: Home,
})

function Home() {
  const { api, user } = useApi()
  const navigate = useNavigate()
  const { format: formatId } = Route.useSearch()
  // One the deployment does not offer starts nothing.
  const format = startableFormats(useOutputFormats(formatId !== undefined)).find(({ id }) => id === formatId)
  return (
    <NewChatPane
      greeting={greeting(user.name)}
      format={format && { noun: format.noun, icon: format.icon, onRemove: () => navigate({ to: '/', replace: true }) }}
      start={(text, files, modelId, formats) => startConversation(() => api.newWorkspace(), text, files, modelId, formats)}
      onStarted={({ workspaceId, chatId }) => navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId } })}
    />
  )
}
