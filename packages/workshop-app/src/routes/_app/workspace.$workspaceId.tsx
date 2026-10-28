import { createFileRoute } from '@tanstack/react-router'
import { Composer } from '@/blocks/Composer'
import { Button } from '@/components/Button'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'

/** One workspace's conversation. Its messages arrive in a later step. */
export const Route = createFileRoute('/_app/workspace/$workspaceId')({
  component: WorkspaceChat,
})

function WorkspaceChat() {
  const { workspaceId } = Route.useParams()
  const workspaces = useWorkspaces()
  const workspace =
    workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined

  return (
    <ChatLayout header={workspace && <Button>{workspace.title}</Button>} composer={<Composer onSend={() => {}} />} />
  )
}
