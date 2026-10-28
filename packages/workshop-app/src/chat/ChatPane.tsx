import { Composer } from '@/blocks/Composer'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { ChatItem } from './chatItems'
import { useChatSession } from './useChatSession'

const renderItem = (item: ChatItem) => {
  switch (item.kind) {
    case 'user':
      return <MessageBubble key={item.id} role="user">{item.text}</MessageBubble>
    case 'assistant':
      return (
        <MessageBubble key={item.id} role="assistant">
          <Markdown>{item.text}</Markdown>
        </MessageBubble>
      )
    case 'error':
      return <MessageBubble key={item.id} role="error">{item.text}</MessageBubble>
    case 'unsupported':
      return <MessageBubble key={item.id} role="assistant">Missing implementation</MessageBubble>
  }
}

/** One workspace's conversation: its latest chat's title, the messages, and the composer. */
export const ChatPane = ({ workspaceId }: { workspaceId: string }) => {
  const chat = useChatSession(workspaceId)
  const workspaces = useWorkspaces()
  const workspaceTitle =
    workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId)?.title : undefined
  // The chat's own title once known; until then (or with no chat yet) the workspace's.
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? workspaceTitle

  return (
    <ChatLayout header={title && <Button>{title}</Button>} composer={<Composer onSend={() => {}} />}>
      {chat.status === 'ready' && chat.items.map(renderItem)}
      {chat.status === 'failed' && <MessageBubble role="error">{chat.message}</MessageBubble>}
    </ChatLayout>
  )
}
