import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import './ShimmerText.css'

export type ShimmerTextProps = {
  children: ReactNode
  /** Whether it sweeps; otherwise it is the text as it is. Defaults to true. */
  active?: boolean
  className?: string
}

/**
 * Text for something under way, such as "Reconnecting…": a band of light sweeps across it, over
 * and over, in the text's own colour. Not for anything that is waiting on the user.
 */
export const ShimmerText = ({ children, active = true, className }: ShimmerTextProps) => (
  <span data-active={active || undefined} className={cn('shimmer-text', className)}>
    {children}
  </span>
)
