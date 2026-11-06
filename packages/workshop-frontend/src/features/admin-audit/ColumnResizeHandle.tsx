import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

// Pixels one arrow key press moves the edge, and with Shift held.
const KEY_STEP = 16
const SHIFT_KEY_STEP = 64

/**
 * The right edge of a table column, dragged, or moved with the arrow keys (by more with Shift), to
 * resize it; a double click resets it. `onResize` gets each width reached, `done` once a drag ends
 * or a key moves it, so that only a settled width is stored; a cancelled drag puts back the width
 * it began from. Placed in a `Table.Head`, which Kumo makes `relative` and a hover group.
 *
 * Kumo's `Table.ResizeHandle` is only the visual: it fixes its own `aria-label` and classes, and it
 * is `invisible` until hovered, which takes it out of the tab order. This handle is reachable by
 * keyboard, named after its column, and shown while focused.
 */
export const ColumnResizeHandle = ({ column, width, onResize, onReset }: {
  /** The column's name, for the handle's accessible name. */
  column: string
  width: number
  onResize: (width: number, done: boolean) => void
  onReset: () => void
}) => {
  // Where a drag began and the width it began from; null while no drag is under way.
  const drag = useRef<{ x: number; width: number } | null>(null)

  const widthAt = (event: PointerEvent<HTMLButtonElement>) =>
    drag.current === null ? width : drag.current.width + event.clientX - drag.current.x

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    // Capture keeps the drag going while the pointer leaves the narrow handle.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { x: event.clientX, width }
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current !== null) onResize(widthAt(event), false)
  }
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current === null) return
    onResize(widthAt(event), true)
    drag.current = null
  }
  // A cancelled drag (the browser or the system taking the gesture over) may report any position,
  // 0 among them, so it puts back the width the drag began from, which is the one stored.
  const cancelDrag = () => {
    if (drag.current === null) return
    onResize(drag.current.width, false)
    drag.current = null
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? SHIFT_KEY_STEP : KEY_STEP
    if (event.key === 'ArrowLeft') onResize(width - step, true)
    else if (event.key === 'ArrowRight') onResize(width + step, true)
    else return
    event.preventDefault()
  }

  return (
    <button
      type="button"
      aria-label={`Resize the ${column} column`}
      title="Drag, or use the arrow keys, to resize. Double-click to reset."
      className="absolute top-0 right-0 flex h-full w-2.5 cursor-col-resize touch-none select-none items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span aria-hidden="true" className="h-5 w-0.5 rounded bg-kumo-hairline" />
    </button>
  )
}
