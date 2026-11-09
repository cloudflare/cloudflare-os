import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useScrollFadeFallback } from './useScrollFadeFallback'

export type ChatLayoutProps = {
  header?: ReactNode
  composer: ReactNode
  /** The messages; this area scrolls. */
  children?: ReactNode
}

/** Publishes an element's height as a CSS variable on `target`, and keeps it current. */
const publishHeight = (element: HTMLElement | null, target: HTMLElement, name: string, scale = 1) => {
  if (!element) {
    target.style.setProperty(name, '0px')
    return () => {}
  }
  const update = () => target.style.setProperty(name, `${element.getBoundingClientRect().height * scale}px`)
  update()
  const observer = new ResizeObserver(update)
  observer.observe(element, { box: 'border-box' })
  return () => observer.disconnect()
}

/**
 * A conversation screen: the messages scroll the full height, with the header and the composer
 * floating over them, unfilled. Messages and composer share one centered column, so wide screens
 * keep a readable line length.
 */
export const ChatLayout = ({ header, composer, children }: ChatLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const hasHeader = Boolean(header)
  useScrollFadeFallback(scrollerRef)

  // The bars are out of flow, so their heights are measured to keep the messages clear of them.
  // Variables on the root, not React state, so an animating composer does not re-render the chat.
  useLayoutEffect(() => {
    const root = rootRef.current!
    const stopHeader = publishHeight(headerRef.current, root, '--header-height')
    const stopHalf = publishHeight(composerRef.current, root, '--composer-half', 0.5)
    return () => {
      stopHeader()
      stopHalf()
    }
  }, [hasHeader])

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      {/* The scroller ends halfway down the composer, so messages vanish there instead of showing
          again below it. A reversed column scrolls from its bottom, so the newest message is in view
          on open and stays there as messages arrive, without scroll code; `mb-auto` keeps a short
          conversation at the top. */}
      {/* Once scrolled, the top edge fades messages to a third of their strength, never to nothing,
          across the header's height plus a little more, so they read as passing beneath it; the
          bottom edge fades them out toward the composer (`chat-fade`, in styles.css). */}
      <div
        ref={scrollerRef}
        className="absolute inset-x-0 top-0 bottom-[var(--composer-half,0px)] flex flex-col-reverse overflow-y-auto chat-fade"
      >
        <div className="mx-auto mb-auto flex w-full max-w-4xl flex-col gap-2 px-3 pt-[max(0.75rem,var(--header-height,0px))] pb-[calc(var(--composer-half,0px)+0.75rem)]">
          {children}
        </div>
      </div>
      {/* Only the bars' own content takes the pointer; the gaps around it let it through. */}
      {header && (
        <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex p-3">
          <div className="pointer-events-auto">{header}</div>
        </header>
      )}
      <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="pointer-events-auto mx-auto w-full max-w-4xl p-3">{composer}</div>
      </div>
    </div>
  )
}
