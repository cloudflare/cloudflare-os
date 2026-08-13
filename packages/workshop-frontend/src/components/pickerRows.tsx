// Shared look for the pickers that float over the chat composer: one surface, rows that carry their
// own padding, and a selection that reads as the thing Tab will act on.

export const PICKER_CAPTION =
  'text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-kumo-inactive'

export const PICKER_ROW =
  'flex cursor-pointer items-center gap-2.5 px-3.5 py-1.5 transition-colors hover:bg-kumo-tint'

/** The keyboard selection has to outrank hover, since Tab acts on it rather than on the pointer. */
export const PICKER_ROW_ACTIVE = 'bg-kumo-fill hover:bg-kumo-fill'

/** Loading, empty and error states, aligned to read as the list's first row. */
export const PICKER_EMPTY =
  'm-0 px-3.5 py-3 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle'

/** Names the key that acts on the selected row. Visual only: the row itself carries the semantics. */
export function TabHint() {
  return (
    <kbd
      aria-hidden="true"
      className="flex-shrink-0 rounded border border-kumo-line bg-kumo-base px-1 py-px font-sans text-[10px] font-medium leading-4 tracking-[0.02em] text-kumo-subtle"
    >
      Tab
    </kbd>
  )
}
