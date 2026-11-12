import { NotePencilIcon } from '@phosphor-icons/react'
import { ChatListItem } from '@/blocks/ChatListItem'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useWorkspaces } from './WorkspacesContext'
import { formatActivity } from './formatActivity'
import { workspaceLabel } from './workspaceLabel'
import { useWorkspaceChats } from './useWorkspaceChats'

export type WorkspacePaneProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  onNewChat: () => void
}

/** One workspace: its title, the way to start a chat in it, and its chats, most recently active first. */
export const WorkspacePane = ({ workspaceId, onOpenChat, chatHref, onNewChat }: WorkspacePaneProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const workspaces = useWorkspaces()
  const workspaceTitle =
    workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId)?.title : undefined
  useDocumentTitle(workspaceTitle ?? 'Workspace')

  return (
    <PageLayout
      header={(
        <>
          {workspaceTitle && <WorkspaceCrumb id={workspaceId} title={workspaceTitle} label={workspaceLabel(workspaceTitle)} expanded />}
          <HeaderBubble className="ms-auto">
            <Button variant="primary" icon={NotePencilIcon} onClick={onNewChat}>New chat</Button>
          </HeaderBubble>
        </>
      )}
    >
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
            <ChatListItem key={id} title={title} subtitle={formatActivity(lastActive)} href={chatHref?.(id)} onSelect={() => onOpenChat({ id, title })} />
          ))}
        </nav>
      )}
    </PageLayout>
  )
}
