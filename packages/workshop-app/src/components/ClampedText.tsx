import { useState } from 'react'
import { clampText } from './clampText'

export type ClampedTextProps = {
  children: string
  /** How many characters of it are shown until the rest is asked for. */
  limit: number
  /** Styles the text. */
  className?: string
}

/**
 * A paragraph that is cut short where it runs long, with "more" right after what is left of it,
 * which shows the rest, for good. A short one is only the paragraph.
 *
 * It is cut by how many characters it has, not by how many lines it takes, which only the layout
 * could say: nothing is measured, so a list of them costs what their text does, and what is kept
 * takes more lines where there is less room.
 */
export const ClampedText = ({ children, limit, className }: ClampedTextProps) => {
  const [open, setOpen] = useState(false)
  const head = clampText(children, limit)

  if (open || head === undefined) return <p className={className}>{children}</p>
  return (
    <p className={className}>
      {head}…{' '}
      <button type="button" aria-label="Read more" onClick={() => setOpen(true)} className="cursor-pointer font-medium text-kumo-subtle hover:text-kumo-default">
        more
      </button>
    </p>
  )
}
