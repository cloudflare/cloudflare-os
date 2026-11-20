import { cn } from '@cloudflare/kumo/utils'
import type { ReactNode } from 'react'

export type ListGroupProps = {
  /** What the rows have in common, such as when they were: "Today", "October". Not shown; read out. */
  label: string
  /** The rows. */
  children: ReactNode
  /** On a tinted surface, such as the side pane's, where the group's own surface is the page's, raised. */
  onTint?: boolean
  /** Drawn with no surface of its own, for one that is drawn on what holds it, such as what it scrolls in. */
  bare?: boolean
}

/** The surface a group's rows are on, for whatever is drawn as one. */
export const groupSurface = (onTint: boolean) => (onTint ? 'bg-kumo-base' : 'bg-kumo-tint')

/** Rows that belong together, on a surface of their own. */
export const ListGroup = ({ label, children, onTint = false, bare = false }: ListGroupProps) => (
  <section aria-label={label} className={cn('flex flex-col rounded-3xl p-1.5', !bare && groupSurface(onTint))}>{children}</section>
)
