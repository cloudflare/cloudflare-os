import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router'
import { validateAsideParam } from '@/aside/asideItems'
import { rememberShown } from '@/aside/lastShown'
import { carryAside } from '@/aside/useAsideNavigation'
import { ChatHeader } from '@/blocks/ChatHeader'
import { greeting } from '@/chat/greeting'
import { NewChatPane } from '@/chat/NewChatPane'
import { startConversation } from '@/chat/startConversation'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
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
  const { api, user } = useApi()
  const navigate = useNavigate()
  const workspaces = useWorkspaces()
  const listed = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const title = listed?.title
  const role = listed?.role
  const look = useWorkspaceLooks()[workspaceId]
  // Started from a gadget's page, beside the gadget, it is greeted by the gadget's name.
  const about = useLocation({ select: (location) => (open ? location.state.gadgetTitle : undefined) })

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
            // What is shown beside the chat to be stays beside the workspace.
            onOpen: () => navigate({ to: '/workspace/$workspaceId', params: { workspaceId }, search: { open: carryAside(open, { workspaceId }) } }),
          }}
          title="New chat"
        />
      )}
      start={(text, files, modelId, command, formats, capsules) =>
        startConversation(() => api.openWorkspace(workspaceId), text, files, modelId, command, formats, capsules)}
      // Making a connection in the workspace is building in it, which those who only use it cannot.
      connectsIn={role !== undefined && role !== 'use' ? workspaceId : undefined}
      // In its place, so that going back goes to the workspace rather than to an empty chat.
      onStarted={({ chatId }) => {
        if (open) rememberShown(workspaceId, chatId, open)
        return navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open }, replace: true })
      }}
    />
  )
}
