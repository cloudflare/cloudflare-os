import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import './Arrival.css'

/**
 * The shape cards and card-like buttons share: outlined, and lifted off the page by a shadow faint
 * enough to be felt more than seen. One that has just arrived grows in (see Arrival.css).
 */
export const CARD = 'arrives origin-top-left rounded-[21px] bg-kumo-base ring-1 ring-kumo-line shadow-[0_2px_6px_rgb(0_0_0/0.03)]'

/**
 * An outlined surface for something that waits on the user: a decision, or a thing to open. As
 * wide as what is in it, the way a message is, between a width below which a card with little in
 * it looks pinched and one up to which it stays readable.
 */
export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn(CARD, 'flex w-fit max-w-[min(100%,36rem)] min-w-[min(100%,20rem)] flex-col gap-3 p-4 text-base/5', className)}>{children}</div>
)
