import type { ReactNode } from 'react'
import type { ConnectedFileKind } from '@/files/connectedFile'

// Google's own colours for its file types, from the icons Drive serves for them
// (drive-thirdparty.googleusercontent.com/<size>/type/<media type>). They are the files' marks, as
// a logo is, so they keep Google's values in either theme.
const COLORS: Record<ConnectedFileKind, string> = {
  document: '#3186ff',
  spreadsheet: '#00af57',
  presentation: '#fec700',
}

// Each kind's mark as Drive draws it on a 16-unit square, measured from Google's 256px icons.
const MARKS: Record<ConnectedFileKind, ReactNode> = {
  document: <path d="M4.44 8h7.12M4.44 11.56H8" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" />,
  spreadsheet: <path d="M5.34 2.66v9.75M2.72 5.34h9.69" stroke="#fff" strokeWidth="1.69" strokeLinecap="round" />,
  presentation: <rect x="2.69" y="4.44" width="10.63" height="7.13" rx=".5" fill="none" stroke="#fff" strokeWidth="1.75" />,
}

/**
 * A Google Doc, Sheet or Slides deck's icon as Drive draws it: a rounded square in its kind's
 * colour with the kind's mark. Sized by what it is in, as a Phosphor icon is (1em unless told).
 */
export const GoogleFileIcon = ({ kind, className }: { kind: ConnectedFileKind; className?: string }) => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" className={className}>
    <rect width="16" height="16" rx="2.5" fill={COLORS[kind]} />
    {MARKS[kind]}
  </svg>
)
