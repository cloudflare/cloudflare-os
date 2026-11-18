import { useState } from 'react'
import { ChatListItem } from '@/blocks/ChatListItem'
import { DeleteChatDialog } from '@/blocks/DeleteChatDialog'
import { ListGroup } from '@/blocks/ListGroup'
import { notificationChoices, notificationsOf } from '@/chat/ChatNotifications'
import { groupByTime } from '@/chat/timeGroups'
import { useChatNotifications } from '@/chat/useChatNotifications'
import { useDeleteChat } from '@/chat/useDeleteChat'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaceChats } from './useWorkspaceChats'

export type WorkspaceChatListProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /**
   * The viewer may build in the workspace, and so change its chats: their own notifications, and
   * deleting one, which a row's more offers. Not someone who can only use it.
   */
  builds?: boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A workspace's chats, most recently active first, grouped by when. A chat deleted from here
 * leaves the list once it is gone.
 */
export const WorkspaceChatList = ({ workspaceId, onOpenChat, chatHref, builds = false }: WorkspaceChatListProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const notifications = useChatNotifications(workspaceId, builds)
  const deleteChat = useDeleteChat(workspaceId)
  const connection = useConnectionNotice()
  // The chat being asked about, kept as the dialog closes so that it does not change as it goes.
  const [deleting, setDeleting] = useState<{ id: number; title: string; open: boolean }>()
  const [deleted, setDeleted] = useState<ReadonlySet<number>>(new Set())
  // Why the last change to a chat's notifications was not made.
  const [problem, setProblem] = useState<string>()
  const listed = chats.status === 'ready' ? chats.chats.filter(({ id }) => !deleted.has(id)) : []
  const groups = groupByTime(listed.map((chat) => ({ value: chat, at: chat.lastActive })))

  const setNotifications = (chatId: number, enabled: boolean) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    notifications.setEnabled(chatId, enabled).catch((error: unknown) => setProblem(`Couldn’t change the chat’s notifications: ${messageOf(error)}`))
  }
  const confirmDelete = async () => {
    if (!deleting || connection?.blocked()) return
    await deleteChat(deleting.id)
    setDeleted((current) => new Set(current).add(deleting.id))
    setDeleting({ ...deleting, open: false })
  }

  return (
    <>
      {chats.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading chats…</p>}
      {chats.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load chats: {chats.message}</p>}
      {chats.status === 'ready' && listed.length === 0 && <p className="px-4 text-center text-base text-kumo-subtle">No chats yet.</p>}
      {problem && <p role="alert" className="px-4 text-center text-base text-kumo-subtle">{problem}</p>}
      {groups.map(({ key, label, entries }) => (
        <ListGroup key={key} label={label}>
          {entries.map(({ value: chat, time }) => {
            const title = chat.title || 'Untitled chat'
            return (
              <ChatListItem
                key={chat.id}
                title={title}
                time={time}
                href={chatHref?.(chat.id)}
                onSelect={() => onOpenChat({ id: chat.id, title: chat.title })}
                more={builds ? {
                  notifications: {
                    choices: notificationChoices(notificationsOf(notifications.rows.get(chat.id), chat.notificationsRequireParticipation === true)),
                    onChange: (enabled) => setNotifications(chat.id, enabled),
                  },
                  onDelete: () => setDeleting({ id: chat.id, title, open: true }),
                } : undefined}
              />
            )
          })}
        </ListGroup>
      ))}
      {deleting && (
        <DeleteChatDialog
          key={deleting.id}
          open={deleting.open}
          onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
          title={deleting.title}
          onConfirm={confirmDelete}
        />
      )}
    </>
  )
}
