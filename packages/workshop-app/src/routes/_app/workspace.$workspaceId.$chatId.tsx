import { createFileRoute, notFound, useLocation } from '@tanstack/react-router'
import { ChatPane } from '@/chat/ChatPane'

/** One chat in a workspace. */
export const Route = createFileRoute('/_app/workspace/$workspaceId/$chatId')({
  params: {
    parse: ({ workspaceId, chatId }) => {
      const id = Number(chatId)
      if (!Number.isSafeInteger(id) || id < 0) throw notFound()
      return { workspaceId, chatId: id }
    },
    stringify: ({ workspaceId, chatId }) => ({ workspaceId, chatId: String(chatId) }),
  },
  component: WorkspaceChat,
})

function WorkspaceChat() {
  const { workspaceId, chatId } = Route.useParams()
  const initialTitle = useLocation({ select: (location) => location.state.chatTitle })
  // Keyed, so each chat gets its own session rather than reusing the previous one's.
  return <ChatPane key={`${workspaceId}/${chatId}`} workspaceId={workspaceId} chatId={chatId} initialTitle={initialTitle} />
}
