import { useState } from 'react'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { Switch } from '@/components/Switch'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { messageOf } from '@/settings/useAttempt'
import { notificationsOf } from './ChatNotifications'
import { useChatNotifications } from './useChatNotifications'
import { useChatSession } from './useChatSession'
import { useDeleteChat } from './useDeleteChat'

export type ChatOptionsTabProps = {
  workspaceId: string
  chatId: number
  /** The chat's title, as it is shown, which deleting asks about. */
  title: string
  /** The chat was deleted from here: go somewhere else. */
  onDeleted: () => void
}

/**
 * What the viewer can do about a chat, as a tab of its settings, for whoever builds in its
 * workspace: whether it notifies them, marking it read or unread, and deleting it, which asks first.
 */
export const ChatOptionsTab = ({ workspaceId, chatId, title, onDeleted }: ChatOptionsTabProps) => {
  const { chat } = useChatSession(workspaceId, chatId)
  const notifications = useChatNotifications(workspaceId, true)
  const deleteChat = useDeleteChat(workspaceId)
  const connection = useConnectionNotice()
  // Why the last change was not made.
  const [problem, setProblem] = useState<string>()

  const row = notifications.rows.get(chatId)
  const requireParticipation = chat.status === 'ready' && chat.notificationsRequireParticipation
  const { enabled, override } = notificationsOf(row, requireParticipation)
  const unread = (row?.unreadMessageCount ?? 0) > 0

  const changeNotifications = (on: boolean) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    notifications.setEnabled(chatId, on).catch((error: unknown) => setProblem(`Couldn’t change the chat’s notifications: ${messageOf(error)}`))
  }
  const changeRead = (read: boolean) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    notifications.setRead(chatId, read).catch((error: unknown) => setProblem(`Couldn’t mark the chat ${read ? 'read' : 'unread'}: ${messageOf(error)}`))
  }
  const confirmDelete = () => {
    setProblem(undefined)
    if (connection?.blocked()) return
    deleteChat(chatId).then(onDeleted, (error: unknown) => setProblem(`Couldn’t delete the chat: ${messageOf(error)}`))
  }

  return (
    <>
      {problem && <p role="alert" className="px-4 text-base text-kumo-danger">{problem}</p>}
      <SettingsCard>
        <SettingRow
          title="Notify me about this chat"
          description={enabled
            ? 'Shows what is new in it as unread, and alerts you when it finishes or needs your approval.'
            : override === false
              ? 'Muted: nothing in it is shown as unread or alerted.'
              : 'Off until you take part in it: it asked to be joined first.'}
        >
          <Switch aria-label="Notify me about this chat" checked={enabled} onCheckedChange={changeNotifications} />
        </SettingRow>
        <SettingRow
          title={unread ? 'Mark as read' : 'Mark as unread'}
          description={unread
            ? 'It has messages you have not read.'
            : 'Marked unread, it stays so until another message arrives or you come back to the chat.'}
        >
          <Button onClick={() => changeRead(unread)}>{unread ? 'Mark as read' : 'Mark as unread'}</Button>
        </SettingRow>
      </SettingsCard>
      <SettingsCard>
        <SettingRow title="Delete chat" description="What was said in it goes for everyone in the workspace. What it made stays in the library. This can’t be undone.">
          <ConfirmMenu
            label="Delete chat"
            title={`Delete “${title || 'Untitled chat'}”?`}
            description="What was said in it goes for everyone in the workspace, with any changes it hasn’t kept. What it made stays in the library. This can’t be undone."
            confirmLabel="Delete"
            onConfirm={confirmDelete}
          />
        </SettingRow>
      </SettingsCard>
    </>
  )
}
