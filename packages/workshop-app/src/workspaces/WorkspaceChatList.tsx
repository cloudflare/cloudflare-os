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

/**
 * A workspace's chats, most recently active first, grouped by when. An agent's runs are not among
 * them: they are the agent's, on its page, as the sidebar's recents leave them out.
 */
export const WorkspaceChatList = ({ workspaceId, onOpenChat, chatHref }: WorkspaceChatListProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const listed = chats.status === 'ready' ? chats.chats.filter(({ spawnerName }) => spawnerName === undefined) : []
  const groups = groupByTime(listed.map((chat) => ({ value: chat, at: chat.lastActive })))

  return (
    <>
      {chats.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading chats…</p>}
      {chats.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load chats: {chats.message}</p>}
      {chats.status === 'ready' && listed.length === 0 && <p className="appears px-4 text-center text-base text-kumo-subtle">No chats yet.</p>}
      {groups.length > 0 && (
        // Faded in as it arrives, as the Library's lists are.
        <div className="appears flex flex-col gap-8">
          {groups.map(({ key, label, entries }) => (
            <ListGroup key={key} label={label}>
              {entries.map(({ value: { id, title }, time }) => (
                <ChatListItem key={id} title={title || 'Untitled chat'} time={time} href={chatHref?.(id)} onSelect={() => onOpenChat({ id, title })} />
              ))}
            </ListGroup>
          ))}
        </div>
      )}
    </>
  )
}
