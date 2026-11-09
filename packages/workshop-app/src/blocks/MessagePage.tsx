import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

const PAGE_OVERSCAN_PX = 1000

export type MessageListItem = { id: number; content: ReactNode }
export type MessageListPage = { id: number; items: MessageListItem[] }

/** A measured page remains a spacer outside the viewport's buffer. Interactive state belongs to
 * the caller, keyed by message ID, so it survives a page being unmounted. */
export const MessagePage = memo(function MessagePage({ page, scrollRef, onLayout }: {
  page: MessageListPage
  scrollRef: RefObject<HTMLElement | null>
  onLayout: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  const [visible, setVisible] = useState(true)
  const [focused, setFocused] = useState(false)
  // New fetched pages get measured once before becoming spacers. Only fetched history contributes
  // to the scrollbar; reaching the oldest page while a fetch is pending naturally stops scrolling.
  const mounted = visible || focused || height === undefined

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: scrollRef.current,
      rootMargin: `${PAGE_OVERSCAN_PX}px 0px`,
    })
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [scrollRef])

  useLayoutEffect(() => {
    const element = ref.current!
    const measure = () => {
      if (mounted) setHeight(element.getBoundingClientRect().height)
      onLayout()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // A retrospective update can move the reading anchor even if two row resizes cancel out in
    // the page's total height. Observe the mounted rows as well as the page.
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [mounted, page, onLayout])

  return (
    <div
      ref={ref}
      data-message-page={page.id}
      aria-hidden={mounted ? undefined : true}
      style={{ height: mounted ? undefined : height }}
      className="flex shrink-0 flex-col gap-2"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    >
      {mounted && page.items.map(({ id, content }) => (
        <div key={id} data-message-anchor={id}>{content}</div>
      ))}
    </div>
  )
})
