import { useState } from 'react'
import { Composer } from '@/blocks/Composer'
import { MessageBubble } from '@/blocks/MessageBubble'
import { ThinkingIndicator } from '@/blocks/ThinkingIndicator'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatItemView } from './ChatItemView'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatSession } from './useChatSession'

/** One workspace's conversation, live: its chat's title, the messages as they arrive, and the composer. */
export const ChatPane = ({ workspaceId }: { workspaceId: string }) => {
  const { chat, send } = useChatSession(workspaceId)
  const model = useDefaultModel()
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  const workspaces = useWorkspaces()
  const workspaceTitle =
    workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId)?.title : undefined
  // The chat's own title once known; until then (or with no chat yet) the workspace's.
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? workspaceTitle

  const sendMessage = (text: string) => {
    if (chat.status !== 'ready') return setProblem('The conversation is still loading. Try again in a moment.')
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    void send(text, model.id)
  }

  return (
    <ChatLayout header={title && <Button>{title}</Button>} composer={<Composer onSend={sendMessage} />}>
      {chat.status === 'ready' && (
        <>
          {chat.items.map((item) => (
            <ChatItemView key={item.id} item={item} />
          ))}
          {chat.streamingText && (
            <MessageBubble role="assistant">
              <Markdown>{chat.streamingText}</Markdown>
            </MessageBubble>
          )}
          {chat.thinking && <ThinkingIndicator />}
          {chat.sendError && <MessageBubble role="error">{chat.sendError}</MessageBubble>}
        </>
      )}
      {chat.status === 'failed' && <MessageBubble role="error">{chat.message}</MessageBubble>}
      {problem && <MessageBubble role="error">{problem}</MessageBubble>}
    </ChatLayout>
  )
}
