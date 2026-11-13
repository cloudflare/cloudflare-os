import type { ReactNode } from 'react'

export type StartLayoutProps = {
  header?: ReactNode
  /** What is started from, in the middle of the page, such as a greeting over the composer. */
  children: ReactNode
}

/**
 * A page to start from nothing: what is started from in the middle, with the header floating over
 * the page as a conversation's does (`ChatLayout`), so that it stays put as the start becomes one.
 */
export const StartLayout = ({ header, children }: StartLayoutProps) => (
  <div className="relative flex min-h-0 flex-1 flex-col">
    {children}
    {/* Only the header's own content takes the pointer. It starts clear of what the frame puts
        there (`--header-lead`), such as a back button. */}
    {header && (
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex p-3 ps-[calc(0.75rem+var(--header-lead,0px))]">
        <div className="pointer-events-auto min-w-0">{header}</div>
      </header>
    )}
  </div>
)
