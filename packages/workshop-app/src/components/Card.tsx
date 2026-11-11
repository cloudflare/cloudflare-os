import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

/** The shape cards and card-like buttons share. */
export const CARD = 'rounded-[21px] bg-kumo-base ring-1 ring-kumo-line'

/** An outlined surface for something that waits on the user: a decision, or a thing to open. */
export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn(CARD, 'flex max-w-[min(100%,36rem)] flex-col gap-3 p-4 text-base/5', className)}>{children}</div>
)
