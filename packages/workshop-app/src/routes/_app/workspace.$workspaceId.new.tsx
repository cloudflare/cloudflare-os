import { createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { validateAsideParam } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { ChatHeader } from '@/blocks/ChatHeader'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

/**
 * The start of a new chat in a workspace: sending the first message creates it. What is shown
 * beside it (`?open=`) stays beside the chat. `?format=` is what the first message asks for
 * something as, by the format's id, as the workspace's library's New starts one, and as the home
 * page has it.
 */
export const Route = createFileRoute('/_app/workspace/$workspaceId/new')({
  validateSearch: (search: Record<string, unknown>): { open?: string; format?: string } => ({
    open: validateAsideParam(search.open),
    format: typeof search.format === 'string' ? search.format : undefined,
  }),
  component: NewChat,
})

function NewChat() {
  const { workspaceId } = Route.useParams()
  const { open, format: formatId } = Route.useSearch()
  // One the deployment does not offer starts nothing.
  const format = startableFormats(useOutputFormats(formatId !== undefined)).find(({ id }) => id === formatId)
  const { api, user } = useApi()
  const navigate = useNavigate()
  const workspaces = useWorkspaces()
  // Started from what it opens beside, it is greeted by its name.
  const about = useRouterState({ select: (state) => (open ? state.location.state.gadgetTitle : undefined) })
  const title = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId)?.title : undefined
  const look = useWorkspaceLooks()[workspaceId]

  return (
    <NewChatPane
      // Keyed, so a message being sent in one workspace is not shown in another's.
      key={workspaceId}
      // Greeted as on the home page, under the workspace it is in.
      greeting={greeting(user.name, about)}
      header={(
        <ChatHeader
          workspace={title === undefined ? undefined : {
            id: workspaceId,
            title,
            label: workspaceLabel(title),
            look,
            onOpen: () => navigate({ to: '/workspace/$workspaceId', params: { workspaceId } }),
          }}
          title="New chat"
        />
      )}
      format={format && { noun: format.noun, icon: format.icon, onRemove: () => navigate({ to: '/workspace/$workspaceId/new', params: { workspaceId }, search: { open }, replace: true }) }}
      start={(text, files, modelId, command, formats) => startConversation(() => api.openWorkspace(workspaceId), text, files, modelId, command, formats)}
      // In its place, so that going back goes to the workspace rather than to an empty chat.
      onStarted={({ chatId }) => {
        if (open) rememberShown(workspaceId, chatId, open)
        return navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open }, replace: true })
      }}
    />
  )
}
