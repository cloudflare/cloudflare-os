import { createFileRoute } from '@tanstack/react-router'
import { ChatPane } from '@/chat/ChatPane'

/** One workspace's conversation. */
export const Route = createFileRoute('/_app/workspace/$workspaceId')({
  component: WorkspaceChat,
})

function WorkspaceChat() {
  const { workspaceId } = Route.useParams()
  // Keyed, so each workspace gets its own session rather than reusing the previous one's.
  return <ChatPane key={workspaceId} workspaceId={workspaceId} />
}
