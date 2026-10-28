import type { ReactNode } from 'react'

export type AppShellProps = {
  sidebar: ReactNode
  children: ReactNode
}

/** The application frame: a fixed-width sidebar beside the main content card. */
export const AppShell = ({ sidebar, children }: AppShellProps) => (
  <div className="flex h-full gap-2 p-2">
    <aside className="flex w-80 shrink-0 flex-col">{sidebar}</aside>
    <main className="flex min-w-0 flex-1 flex-col rounded-2xl border border-kumo-line">{children}</main>
  </div>
)
