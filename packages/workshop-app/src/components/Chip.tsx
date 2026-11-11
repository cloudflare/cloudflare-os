import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type ChipProps = {
  children: ReactNode
  /** An icon element, shown before the text. */
  icon?: ReactNode
  /** Makes the chip a link that opens in a new tab. */
  href?: string
}

// Tinted with the surrounding text colour, so it reads on a dark bubble as well as a light one.
// Inline rather than a flex box, so a long name wraps with the sentence it is part of.
const CHIP = 'mx-0.5 rounded-full bg-current/12 box-decoration-clone px-2 py-0.5 text-[0.9em] font-medium [&>svg]:me-1 [&>svg]:inline [&>svg]:size-[1em] [&>svg]:align-[-0.125em]'

/** Something named inside running text: a resource, a format, a command. */
export const Chip = ({ children, icon, href }: ChipProps) => {
  const content = (
    <>
      {icon}
      {children}
    </>
  )
  return href
    ? <a href={href} target="_blank" rel="noreferrer noopener" className={cn(CHIP, 'underline-offset-2 hover:underline')}>{content}</a>
    : <span className={CHIP}>{content}</span>
}
