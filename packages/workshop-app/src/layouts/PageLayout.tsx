import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useScrollFadeFallback } from '@/blocks/useScrollFadeFallback'
import { publishHeight } from './publishHeight'

export type PageLayoutProps = {
  header: ReactNode
  children: ReactNode
}

/**
 * A page that is not a conversation: content that scrolls the full height in a centered column,
 * with the header floating over it, unfilled, and the content fading out under it as a
 * conversation's does (`.chat-fade`).
 */
export const PageLayout = ({ header, children }: PageLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollFadeFallback(scrollRef)

  // The header is out of flow, so its height is measured to keep the content clear of it.
  useLayoutEffect(() => publishHeight(headerRef.current, rootRef.current!, '--header-height'), [])

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="chat-fade absolute inset-0 overflow-y-auto overscroll-y-contain">
        <div className="mx-auto w-full max-w-4xl px-3 pt-[var(--header-height,0px)] pb-3">{children}</div>
      </div>
      {/* Only the header's bubbles take the pointer; the gaps between them let it through. It
          starts clear of what the frame puts there (`--header-lead`), such as a back button. */}
      <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex p-3 ps-[calc(0.75rem+var(--header-lead,0px))] *:pointer-events-auto">
        {header}
      </header>
    </div>
  )
}
