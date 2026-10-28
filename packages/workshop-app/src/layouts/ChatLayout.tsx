import type { ReactNode } from 'react'

export type ChatLayoutProps = {
  header: ReactNode
  composer: ReactNode
  /** The messages; this area scrolls. */
  children: ReactNode
}

/** A conversation screen: a header on top, scrolling messages, and the composer pinned below. */
export const ChatLayout = ({ header, composer, children }: ChatLayoutProps) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex p-3">{header}</header>
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">{children}</div>
    <div className="p-3">{composer}</div>
  </div>
)
