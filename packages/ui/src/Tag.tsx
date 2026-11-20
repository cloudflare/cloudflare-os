import type { ReactNode } from 'react'
import { Badge } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'

export type TagProps = {
  /** For where it is, such as how much room it may take. */
  className?: string
  children: ReactNode
}

/**
 * A word or two said of what it is beside, quietly: what it is filed under, or what kind it is. An
 * outline only, with nothing filled in, so that it is the same on whatever surface it is on, and
 * as that surface changes under it. Kumo's own outline badge is filled with the page's colour, and
 * rings itself in a link that is pointed at, which a tag in a row that is one is not.
 */
export const Tag = ({ className, children }: TagProps) => (
  <Badge variant="outline" className={cn('border-kumo-line bg-transparent font-normal text-kumo-subtle [a:hover_&]:ring-0', className)}>{children}</Badge>
)
