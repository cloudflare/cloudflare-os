import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Popover } from '@cloudflare/kumo/primitives/popover'

export type HoverCardProps = {
  /** The trigger is a `<button>` rather than a link. */
  nativeButton?: boolean
  /**
   * What is pointed at, drawn as it is, such as a link: clicking it does what it does, and does not
   * open the card.
   */
  trigger: ReactElement
  /** What the card is of, for whatever reads it out. */
  'aria-label': string
  /** What it holds. As a function, it is given the way to close it, for what in it goes somewhere. */
  children: ReactNode | ((close: () => void) => ReactNode)
  side?: 'right' | 'bottom'
}

// Long enough that a pointer only passing over opens nothing, and room to reach the card.
const OPEN_DELAY = 250
const CLOSE_DELAY = 200

/**
 * A card beside what it is of, opened by pointing at it for a moment, or with the arrow key away
 * from it, which goes into it, rather than by clicking, which is left to the trigger. It goes as
 * the pointer leaves both, or with Escape.
 */
export const HoverCard = ({ trigger, 'aria-label': label, children, side = 'right', nativeButton = false }: HoverCardProps) => {
  const [open, setOpen] = useState(false)
  // Opened from the keyboard, so that the focus goes into it; pointed at, it stays where it is.
  const fromKey = useRef(false)
  const close = () => setOpen(false)
  const opensKey = side === 'right' ? 'ArrowRight' : 'ArrowDown'

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, { reason }) => {
        // A click is the trigger's own, and coming to it by Tab is only passing through.
        if (reason === 'trigger-press' || reason === 'trigger-focus') return
        if (next) fromKey.current = false
        setOpen(next)
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={OPEN_DELAY}
        closeDelay={CLOSE_DELAY}
        render={trigger}
        // Drawn as a link as often as a button.
        nativeButton={nativeButton}
        onKeyDown={(event) => {
          if (event.key !== opensKey) return
          event.preventDefault()
          fromKey.current = true
          setOpen(true)
        }}
      />
      <Popover.Portal>
        <Popover.Positioner side={side} sideOffset={10} collisionPadding={12} className="z-50">
          <Popover.Popup
            aria-label={label}
            initialFocus={() => fromKey.current}
            className="max-h-[min(var(--available-height),28rem)] w-72 max-w-(--available-width) origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-[21px] bg-kumo-base p-1.5 text-kumo-default ring-1 ring-kumo-contrast/6 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            {typeof children === 'function' ? children(close) : children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
