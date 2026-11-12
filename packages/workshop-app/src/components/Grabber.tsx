import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { BOUNCY, HELD_LENGTH, HELD_OPACITY, IDLE_LENGTH, IDLE_OPACITY, SMOOTH, between, useCalm } from './pill'
import { clampSize } from './resizing'

export type GrabberProps = {
  /** What it does: "Hide the header". */
  'aria-label': string
  /** Whether what it pulls is out, for assistive technology. */
  expanded: boolean
  onDragStart: () => void
  /** The pointer is `offset` pixels below where it took hold. */
  onDrag: (offset: number) => void
  /** Let go after dragging, `offset` pixels below where it took hold. */
  onDragEnd: (offset: number) => void
  /** Clicked, or pressed from the keyboard, rather than dragged. */
  onToggle: () => void
  className?: string
}

// A pointer that moved less than this between pressing and letting go only clicked.
const CLICK_SLOP = 4
// Its bar pointed at, between how it is at rest and held.
const HOVER_LENGTH = 44
const HOVER_OPACITY = 0.4

/**
 * A small bar to pull something down by, or push it back up: as a sheet has. Clicking it does the
 * same in one go. The handle only reports what is asked of it; whoever places it moves things.
 *
 * Its bar is the divider's pill (`ResizeHandle`), always out and staying put: it grows a little
 * and strengthens when pointed at, springs longer and stronger when taken hold of, and lightens
 * while dragged fast. Focused from the keyboard, it is as if held.
 */
export const Grabber = ({ 'aria-label': label, expanded, onDragStart, onDrag, onDragEnd, onToggle, className }: GrabberProps) => {
  const drag = useRef<{ pointerId: number; from: number; moved: boolean }>(undefined)
  // Set when a drag ends, for the click that follows letting go.
  const dragged = useRef(false)
  const focused = useRef(false)

  const reduceMotion = useReducedMotion()
  const pointerX = useMotionValue(0)
  const pointerY = useMotionValue(0)
  // 0 to 1 as it is taken hold of.
  const grip = useMotionValue(0)
  // 0 to 1 as it is pointed at.
  const hover = useMotionValue(0)
  const calm = useCalm(pointerX, pointerY)
  // As the divider's pill with the pointer on it: the nearest it can be.
  const width = useTransform(() => {
    const idle = between([IDLE_LENGTH[1], HOVER_LENGTH], hover.get())
    return idle + (HELD_LENGTH[1] - idle) * grip.get()
  })
  const opacity = useTransform(() => {
    const steadiness = reduceMotion ? 1 : calm.get()
    // The grip overshoots as it springs.
    return between([between([IDLE_OPACITY, HOVER_OPACITY], hover.get()), HELD_OPACITY * steadiness], clampSize(grip.get(), 0, 1))
  })
  const setGrip = (taken: boolean) => {
    grip.stop()
    if (reduceMotion) grip.jump(taken ? 1 : 0)
    else animate(grip, taken ? 1 : 0, taken ? BOUNCY : { type: 'spring', ...SMOOTH })
  }

  const point = (at: boolean) => {
    hover.stop()
    if (reduceMotion) hover.jump(at ? 1 : 0)
    else animate(hover, at ? 1 : 0, { type: 'spring', ...SMOOTH })
  }

  const take = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerX.jump(event.clientX)
    pointerY.jump(event.clientY)
    drag.current = { pointerId: event.pointerId, from: event.clientY, moved: false }
    setGrip(true)
  }
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const held = drag.current
    if (held?.pointerId !== event.pointerId) return
    pointerX.set(event.clientX)
    pointerY.set(event.clientY)
    const offset = event.clientY - held.from
    if (!held.moved) {
      if (Math.abs(offset) < CLICK_SLOP) return
      held.moved = true
      onDragStart()
    }
    onDrag(offset)
  }
  const letGo = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const held = drag.current
    if (held?.pointerId !== event.pointerId) return
    drag.current = undefined
    dragged.current = held.moved
    if (!focused.current) setGrip(false)
    if (held.moved) onDragEnd(event.clientY - held.from)
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      className={cn(
        'relative h-4 w-12 cursor-grab touch-none outline-none active:cursor-grabbing',
        className,
      )}
      onPointerDown={take}
      onPointerMove={move}
      onPointerUp={letGo}
      onPointerCancel={letGo}
      // A mouse's only: a touch would leave it grown.
      onPointerEnter={(event) => event.pointerType === 'mouse' && point(true)}
      onPointerLeave={(event) => event.pointerType === 'mouse' && point(false)}
      onFocus={(event) => {
        if (!event.currentTarget.matches(':focus-visible')) return
        focused.current = true
        setGrip(true)
      }}
      onBlur={() => {
        if (!focused.current) return
        focused.current = false
        if (!drag.current) setGrip(false)
      }}
      onClick={() => {
        if (dragged.current) dragged.current = false
        else onToggle()
      }}
    >
      {/* Frosted, and over that what is behind it, blurred, made grey, inverted and pushed towards
          black or white: dark over what is light, light over what is dark, leaning to dark for
          greys, and shading from one to the other where what is behind it does. Side by side, as
          one with a backdrop filter of its own would see nothing behind the other. It grows about
          its middle, out past the button's sides when held. */}
      <motion.span style={{ width }} className="absolute top-1/2 left-1/2 h-1.5 -translate-1/2">
        <span className="absolute inset-0 rounded-full backdrop-blur-sm" />
        <motion.span style={{ opacity }} className="absolute inset-0 rounded-full [backdrop-filter:blur(8px)_grayscale(1)_brightness(1.25)_contrast(3)_invert(1)]" />
      </motion.span>
    </button>
  )
}
