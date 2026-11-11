import { ChatListItem } from '@/blocks/ChatListItem'
import { Button } from '@/components/Button'
import { PageLayout } from '@/layouts/PageLayout'
import { useWorkspaces } from './WorkspacesContext'
import { formatActivity } from './formatActivity'
import { useWorkspaceChats } from './useWorkspaceChats'

export type WorkspacePaneProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
}

/** One workspace: its title and its chats, most recently active first. */
export const WorkspacePane = ({ workspaceId, onOpenChat }: WorkspacePaneProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const workspaces = useWorkspaces()
  const workspaceTitle =
    workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId)?.title : undefined

  return (
    <PageLayout header={workspaceTitle && <Button>{workspaceTitle}</Button>}>
      {chats.status === 'loading' && <p role="status" className="px-3 py-2 text-base text-kumo-subtle">Loading chats…</p>}
      {chats.status === 'failed' && (
        <p className="px-3 py-2 text-base text-kumo-subtle">Couldn’t load chats: {chats.message}</p>
      )}
      {chats.status === 'ready' && chats.chats.length === 0 && (
        <p className="px-3 py-2 text-base text-kumo-subtle">No chats yet.</p>
      )}
      {chats.status === 'ready' && chats.chats.length > 0 && (
        <nav aria-label="Chats" className="flex flex-col">
          {chats.chats.map(({ id, title, lastActive }) => (
            <ChatListItem key={id} title={title} subtitle={formatActivity(lastActive)} onSelect={() => onOpenChat({ id, title })} />
          ))}
        </nav>
      )}
    </PageLayout>
  )
}
