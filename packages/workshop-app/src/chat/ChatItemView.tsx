import { memo } from 'react'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Markdown } from '@/components/Markdown'
import type { ChatItem } from './chatItems'

/**
 * One committed message. Memoized: items keep their identity while a reply streams in, so the
 * conversation above it is not rendered again for every piece of text that arrives.
 */
export const ChatItemView = memo(function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <MessageBubble role="user">{item.text}</MessageBubble>
    case 'assistant':
      return (
        <MessageBubble role="assistant">
          <Markdown>{item.text}</Markdown>
        </MessageBubble>
      )
    case 'error':
      return <MessageBubble role="error">{item.text}</MessageBubble>
    case 'unsupported':
      return <MessageBubble role="assistant">Missing implementation</MessageBubble>
  }
})
