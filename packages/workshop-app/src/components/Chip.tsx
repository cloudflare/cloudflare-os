import { useRef, useState, type ReactNode } from 'react'
import { webUrl } from '@gadgets/ui'
import { ChipTooltip, type ChipAbout } from './ChipTooltip'
import './Chip.css'

// What is said of a chip by whoever draws it: all but what is the chip's own to know, its icon
// and whether its name is cut short.
type About = Omit<ChipAbout, 'icon' | 'cut'>

export type ChipProps = {
  children: ReactNode
  /** What it is, drawn before its name: a glyph, or a service's logo. */
  icon?: ReactNode
  /** Makes the chip a link that opens in a new tab, when it is a web address. */
  href?: string
  /**
   * What there is to say of it beyond its name, in a card over it while it is pointed at, by its
   * own icon: as it is, or the way to find out, asked as the card is about to show. Where that
   * is nothing, there is no card.
   */
  about?: About | (() => About | undefined)
}

/**
 * Something named among words: a skill, a format, a connection. A small bubble of the app's own
 * with what it is before its name, the same in a draft being written and in the message it is
 * sent as. One piece, as a name is: it moves to the next line whole, and a name too long for the
 * line is cut short, whole on hover. It is 21px, or less on lines too short for that, in the
 * middle of its line (`Chip.css`).
 */
export const Chip = ({ children, icon, href: given, about }: ChipProps) => {
  const href = webUrl(given)
  const name = typeof children === 'string' ? children : undefined
  // A name cut short is whole on hover: as the browser says it, or in its card where it has one,
  // which is then worth showing for that alone. Found out as the chip is gone to.
  const nameRef = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState(false)
  const measure = about ? () => setCut(!!nameRef.current && nameRef.current.scrollWidth > nameRef.current.clientWidth) : undefined
  const title = about ? undefined : name
  const content = (
    <>
      {icon}
      <span ref={nameRef} className="chip-name">{children}</span>
    </>
  )
  const chip = href
    ? <a href={href} target="_blank" rel="noreferrer noopener" title={title} onPointerEnter={measure} onFocus={measure} className="chip">{content}</a>
    : <span title={title} onPointerEnter={measure} className="chip">{content}</span>
  if (!about) return chip
  const said = () => {
    const found = typeof about === 'function' ? about() : about
    if (found) return { icon, cut, ...found }
    return cut && name !== undefined ? { icon, cut, title: name } : undefined
  }
  return <ChipTooltip about={said}>{chip}</ChipTooltip>
}
