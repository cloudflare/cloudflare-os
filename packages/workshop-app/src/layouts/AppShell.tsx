import type { ReactNode } from 'react'

export type AppShellProps = {
  sidebar: ReactNode
  children: ReactNode
}

/** The application frame: a fixed-width sidebar beside the main content card. */
export const AppShell = ({ sidebar, children }: AppShellProps) => (
  <div className="flex h-full gap-3 p-2">
    <aside className="flex w-62 shrink-0 flex-col">{sidebar}</aside>
    <main className="flex min-w-0 flex-1 flex-col rounded-3xl ring ring-kumo-line bg-kumo-base">{children}</main>
  </div>
)
