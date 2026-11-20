import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { useScrollFadeFallback } from './useScrollFadeFallback'
import { publishHeight } from './publishHeight'

export type PageLayoutProps = {
  header: ReactNode
  /**
   * What floats over the end of the content, in the middle, as the header does over its start:
   * a list's controls on a narrow screen, where they are in reach of a thumb.
   */
  footer?: ReactNode
  /**
   * The content is at least as tall as the room under the header, as a column a child can grow
   * into (`flex-1`): for a page with nothing on it, whose empty state is centred in that room.
   */
  fill?: boolean
  children: ReactNode
}

/**
 * A page that is not a conversation: content that scrolls the full height in a centered column,
 * with the header floating over it, unfilled, and the content fading out under it as a
 * conversation's does (`.chat-fade`). A footer floats over its end the same way, as a chat's
 * composer does.
 */
export const PageLayout = ({ header, footer, fill = false, children }: PageLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollFadeFallback(scrollRef)
  const hasFooter = Boolean(footer)

  // The bars are out of flow, so their heights are measured to keep the content clear of them.
  // The footer's is given as a composer's is, which is what the fade at the end is measured from.
  useLayoutEffect(() => {
    const root = rootRef.current!
    const stopHeader = publishHeight(headerRef.current, root, '--header-height')
    const stopHalf = publishHeight(footerRef.current, root, '--composer-half', 0.5)
    return () => {
      stopHeader()
      stopHalf()
    }
  }, [hasFooter])

  // A drag with nothing left to scroll pulls the whole window along and springs it back, which a
  // conversation is left to do. Under a footer it is not: the footer would go with it, as though
  // it were the end of the content rather than the app's own. Only while there is one, as the
  // window's is the one setting there is for it.
  useEffect(() => {
    if (!hasFooter) return
    const { style } = document.documentElement
    const before = style.overscrollBehavior
    style.overscrollBehavior = 'none'
    return () => {
      style.overscrollBehavior = before
    }
  }, [hasFooter])

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      {/* Ends halfway down the footer, so that what has faded out cannot reappear below it. */}
      <div ref={scrollRef} className="chat-fade absolute inset-x-0 top-0 bottom-[var(--composer-half,0px)] overflow-y-auto overscroll-y-contain">
        <div className={cn('mx-auto w-full max-w-4xl px-3 pt-[var(--header-height,0px)] pb-[calc(0.75rem+var(--composer-half,0px))]', fill && 'flex min-h-full flex-col')}>{children}</div>
      </div>
      {/* Only the header's bubbles take the pointer; the gaps between them let it through. It
          starts clear of what the frame puts there (`--header-lead`), such as a back button. */}
      <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex p-3 ps-[calc(0.75rem+var(--header-lead,0px))] *:pointer-events-auto">
        {header}
      </header>
      {footer && (
        <div ref={footerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3 *:pointer-events-auto">
          {footer}
        </div>
      )}
    </div>
  )
}
