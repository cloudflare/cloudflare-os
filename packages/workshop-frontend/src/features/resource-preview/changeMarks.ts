import type { CSSProperties, KeyboardEvent } from 'react'
import { colors } from './googleTheme'

/** A decision already made on a change: approved changes are drawn settled, rejected ones undone. */
export type ChangeDecision = 'approved' | 'rejected'

/** Where a change stands, as a preview draws it. */
export type ChangeState = 'pending' | ChangeDecision

/** How a preview marks its changes, shared by every renderer. Changes are ActionLogEntry ids. */
export type ChangeMarks = {
  focusedChangeId: number | null
  decided: ReadonlyMap<number, ChangeDecision>
  onChangeClick: (changeId: number) => void
}

/**
 * Whether a change id names a change that can be decided. `ResourcePreview.actions` holds -1 for
 * an action decided while the preview was being drawn: its effect is still in the drawn content,
 * so it is drawn as a change, but it cannot be focused, clicked, or found by `data-change-id`.
 */
export const isAttributed = (changeId: number) => changeId >= 0

export const changeState = (marks: ChangeMarks, changeId: number): ChangeState =>
  marks.decided.get(changeId) ?? 'pending'

export const isFocused = (marks: ChangeMarks, changeId: number) =>
  isAttributed(changeId) && marks.focusedChangeId === changeId

/** The change a part names by its index into `ResourcePreview.actions`, if the index is valid. */
export const changeIdAt = (actions: readonly number[], index: number | undefined): number | undefined =>
  index === undefined || !Number.isInteger(index) ? undefined : actions[index]

/** The outline a focused change gets, wherever it is drawn. */
export const focusRing = (focused: boolean): CSSProperties => focused
  ? { outline: `2px solid ${colors.focus}`, outlineOffset: 2, borderRadius: 2 }
  : {}

/** The attributes every element standing for a change carries, and its click. */
export const changeAttributes = (marks: ChangeMarks, changeId: number) => isAttributed(changeId)
  ? {
      'data-change-id': changeId,
      'data-change-state': changeState(marks, changeId),
      onClick: () => marks.onChangeClick(changeId),
    }
  : { 'data-change-state': 'unattributed' }

/**
 * Attributes for an inline element standing for a change, which cannot be a <button> because it
 * sits within the file's own text: it is still a focusable button to keyboards and screen readers.
 */
export const inlineChangeProps = (marks: ChangeMarks, changeId: number, label: string | null) => ({
  ...changeAttributes(marks, changeId),
  ...(label === null || !isAttributed(changeId) ? {} : {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      marks.onChangeClick(changeId)
    },
  }),
})

/** A short accessible name for a change, from the text it puts in place. */
export function changeLabel(text: string, verb?: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const short = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
  return verb ? `Change: ${verb} ${short}` : `Change: ${short}`
}
