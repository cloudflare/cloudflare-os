import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { webUrl } from '@gadgets/ui'

export type ChipProps = {
  children: ReactNode
  /** An icon element, shown before the text. */
  icon?: ReactNode
  /** Makes the chip a link that opens in a new tab, when it is a web address. */
  href?: string
}

// Tinted with the surrounding text colour, so it reads on a dark bubble as well as a light one.
// One piece, as a name is: it moves to the next line whole rather than breaking between its icon
// and its words, and a name too long for the line is cut short, whole on hover.
const CHIP = 'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full bg-current/12 px-2 py-0.5 align-[-0.3em] text-[0.9em]/[1.25] font-medium whitespace-nowrap [&>svg]:size-[1em] [&>svg]:shrink-0'

/** Something named inside running text: a resource, a format, a command. */
export const Chip = ({ children, icon, href: given }: ChipProps) => {
  const href = webUrl(given)
  const content = (
    <>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  return href
    ? <a href={href} target="_blank" rel="noreferrer noopener" title={typeof children === 'string' ? children : undefined} className={cn(CHIP, 'underline-offset-2 hover:underline')}>{content}</a>
    : <span title={typeof children === 'string' ? children : undefined} className={CHIP}>{content}</span>
}
