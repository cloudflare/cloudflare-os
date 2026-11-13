import { ChatListItem } from '@/blocks/ChatListItem'
import { ListGroup } from '@/blocks/ListGroup'
import { groupByTime } from '@/chat/timeGroups'
import { useWorkspaceChats } from './useWorkspaceChats'

export type WorkspaceChatListProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
}

/** A workspace's chats, most recently active first, grouped by when. */
export const WorkspaceChatList = ({ workspaceId, onOpenChat, chatHref }: WorkspaceChatListProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const groups = chats.status === 'ready' ? groupByTime(chats.chats.map((chat) => ({ value: chat, at: chat.lastActive }))) : []

  return (
    <>
      {chats.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading chats…</p>}
      {chats.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load chats: {chats.message}</p>}
      {chats.status === 'ready' && chats.chats.length === 0 && <p className="px-4 text-center text-base text-kumo-subtle">No chats yet.</p>}
      {groups.map(({ key, label, entries }) => (
        <ListGroup key={key} label={label}>
          {entries.map(({ value: { id, title }, time }) => (
            <ChatListItem key={id} title={title || 'Untitled chat'} time={time} href={chatHref?.(id)} onSelect={() => onOpenChat({ id, title })} />
          ))}
        </ListGroup>
      ))}
    </>
  )
}
