import type { ReactNode } from 'react'

export type ListGroupProps = {
  /** What the rows have in common, such as when they were: "Today", "October". Not shown; read out. */
  label: string
  /** The rows. */
  children: ReactNode
}

/** Rows that belong together, on a surface of their own. */
export const ListGroup = ({ label, children }: ListGroupProps) => (
  <section aria-label={label} className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">{children}</section>
)
