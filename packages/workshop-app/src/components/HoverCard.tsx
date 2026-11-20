import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Popover } from '@cloudflare/kumo/primitives/popover'
import { cn } from '@cloudflare/kumo/utils'

export type HoverCardProps = {
  /** The trigger is a `<button>` rather than a link. */
  nativeButton?: boolean
  /**
   * What is pointed at, drawn as it is, such as a link: clicking it does what it does, and closes
   * the card.
   */
  trigger: ReactElement
  /** What the card is of, for whatever reads it out. */
  'aria-label': string
  /** What it holds. As a function, it is given the way to close it, for what in it goes somewhere. */
  children: ReactNode | ((close: () => void) => ReactNode)
  side?: 'right' | 'bottom'
}

// Room to reach the card.
const CLOSE_DELAY = 200
// Pointed at this soon after another closed, it takes its place, as moving from one to the next does.
const WARM = 300

// The one card open, of all of them, which another opening closes, at once; and when the last one closed.
let openOne: ((instant: boolean) => void) | undefined
let closedAt = 0

/** Closes whichever card is open, as pointing at something with a tooltip instead does. */
export const closeHoverCards = () => openOne?.(false)

/** Whether a card is open, which what answers to the pointer nearby, such as a divider's pill, gives way to. */
export const isHoverCardOpen = () => openOne !== undefined

/**
 * A card beside what it is of, opened as soon as it is pointed at, or with the arrow key away from
 * it, which goes into it, rather than by clicking, which is left to the trigger. Only one is open at
 * a time: with one open, or just closed, pointing at another swaps them with no animation, which is
 * only for the first. It goes as the pointer leaves both, or with Escape.
 */
export const HoverCard = ({ trigger, 'aria-label': label, children, side = 'right', nativeButton = false }: HoverCardProps) => {
  const [open, setOpen] = useState(false)
  // Swapped for another, in or out, with no animation.
  const [instant, setInstant] = useState(false)
  // Opened from the keyboard, so that the focus goes into it; pointed at, it stays where it is.
  const fromKey = useRef(false)
  const closeThis = useRef((now: boolean) => {
    setInstant(now)
    setOpen(false)
  })
  const close = () => setOpen(false)
  const show = () => {
    const swapping = openOne !== undefined && openOne !== closeThis.current
    if (swapping) openOne?.(true)
    setInstant(swapping || performance.now() - closedAt < WARM)
    setOpen(true)
  }
  const opensKey = side === 'right' ? 'ArrowRight' : 'ArrowDown'

  useEffect(() => {
    const mine = closeThis.current
    if (open) {
      if (openOne !== mine) openOne?.(true)
      openOne = mine
      return
    }
    if (openOne === mine) {
      openOne = undefined
      closedAt = performance.now()
    }
  }, [open])
  useEffect(() => () => {
    if (openOne === closeThis.current) openOne = undefined
  }, [])

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, { reason }) => {
        // Coming to it by Tab is only passing through.
        if (reason === 'trigger-focus') return
        // A click is the trigger's own, which goes somewhere: the card has done its part.
        if (reason === 'trigger-press') {
          setOpen(false)
          return
        }
        if (!next) return setOpen(false)
        fromKey.current = false
        show()
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={0}
        closeDelay={CLOSE_DELAY}
        render={trigger}
        // Drawn as a link as often as a button.
        nativeButton={nativeButton}
        onKeyDown={(event) => {
          if (event.key !== opensKey) return
          event.preventDefault()
          fromKey.current = true
          show()
        }}
      />
      <Popover.Portal>
        <Popover.Positioner side={side} sideOffset={10} collisionPadding={12} className="z-50">
          <Popover.Popup
            aria-label={label}
            initialFocus={() => fromKey.current}
            className={cn(instant && 'transition-none!', 'max-h-[min(var(--available-height),24rem)] w-60 max-w-(--available-width) origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-[18px] bg-kumo-base p-1 text-kumo-default ring-1 ring-kumo-contrast/6 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none')}
          >
            {typeof children === 'function' ? children(close) : children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
