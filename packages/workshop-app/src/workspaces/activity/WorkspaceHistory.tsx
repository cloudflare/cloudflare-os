import type { ReactNode } from 'react'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { chatTitle } from '../chatList'
import { HistoryView } from './HistoryView'
import type { useWorkspaceActivity } from './useWorkspaceActivity'

export type WorkspaceHistoryProps = {
  /** The workspace's activity, which its page holds, as its chats' tab shows what waits from it too. */
  activity: ReturnType<typeof useWorkspaceActivity>
  onOpenChat: (chat: { id: number; title: string }) => void
  chatHref?: (chatId: number) => string
  /** What it is called, on the line of its search and filters. */
  heading?: ReactNode
  /** Its entries scroll in a box of their own (`HistoryView`'s `scrolls`). */
  scrolls?: boolean
}

const NO_HISTORY = { entries: [], read: false, reading: true, more: false }

/** A workspace's activity log, at the bottom of its Settings tab (`HistoryView`), from its activity (`WorkspaceActivity`), each entry with the chat it was made in. */
export const WorkspaceHistory = ({ activity: { state, activity }, onOpenChat, chatHref, heading, scrolls }: WorkspaceHistoryProps) => {
  const { user } = useApi()
  const ready = state.status === 'ready' ? state : undefined
  const byId = new Map((ready?.chats ?? []).map((chat) => [chat.id, chat]))

  const chatOf = (entry: ActionLogEntry) => {
    const id = entry.chatId ?? ready?.actionChats.get(entry.id)
    const chat = id === undefined ? undefined : byId.get(id)
    return id === undefined ? undefined : { id, title: chat ? chatTitle(chat) : 'A chat' }
  }

  if (state.status === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load the activity log: {state.message}</p>
      </div>
    )
  }
  return (
    <HistoryView
      viewerId={user.id}
      history={ready?.history ?? NO_HISTORY}
      chatOf={chatOf}
      onOpenChat={onOpenChat}
      chatHref={chatHref}
      onLoadOlder={() => activity.loadOlder()}
      heading={heading}
      scrolls={scrolls}
    />
  )
}
