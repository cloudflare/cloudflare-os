import type { ReactNode } from 'react'
import { EnvelopeSimple, PencilSimpleLine } from '@phosphor-icons/react'
import type { DraftKind } from './drafts'

// Google's own colors for its file types, from the icons Drive serves for them today
// (drive-thirdparty.googleusercontent.com/<size>/type/<mime type>). They are the files' marks, as
// a logo is, so they keep Google's values rather than a theme's.
const COLORS: Partial<Record<DraftKind, string>> = {
  document: '#3186ff',
  spreadsheet: '#00af57',
  presentation: '#fec700',
}

const WHITE = '#fff'

// Each mark as Drive draws it on a 16-unit square, measured from Google's 256px icons.
const glyph = (kind: DraftKind): ReactNode => {
  switch (kind) {
    case 'document':
      return (
        <g stroke={WHITE} strokeWidth="1.75" strokeLinecap="round">
          <path d="M4.44 8h7.12M4.44 11.56H8" />
        </g>
      )
    case 'spreadsheet':
      return (
        <g stroke={WHITE} strokeWidth="1.69" strokeLinecap="round">
          <path d="M5.34 2.66v9.75M2.72 5.34h9.69" />
        </g>
      )
    case 'presentation':
      return <rect x="2.69" y="4.44" width="10.63" height="7.13" rx=".5" fill="none" stroke={WHITE} strokeWidth="1.75" />
    default:
      return null
  }
}

/**
 * What a draft changes, as its provider marks it: a Google file as Drive draws its icon (a rounded
 * square in its kind's color, with the kind's mark), an email as an envelope, else a pencil.
 */
export const DraftFileIcon = ({ kind, size = 16, className = '' }: {
  kind: DraftKind
  size?: number
  className?: string
}) => {
  const color = COLORS[kind]
  if (!color) {
    const Icon = kind === 'email' ? EnvelopeSimple : PencilSimpleLine
    return <Icon size={size} aria-hidden="true" className={`flex-shrink-0 text-kumo-subtle ${className}`} />
  }
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className={`flex-shrink-0 ${className}`}>
      <rect width="16" height="16" rx="2.5" fill={color} />
      {glyph(kind)}
    </svg>
  )
}
