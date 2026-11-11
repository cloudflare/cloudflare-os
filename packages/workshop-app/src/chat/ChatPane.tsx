import { useMemo, useState } from 'react'
import { Composer } from '@/blocks/Composer'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList } from '@/blocks/MessageList'
import { ThinkingIndicator } from '@/blocks/ThinkingIndicator'
import { UserMessage } from '@/blocks/UserMessage'
import { Button } from '@/components/Button'
import { ChatLayout } from '@/layouts/ChatLayout'
import { ChatItemView, type ChatItemHandlers } from './ChatItemView'
import { DisclosureStore, useOpenKeys } from './DisclosureStore'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatSession } from './useChatSession'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
}

const LIVE_REASONING = 'live:reasoning'

/** One chat, live: its title, the messages as they arrive, and the composer. */
export const ChatPane = ({ workspaceId, chatId, initialTitle }: ChatPaneProps) => {
  const { chat, send, loadEarlier } = useChatSession(workspaceId, chatId)
  const model = useDefaultModel()
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  // What a row asked for that this app cannot do yet.
  const [notice, setNotice] = useState<string>()
  const [disclosure] = useState(() => new DisclosureStore())
  const liveReasoningOpen = useOpenKeys(disclosure, [LIVE_REASONING]).has(LIVE_REASONING)
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined

  const handlers = useMemo((): ChatItemHandlers => {
    const unavailable = (what: string) => () => setNotice(`${what} isn’t available in this app yet.`)
    return {
      onOpenAttachment: unavailable('Previewing attachments'),
      onOpenOutput: unavailable('Opening outputs'),
      onApprove: unavailable('Approving actions'),
      onDeny: unavailable('Denying actions'),
      onAlwaysApprove: unavailable('Standing approvals'),
      onHookEnabledChange: unavailable('Switching hooks'),
      onSetUpConnection: unavailable('Setting up connections'),
      onDenyConnection: unavailable('Denying connections'),
      onRetry: unavailable('Retrying'),
      onContinue: unavailable('Adding credits'),
    }
  }, [])

  const row = (item: Parameters<typeof ChatItemView>[0]['item']) => (
    <ChatItemView key={item.key} item={item} disclosure={disclosure} handlers={handlers} />
  )

  const messages = useMemo(() => {
    // An artefact is shown at the end of its turn, after rows from later messages, so a row's
    // place in the conversation is the furthest sequence reached so far.
    let sequence = 0
    return items?.map((item) => {
      sequence = Math.max(sequence, item.id)
      return { id: item.key, sequence, content: <ChatItemView item={item} disclosure={disclosure} handlers={handlers} /> }
    }) ?? []
  }, [items, disclosure, handlers])

  const sendMessage = (text: string) => {
    if (chat.status !== 'ready') return setProblem('The conversation is still loading. Try again in a moment.')
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    setNotice(undefined)
    void send(text, model.id)
  }

  return (
    <ChatLayout header={title && <Button>{title}</Button>} composer={<Composer onSend={sendMessage} />}>
      {chat.status === 'ready' && (
        <MessageList
          messages={messages}
          streaming={chat.agentActive || Boolean(chat.streamingText)}
          history={{ hasMore: chat.hasEarlier, loading: chat.loadingEarlier, error: chat.historyError, onLoadEarlier: loadEarlier }}
        >
          {chat.openTools && row(chat.openTools)}
          {(chat.streamingText || chat.streamingReasoning) && (
            <AssistantMessage
              live
              text={chat.streamingText}
              reasoning={chat.streamingReasoning
                ? { text: chat.streamingReasoning, open: liveReasoningOpen, onToggle: () => disclosure.toggle(LIVE_REASONING) }
                : undefined}
            />
          )}
          {chat.streamingTools && row(chat.streamingTools)}
          {chat.compacting && <ThinkingIndicator>Compacting the conversation…</ThinkingIndicator>}
          {chat.thinking && <ThinkingIndicator />}
          {/* Below whatever is still being written, so what an answer produced is never left behind it. */}
          {chat.pinned.map(row)}
          {chat.queuedSteers.map(({ text, from }, index) => (
            <UserMessage key={index} parts={[{ type: 'text', text }]} from={from} unread />
          ))}
          {chat.sendError && <MessageBubble role="error">{chat.sendError}</MessageBubble>}
          {problem && <MessageBubble role="error">{problem}</MessageBubble>}
          {notice && <p role="status" className="px-2 text-sm text-kumo-subtle">{notice}</p>}
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
