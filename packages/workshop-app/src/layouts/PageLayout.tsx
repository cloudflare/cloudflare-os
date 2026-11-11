import type { ReactNode } from 'react'

export type PageLayoutProps = {
  header: ReactNode
  children: ReactNode
}

/** A page that is not a conversation: a header, then content that scrolls in a centered column. */
export const PageLayout = ({ header, children }: PageLayoutProps) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex p-3">{header}</header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-3 pt-0">{children}</div>
    </div>
  </div>
)
