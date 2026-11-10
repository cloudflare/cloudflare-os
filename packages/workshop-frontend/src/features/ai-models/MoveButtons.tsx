import { Button } from '@cloudflare/kumo'
import { ArrowDown, ArrowUp } from '@phosphor-icons/react'

/** Selects the element holding one row's move buttons, so focus can pass from one to the other. */
export const MOVE_BUTTONS_SELECTOR = '[data-move-buttons]'

/** Where a row of an ordered list can move: a direction is absent at the end the row is at. */
export type RowMove = { onUp?: () => void; onDown?: () => void }

/** The moves of `list[index]`, each handing `onOrderChange` the whole list in its new order. */
export const rowMove = <T,>(
  list: readonly T[],
  index: number,
  onOrderChange: (order: T[]) => void,
): RowMove => {
  const swapped = (other: number) => () => {
    const order = [...list]
    ;[order[index], order[other]] = [order[other]!, order[index]!]
    onOrderChange(order)
  }
  return {
    ...(index > 0 && { onUp: swapped(index - 1) }),
    ...(index < list.length - 1 && { onDown: swapped(index + 1) }),
  }
}

/** Buttons that move the row of `name` up or down its list. */
export const MoveButtons = ({ name, move, busy }: {
  name: string
  move: RowMove
  /** Whether the buttons are locked, because a write is in flight. */
  busy: boolean
}) => (
  <div className="flex shrink-0 items-center gap-1" data-move-buttons="">
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      icon={ArrowUp}
      aria-label={`Move ${name} up`}
      disabled={busy || !move.onUp}
      onClick={move.onUp}
    />
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      icon={ArrowDown}
      aria-label={`Move ${name} down`}
      disabled={busy || !move.onDown}
      onClick={move.onDown}
    />
  </div>
)
