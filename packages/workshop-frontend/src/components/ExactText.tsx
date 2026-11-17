import type { ReactNode } from 'react'

// Characters that render as nothing, or reorder the text around them: controls, and default-
// ignorables such as zero-width spaces and bidi overrides, which can make `invoice\u202Efdp.exe`
// read as `invoiceexe.pdf`.
// oxlint-disable-next-line no-control-regex -- matching exactly these characters is the point
export const UNDISPLAYABLE = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/u
// oxlint-disable-next-line no-control-regex -- as above
export const UNDISPLAYABLE_GLOBAL = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/gu

/**
 * Every character a reader cannot tell from its neighbours or from nothing: `UNDISPLAYABLE`, the
 * line and paragraph separators, every space but U+0020 (a no-break space, an em space, the
 * ideographic space) and the blank braille pattern, a symbol that draws nothing. Text shown for
 * someone to vouch for marks each of them.
 */
// oxlint-disable-next-line no-control-regex -- as above
export const HARD_TO_SEE = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}\u2028\u2029\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u2800]/u

// One scan finds both things to mark: a hard-to-see character, and a run of spaces, which is
// marked only where nothing follows it on its line. Matching the whole run at once keeps the scan
// linear however long the run is.
// oxlint-disable-next-line no-control-regex -- as above
const MARKABLE = /[\u0000-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}\u2028\u2029\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u2800]| +/gu

// How a marked character is named: `U+202E`.
const codePointLabel = (character: string) =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

const tokenClass = 'mx-px rounded border border-kumo-line bg-kumo-tint px-0.5 font-mono text-[0.85em] text-kumo-subtle'

/**
 * Text exactly as written, for someone who has to vouch for every character of it. Each
 * `HARD_TO_SEE` character is drawn as a bordered `U+XXXX` token, which no literal text looks
 * like. A line break breaks the line, except with `singleLine` (a path, a header name, a list
 * row), where it is a token too. Spaces that end a line would hang off it unseen, so each is
 * drawn as a dot of its own and can be counted; a space with text after it stays a space.
 *
 * The empty string draws nothing: the caller says in words that there is nothing to show.
 */
export const ExactText = ({ text, singleLine, className = '' }: {
  text: string
  singleLine?: boolean
  className?: string
}) => {
  const parts: ReactNode[] = []
  let plainFrom = 0
  for (const match of text.matchAll(MARKABLE)) {
    const found = match[0]
    const end = match.index + found.length
    let marked: ReactNode
    if (found[0] === ' ') {
      const endsLine = end === text.length || (!singleLine && text[end] === '\n')
      if (!endsLine) continue
      marked = Array.from(found, (_, offset) => (
        <span key={match.index + offset} title="U+0020" className="bg-kumo-tint text-kumo-subtle">·</span>
      ))
    } else if (found === '\n' && !singleLine) {
      continue
    } else {
      const label = codePointLabel(found)
      marked = <span key={match.index} title={label} className={tokenClass}>{label}</span>
    }
    if (match.index > plainFrom) parts.push(text.slice(plainFrom, match.index))
    parts.push(marked)
    plainFrom = end
  }
  if (plainFrom < text.length) parts.push(text.slice(plainFrom))
  return <span className={`whitespace-pre-wrap wrap-anywhere ${className}`}>{parts}</span>
}
