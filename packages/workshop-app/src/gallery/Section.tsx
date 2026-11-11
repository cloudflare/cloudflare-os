import type { ReactNode } from 'react'

/** One titled group of the gallery. */
export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-medium text-kumo-subtle">{title}</h2>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </section>
)
