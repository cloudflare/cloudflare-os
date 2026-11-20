import { ChatListItem } from '@/blocks/ChatListItem'
import { ListGroup } from '@/blocks/ListGroup'
import { ListToolbar } from '@/blocks/ListToolbar'
import { NoMatches } from '@/blocks/NoMatches'
import { useChatNotifications } from '@/chat/useChatNotifications'
import { isAgentRun } from '@/automations/agents'
import { ChatsCircleIcon, NotePencilIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { EmptyState } from '@/components/EmptyState'
import { useDevMode } from '@/hooks/useDevMode'
import { useListView } from '@/hooks/useListView'
import { chatList, chatTitle } from './chatList'
import { formatActivity } from './formatActivity'
import { useWorkspaceChats } from './useWorkspaceChats'

export type WorkspaceChatListProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /** The viewer may build in the workspace, and so has a read state: what of each chat is unread to them. */
  builds?: boolean
  /** The chats waiting on a person, by id: stopped on a decision, or with an action waiting. */
  waiting?: ReadonlySet<number>
  /** Starts a chat in the workspace. */
  onNewChat: () => void
}

/**
 * A workspace's chats, most recently active first until another order is chosen, grouped as that
 * order groups them: those people started, as its agents' runs are listed under each agent, on the
 * Agents tab. Each is marked while it has anything the viewer has not read, and says so while it is
 * waiting on them. Over them, a search, the order, filters (unread and waiting among them) and the way to start a new chat.
 */
export const WorkspaceChatList = ({ workspaceId, onOpenChat, chatHref, builds = false, waiting, onNewChat }: WorkspaceChatListProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const devMode = useDevMode()
  const notifications = useChatNotifications(workspaceId, builds)
  const listed = chats.status === 'ready' ? chats.chats.filter((chat) => !isAgentRun(chat)) : []
  const unreadOf = ({ id }: { id: number }) => (builds ? notifications.rows.get(id)?.unreadMessageCount ?? 0 : 0)
  const isWaiting = ({ id, awaitingDecision }: { id: number; awaitingDecision?: true }) => waiting?.has(id) || awaitingDecision === true
  const list = useListView('workspace-chats', chatList(new Set(listed.filter((chat) => unreadOf(chat) > 0).map(({ id }) => id)), isWaiting, devMode))
  const shown = list.narrow(listed)
  const groups = list.arrange(shown)

  return (
    <div className="flex flex-col gap-4">
      {/* None with no chats, where the empty state has the way to start one. */}
      {!(chats.status === 'ready' && listed.length === 0) && (
        <ListToolbar
          noun="chats"
          {...(listed.length > 0 ? { search: list.controls.search, order: list.controls.order, filter: list.controls.filter } : {})}
          action={<Button variant="primary" icon={NotePencilIcon} onClick={onNewChat}>New chat</Button>}
        />
      )}
      {chats.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading chats…</p>}
      {chats.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load chats: {chats.message}</p>}
      {chats.status === 'ready' && listed.length === 0 && (
        <EmptyState
          size="section"
          tinted
          icon={ChatsCircleIcon}
          title="No chats yet"
          description="Chats in this workspace show here. Ask for an app, a document or something to run by itself, and it’s made here."
          actions={[{ label: 'New chat', icon: NotePencilIcon, variant: 'primary', onClick: onNewChat }]}
        />
      )}
      {listed.length > 0 && shown.length === 0 && <NoMatches noun="chats" onShowAll={list.showAll} />}
      {/* Another order is another list, cut to rather than moved to row by row. */}
      <div key={list.order.id} className="flex flex-col gap-3">
        {groups.map(({ key, label, entries }) => (
          <ListGroup key={key} label={label}>
            {entries.map(({ value: chat }) => (
              <ChatListItem
                key={chat.id}
                title={chatTitle(chat)}
                time={formatActivity(chat.lastActive)}
                unread={unreadOf(chat)}
                waiting={isWaiting(chat)}
                cost={devMode ? chat.totalCost : undefined}
                href={chatHref?.(chat.id)}
                onSelect={() => onOpenChat({ id: chat.id, title: chat.title })}
              />
            ))}
          </ListGroup>
        ))}
      </div>
    </div>
  )
}
