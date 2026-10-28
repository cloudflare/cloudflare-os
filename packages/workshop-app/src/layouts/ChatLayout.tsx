import type { ReactNode } from 'react'

export type ChatLayoutProps = {
  header?: ReactNode
  composer: ReactNode
  /** The messages; this area scrolls. */
  children?: ReactNode
}

/** A conversation screen: a header on top, scrolling messages, and the composer pinned below. */
export const ChatLayout = ({ header, composer, children }: ChatLayoutProps) => (
  <div className="flex min-h-0 flex-1 flex-col">
    {header && <header className="flex p-3">{header}</header>}
    {/* A reversed column scrolls from its bottom, so the newest message is in view on open and stays
        there as messages arrive, without scroll code. `mb-auto` keeps a short conversation at the top. */}
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="mb-auto flex flex-col gap-1 p-3">{children}</div>
    </div>
    <div className="p-3">{composer}</div>
  </div>
)
