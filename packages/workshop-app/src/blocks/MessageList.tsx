import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { MessagePage, type MessageListItem, type MessageListPage } from './MessagePage'
import { useMessageScroll } from './useMessageScroll'
import { useScrollFadeFallback } from './useScrollFadeFallback'

const VIRTUAL_PAGE_SIZE = 50

export type MessageListProps = {
  /** In conversation order. Expansion/interaction state must outlive virtual page mounts. */
  messages: MessageListItem[]
  /** Live output stays mounted, including while the reader is looking at older pages. */
  children?: ReactNode
  /** Hold live announcements until the streamed reply is complete. */
  streaming?: boolean
  history?: {
    hasMore: boolean
    loading: boolean
    error?: string
    onLoadEarlier: () => void
  }
}

/** A chat-specific, page-windowed list. Fetching and durable message state belong to the caller. */
export const MessageList = ({ messages, children, history, streaming }: MessageListProps) => {
  const { scrollRef, contentRef, atBottom, scrollToBottom, reconcile } = useMessageScroll()
  const startRef = useRef<HTMLDivElement>(null)
  useScrollFadeFallback(scrollRef)
  // Sequence buckets stay stable when history is prepended or an existing message is updated.
  // Keeping page objects stable also lets MessagePage skip rendering on every streaming token.
  const pages = useMemo(() => {
    const result: MessageListPage[] = []
    for (const item of messages) {
      const id = Math.floor(item.sequence / VIRTUAL_PAGE_SIZE)
      if (result.at(-1)?.id !== id) result.push({ id, items: [] })
      result.at(-1)!.items.push(item)
    }
    return result
  }, [messages])
  const { hasMore, loading, error, onLoadEarlier } = history ?? {}
  useEffect(() => {
    if (!hasMore || loading || error || !onLoadEarlier) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onLoadEarlier()
    }, { root: scrollRef.current, rootMargin: '600px 0px 0px 0px' })
    observer.observe(startRef.current!)
    return () => observer.disconnect()
  }, [hasMore, loading, error, onLoadEarlier, scrollRef])

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        className="chat-fade h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          role="log"
          aria-relevant="additions"
          aria-busy={streaming || loading}
          className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-3 pt-[max(0.75rem,var(--header-height,0px))] pb-[calc(var(--composer-half,0px)+0.75rem)]"
        >
          <div ref={startRef} className="shrink-0">
            {hasMore && (
              <div className="flex min-h-9 items-center justify-center gap-2 text-sm text-kumo-subtle">
                {loading ? <span role="status">Loading earlier messages…</span> : (
                  <>
                    {error && <span role="alert">{error}</span>}
                    <Button variant="ghost" onClick={onLoadEarlier}>{error ? 'Retry' : 'Load earlier messages'}</Button>
                  </>
                )}
              </div>
            )}
          </div>
          {pages.map((page) => <MessagePage key={page.id} page={page} scrollRef={scrollRef} onLayout={reconcile} />)}
          <div data-message-anchor="live" className="flex flex-col gap-2">{children}</div>
        </div>
      </div>
      {!atBottom && (
        <div className="absolute inset-x-0 bottom-[calc(var(--composer-half,0px)+0.75rem)] flex justify-center pointer-events-none">
          <Button
            className="pointer-events-auto shadow-sm"
            icon={ArrowDownIcon}
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
            onClick={scrollToBottom}
          />
        </div>
      )}
    </div>
  )
}
