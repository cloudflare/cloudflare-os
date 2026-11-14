import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from 'react'
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
  ref?: Ref<MessageListHandle>
}

export type MessageListHandle = {
  /** Brings one of `messages` into view and points it out. Nothing happens for an id not among them. */
  scrollToMessage: (id: MessageListItem['id']) => void
  /**
   * Goes to the end of the conversation and follows it from there, wherever the reader was: for
   * when they have just said something themselves.
   */
  scrollToLatest: () => void
}

/** The clock of Arrival.css, which a row opens on so that what is below moves with what grows in. */
const ARRIVAL = { duration: 420, easing: 'linear(0, 0.18 8%, 0.53 18%, 0.79 30%, 0.94 43%, 1.018 60%, 1.012 74%, 1)' }

/**
 * Lets a row arrive: it opens from nothing to its height, pushing what is below it down
 * gradually, while what is in it animates in (see Arrival.css). The row is marked for as long as
 * that takes. Done on the element rather than through React: it is a one-off for that element,
 * which a row mounted again later (the pages are virtual) must not repeat.
 */
const markArriving = (row: Element) => {
  // Measured before the row is marked: what is in it may start out placed differently as it
  // animates in (a message draws up to the one it joins), and the row has to open to the height it
  // will end at, or it would jump to it when the animation was over.
  const { height } = row.getBoundingClientRect()
  row.setAttribute('data-arriving', '')
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // A row of no height would still be given the list's `gap-2`, so it starts by taking that back.
    row.animate([{ height: '0px', marginTop: '-0.5rem' }, { height: `${height}px`, marginTop: '0px' }], ARRIVAL)
  }
  const arrivals = row.getAnimations({ subtree: true }).map(({ finished }) => finished)
  void Promise.allSettled(arrivals).then(() => row.removeAttribute('data-arriving'))
}

/** A chat-specific, page-windowed list. Fetching and durable message state belong to the caller. */
export const MessageList = ({ messages, children, history, streaming, ref }: MessageListProps) => {
  const { scrollRef, contentRef, atBottom, scrollToBottom, scrollToRow, reconcile } = useMessageScroll()
  useImperativeHandle(ref, () => ({
    scrollToMessage: (id) => {
      const sequence = messages.find((message) => message.id === id)?.sequence
      if (sequence !== undefined) scrollToRow(String(id), Math.floor(sequence / VIRTUAL_PAGE_SIZE))
    },
    scrollToLatest: scrollToBottom,
  }), [messages, scrollToRow, scrollToBottom])
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
  // Rows that join the end of the conversation while it is open are marked as arriving, for the
  // blocks in them that animate in. Before paint, so a row is never seen at rest first.
  const shown = useRef<{ ids: Set<string | number>; last: number }>(undefined)
  useLayoutEffect(() => {
    const before = shown.current
    shown.current = { ids: new Set(messages.map(({ id }) => id)), last: messages.at(-1)?.sequence ?? -Infinity }
    // What is there when the list is first shown is the conversation as it was found.
    if (!before) return
    for (const { id, sequence } of messages) {
      // Earlier history paged in, or a row that took its place among older ones, has not just arrived.
      if (before.ids.has(id) || sequence < before.last) continue
      const row = contentRef.current?.querySelector(`[data-message-anchor="${CSS.escape(String(id))}"]`)
      if (row) markArriving(row)
    }
  }, [messages, contentRef])
  // Likewise what joins the live output after it was first shown, such as a card an answer produced.
  const liveRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const observer = new MutationObserver((changes) => {
      for (const { addedNodes } of changes) {
        for (const node of addedNodes) if (node instanceof Element) markArriving(node)
      }
    })
    observer.observe(liveRef.current!, { childList: true })
    return () => observer.disconnect()
  }, [])
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
      {/* Scrolled up and down only: a sideways swipe is never taken here, nor kept from going
          on, so it is the browser's (back and forward). */}
      <div
        ref={scrollRef}
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        className="chat-fade h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          role="log"
          aria-relevant="additions"
          aria-busy={streaming || loading}
          className="appears mx-auto flex w-full max-w-4xl flex-col gap-2 px-3 pt-[max(0.75rem,var(--header-height,0px))] pb-[calc(var(--composer-half,0px)+0.75rem)]"
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
          <div ref={liveRef} data-message-anchor="live" className="flex flex-col gap-2">{children}</div>
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
