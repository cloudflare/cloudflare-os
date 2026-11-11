import { useMemo, useState } from 'react'
import { Composer } from '@/blocks/Composer'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList } from '@/blocks/MessageList'
import { ThinkingIndicator } from '@/blocks/ThinkingIndicator'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ChatLayout } from '@/layouts/ChatLayout'
import { ChatItemView } from './ChatItemView'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatSession } from './useChatSession'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
}

/** One chat, live: its title, the messages as they arrive, and the composer. */
export const ChatPane = ({ workspaceId, chatId, initialTitle }: ChatPaneProps) => {
  const { chat, send, loadEarlier } = useChatSession(workspaceId, chatId)
  const model = useDefaultModel()
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined
  const messages = useMemo(() => {
    // An artefact is shown at the end of its turn, after rows from later messages, so a row's
    // place in the conversation is the furthest sequence reached so far.
    let sequence = 0
    return items?.map((item) => {
      sequence = Math.max(sequence, item.id)
      return { id: item.key, sequence, content: <ChatItemView item={item} /> }
    }) ?? []
  }, [items])

  const sendMessage = (text: string) => {
    if (chat.status !== 'ready') return setProblem('The conversation is still loading. Try again in a moment.')
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    void send(text, model.id)
  }

  return (
    <ChatLayout header={title && <Button>{title}</Button>} composer={<Composer onSend={sendMessage} />}>
      {chat.status === 'ready' && (
        <MessageList
          messages={messages}
          streaming={chat.thinking || Boolean(chat.streamingText)}
          history={{ hasMore: chat.hasEarlier, loading: chat.loadingEarlier, error: chat.historyError, onLoadEarlier: loadEarlier }}
        >
          {chat.openTools && <ChatItemView item={chat.openTools} />}
          {chat.streamingText && (
            <MessageBubble role="assistant">
              <Markdown>{chat.streamingText}</Markdown>
            </MessageBubble>
          )}
          {chat.thinking && <ThinkingIndicator />}
          {/* Below whatever is still being written, so what an answer produced is never left behind it. */}
          {chat.pinned.map((item) => <ChatItemView key={item.key} item={item} />)}
          {chat.queuedSteers.map(({ text }, index) => <MessageBubble key={index} role="user">{text}</MessageBubble>)}
          {chat.sendError && <MessageBubble role="error">{chat.sendError}</MessageBubble>}
          {problem && <MessageBubble role="error">{problem}</MessageBubble>}
        </MessageList>
      )}
      {chat.status !== 'ready' && (
        <MessageList messages={[]}>
          {chat.status === 'failed'
            ? <MessageBubble role="error">{chat.message}</MessageBubble>
            : <span role="status" className="text-sm text-kumo-subtle">Loading conversation…</span>}
          {problem && <MessageBubble role="error">{problem}</MessageBubble>}
        </MessageList>
      )}
    </ChatLayout>
  )
}
