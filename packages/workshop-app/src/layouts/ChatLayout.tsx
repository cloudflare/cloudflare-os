import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { publishHeight } from './publishHeight'

export type ChatLayoutProps = {
  header?: ReactNode
  composer: ReactNode
  /** The message list, which owns its scrolling. */
  children?: ReactNode
}

/**
 * A conversation screen: the messages scroll the full height, with the header and the composer
 * floating over them, unfilled. Messages and composer share one centered column, so wide screens
 * keep a readable line length.
 */
export const ChatLayout = ({ header, composer, children }: ChatLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const hasHeader = Boolean(header)

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
      {/* End halfway down the composer so faded messages cannot reappear below it. */}
      <div className="absolute inset-x-0 top-0 bottom-[var(--composer-half,0px)]">
        {children}
      </div>
      {/* Only the bars' own content takes the pointer; the gaps around it let it through. The
          header starts clear of what the frame puts there (`--header-lead`), such as a back button. */}
      {header && (
        <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex p-3 ps-[calc(0.75rem+var(--header-lead,0px))]">
          <div className="pointer-events-auto min-w-0">{header}</div>
        </header>
      )}
      <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="pointer-events-auto mx-auto w-full max-w-4xl p-3">{composer}</div>
      </div>
    </div>
  )
}
