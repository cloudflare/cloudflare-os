import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from '@/blocks/Composer'
import { LiveRows } from '@/blocks/LiveRows'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList, type MessageListHandle } from '@/blocks/MessageList'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { ChatLayout } from '@/layouts/ChatLayout'

/** Exercises streaming, slow history, stateful resizing, and rows arriving and leaving, independently of the backend. */
export const MessageListPreview = () => {
  const [conversation, setConversation] = useState(0)
  const [ids, setIds] = useState(() => Array.from({ length: 50 }, (_, i) => i + 550))
  const [expanded, setExpanded] = useState(new Set<number>())
  const [approved, setApproved] = useState(new Set<number>())
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [card, setCard] = useState(false)
  const [text, setText] = useState('')
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const list = useRef<MessageListHandle>(null)
  const first = ids[0]
  const loadEarlier = useCallback(() => {
    if (pending.current !== undefined || first === 0) return
    setLoading(true)
    pending.current = setTimeout(() => {
      setIds((current) => [...Array.from({ length: Math.min(50, first) }, (_, i) => Math.max(0, first - 50) + i), ...current])
      pending.current = undefined
      setLoading(false)
    }, 500)
  }, [first])
  useEffect(() => () => clearTimeout(pending.current), [])
  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => setText((current) => current + ' More streaming text.'), 80)
    return () => clearInterval(timer)
  }, [streaming])

  const messages = useMemo(() => ids.map((id) => ({
    id,
    sequence: id,
    content: (
      <MessageBubble role={id % 2 ? 'assistant' : 'user'}>
        <p>Message {id}: {'A variable-height conversation. '.repeat(1 + id % 5)}</p>
        {id % 2 === 1 && (
          <>
            <Button variant="ghost" aria-expanded={expanded.has(id)} onClick={() => setExpanded((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })}>Thinking {id}</Button>
            {expanded.has(id) && <p>{'Expanded reasoning with additional details. '.repeat(40)}</p>}
          </>
        )}
        {id % 10 === 0 && (
          <Button disabled={approved.has(id)} onClick={() => setApproved((current) => new Set([...current, id]))}>
            {approved.has(id) ? 'Approved' : `Approve ${id}`}
          </Button>
        )}
      </MessageBubble>
    ),
  })), [ids, expanded, approved])

  const restart = () => {
    clearTimeout(pending.current)
    pending.current = undefined
    setLoading(false)
    setStreaming(false)
    setText('')
    setIds(Array.from({ length: 50 }, (_, i) => i + 550))
    setExpanded(new Set())
    setApproved(new Set())
    setConversation((current) => current + 1)
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex gap-2">
        <Button onClick={restart}>Open another chat</Button>
        <Button onClick={() => setStreaming((current) => !current)}>{streaming ? 'Stop stream' : 'Start stream'}</Button>
        <Button onClick={() => setCard((current) => !current)}>{card ? 'Remove the card' : 'Add a card'}</Button>
        <Button onClick={() => list.current?.scrollToMessage(first)}>Go to message {first}</Button>
        <span className="self-center text-sm text-kumo-subtle">{ids.length} / 600 messages loaded</span>
      </div>
      <div className="flex h-[32rem] w-full flex-col overflow-hidden rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
        <ChatLayout header={<Button>Virtualized conversation</Button>} composer={(
          <Composer
            onSend={() => {
              list.current?.scrollToLatest()
              setIds((current) => [...current, current.at(-1)! + 1])
            }}
          />
        )}>
          <MessageList ref={list} key={conversation} messages={messages} streaming={streaming} history={{ hasMore: first > 0, loading, onLoadEarlier: loadEarlier }}>
            {text && <MessageBubble role="assistant">{text}</MessageBubble>}
            <LiveRows>
              {card && (
                <LiveRows.Row key="card">
                  <Card>A card under the conversation. It grows in as its row opens, and its row closes as it leaves.</Card>
                </LiveRows.Row>
              )}
            </LiveRows>
          </MessageList>
        </ChatLayout>
      </div>
    </div>
  )
}
