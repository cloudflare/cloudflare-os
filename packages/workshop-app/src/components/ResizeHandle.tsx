import { useEffect, useEffectEvent, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { BOUNCY, HELD_LENGTH, HELD_OPACITY, IDLE_LENGTH, IDLE_OPACITY, SMOOTH, between, useCalm } from './pill'
import { clampSize } from './resizing'

export type ResizeHandleProps = {
  'aria-label': string
  /** Where the divider stands and how far it can go, for assistive technology. */
  value: number
  min: number
  max: number
  /** The handle was taken hold of. */
  onDragStart: () => void
  /** The pointer is `offset` pixels to the right of where it took hold. */
  onDrag: (offset: number) => void
  /** The handle was let go. */
  onDragEnd: () => void
  /** An arrow key was pressed: -1 for left, 1 for right. */
  onStep: (direction: -1 | 1) => void
  /** A double click, which asks for the size things started at. */
  onReset: () => void
  /**
   * The divider is at this edge of everything, with nothing past it yet. It then comes out only
   * for a pointer that has reached the edge, not for one that is near: what is beside it has an
   * edge of its own to be used there, such as a scrollbar. Out, it is taken hold of anywhere from
   * the pill to the edge. The pill there is a fixture rather than something that follows the
   * pointer: it keeps to the middle of the gap, at one height.
   */
  edge?: 'left' | 'right'
  /** Brings the pill out for as long as it is set, to show that the handle is there. */
  hint?: boolean
  /** The pill has come out, for the pointer, focus or a hint, or is on its way back in. */
  onReach?: (reached: boolean) => void
}

// The pill is drawn in a box this tall that follows the pointer, and is centred in it at whatever
// height it has, so it grows and shrinks about the pointer.
const PILL_ROOM = 60
const PILL_MARGIN = 8
const ARRIVING_SCALE = 0.15
const LEAVING_SCALE = 0.01
// Kept while leaving, so it shrinks to a dot that fades rather than to nothing.
const LEAVING_HEIGHT = 6
// The height of the pill at the edge, where it does not answer to how near the pointer is.
const EDGE_HEIGHT = 40

type Point = { clientX: number; clientY: number }

const contains = (box: DOMRect, x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
// 1 with the pointer on the divider, 0 at the edge of where the pill shows.
const nearness = (box: DOMRect, x: number) => 1 - Math.min(1, Math.abs(x - (box.left + box.width / 2)) / (box.width / 2))

/**
 * The divider between two things set side by side, dragged to resize them. It is centred on its
 * parent, which is the gap between the two and has to be positioned. Nothing is drawn until the
 * pointer comes near: then a pill pops in and follows it along the gap, taller the closer it is,
 * and taller and darker again while held. It also takes focus, to be moved with the arrow keys.
 *
 * It only reports what is asked of it. Whoever places it owns the size, and its limits.
 */
export const ResizeHandle = ({ value, min, max, onDragStart, onDrag, onDragEnd, onStep, onReset, edge, hint = false, onReach, 'aria-label': label }: ResizeHandleProps) => {
  const reduceMotion = useReducedMotion()
  const atEdge = edge !== undefined
  const [shown, setShown] = useState(false)
  const [held, setHeld] = useState(false)
  // The strip along the gap within which the pill shows. The part that is dragged is narrower.
  const zone = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; from: number }>(undefined)
  const near = useRef(false)
  const focused = useRef(false)
  const hinted = useRef(false)
  const leaving = useRef(false)
  // What keeps the pill out with no pointer by it.
  const kept = () => focused.current || hinted.current

  const pointerX = useMotionValue(0)
  const pointerY = useMotionValue(0)
  const top = useMotionValue(PILL_MARGIN)
  const easedTop = useSpring(top, SMOOTH)
  const proximity = useMotionValue(0)
  const easedProximity = useSpring(proximity, SMOOTH)
  // 0 to 1 as it is taken hold of, the size it pops in and out by, and its fading as it leaves.
  const grip = useMotionValue(0)
  const scale = useMotionValue(ARRIVING_SCALE)
  const fade = useMotionValue(1)
  const floor = useMotionValue(0)
  const calm = useCalm(pointerX, pointerY)

  const height = useTransform(() => {
    const amount = (reduceMotion ? proximity : easedProximity).get()
    const idle = between(IDLE_LENGTH, amount)
    const full = atEdge ? EDGE_HEIGHT : idle + (between(HELD_LENGTH, amount) - idle) * grip.get()
    return Math.max(floor.get(), full * scale.get())
  })
  const opacity = useTransform(() => {
    const steadiness = reduceMotion ? 1 : calm.get()
    // The grip overshoots as it springs.
    return between([IDLE_OPACITY, HELD_OPACITY * steadiness], clampSize(grip.get(), 0, 1)) * fade.get()
  })

  const arrive = () => {
    leaving.current = false
    scale.stop()
    fade.stop()
    floor.jump(0)
    fade.jump(1)
    scale.jump(reduceMotion ? 1 : ARRIVING_SCALE)
    if (!reduceMotion) animate(scale, 1, BOUNCY)
    setShown(true)
    onReach?.(true)
  }

  const leave = () => {
    if (leaving.current) return
    leaving.current = true
    onReach?.(false)
    scale.stop()
    fade.stop()
    if (reduceMotion) return setShown(false)
    floor.jump(LEAVING_HEIGHT)
    animate(scale, LEAVING_SCALE, BOUNCY)
    animate(fade, 0, {
      duration: 0.25,
      ease: [0.23, 1, 0.32, 1],
      // Unless it was called back meanwhile.
      onComplete: () => {
        if (leaving.current) setShown(false)
      },
    })
  }

  const setGrip = (taken: boolean) => {
    grip.stop()
    if (reduceMotion) grip.jump(taken ? 1 : 0)
    else animate(grip, taken ? 1 : 0, taken ? BOUNCY : { type: 'spring', ...SMOOTH })
  }

  // Where the pill is when it keeps to the middle of the gap.
  const middle = (box: DOMRect | undefined) => ((box?.height ?? PILL_ROOM) - PILL_ROOM) / 2

  /**
   * Puts the pill beside the pointer, or at the edge leaves it in the middle. `at once` when it
   * was not following the pointer until now.
   */
  const follow = ({ clientX, clientY }: Point, box: DOMRect, atOnce = false) => {
    const next = atEdge
      ? middle(box)
      : clampSize(clientY - box.top - PILL_ROOM / 2, PILL_MARGIN, Math.max(PILL_MARGIN, box.height - PILL_ROOM - PILL_MARGIN))
    if (atOnce) {
      pointerX.jump(clientX)
      pointerY.jump(clientY)
      easedTop.jump(next)
    } else {
      pointerX.set(clientX)
      pointerY.set(clientY)
    }
    proximity.set(nearness(box, clientX))
    top.set(next)
  }

  const toMiddle = (atOnce: boolean) => {
    const to = middle(zone.current?.getBoundingClientRect())
    top.set(to)
    if (atOnce) easedTop.jump(to)
  }

  /** The pointer is not by the handle any more. */
  const part = () => {
    near.current = false
    if (kept()) return
    proximity.set(0)
    leave()
  }

  // The handle moves without the pointer doing so: springing back within its limits when let go,
  // or along with what it divides. While the pill is out for the pointer, it is checked every
  // frame that the pointer is still by it.
  const stillBeside = useEffectEvent(() => {
    if (drag.current || !near.current) return
    const box = zone.current?.getBoundingClientRect()
    if (!box || !contains(box, pointerX.get(), pointerY.get())) part()
  })
  useEffect(() => {
    if (!shown) return
    let frame = requestAnimationFrame(function check() {
      stillBeside()
      frame = requestAnimationFrame(check)
    })
    return () => cancelAnimationFrame(frame)
  }, [shown])

  // On the window, as the pill shows well before the pointer is over anything of the handle's.
  const pointerMoved = useEffectEvent((event: PointerEvent) => {
    const box = zone.current?.getBoundingClientRect()
    if (!box) return
    if (drag.current) {
      if (drag.current.pointerId === event.pointerId) follow(event, box)
      return
    }
    // A finger is only ever near while it holds the handle.
    if (event.pointerType === 'touch') return
    const inside = contains(box, event.clientX, event.clientY)
    const middleX = box.left + box.width / 2
    const reachedEdge = edge === 'right' ? event.clientX >= middleX - 1 : edge === 'left' ? event.clientX <= middleX + 1 : true
    if (inside && (near.current || reachedEdge)) {
      const arriving = !near.current
      near.current = true
      if (arriving && (leaving.current || !kept())) arrive()
      follow(event, box, arriving)
    } else if (near.current) {
      near.current = false
      if (!kept()) leave()
    }
  })
  const pointerLeftPage = useEffectEvent(() => {
    if (drag.current || !near.current) return
    near.current = false
    if (!kept()) leave()
  })
  const hintChanged = useEffectEvent((on: boolean) => {
    if (hinted.current === on) return
    hinted.current = on
    if (near.current || focused.current || drag.current) return
    if (!on) {
      proximity.set(0)
      return leave()
    }
    toMiddle(true)
    arrive()
  })
  useEffect(() => hintChanged(hint), [hint])
  // A pill that is out when the divider comes to be at the edge goes to the middle from where
  // the pointer had it.
  const edgeChanged = useEffectEvent(() => {
    if (atEdge) toMiddle(false)
  })
  useEffect(() => edgeChanged(), [edge])
  useEffect(() => {
    const page = document.documentElement
    window.addEventListener('pointermove', pointerMoved)
    page.addEventListener('pointerleave', pointerLeftPage)
    return () => {
      window.removeEventListener('pointermove', pointerMoved)
      page.removeEventListener('pointerleave', pointerLeftPage)
    }
  }, [])

  const take = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current || event.button !== 0) return
    // Nothing is selected, and no drag of the page's own starts, as the pointer moves on.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, from: event.clientX }
    const arriving = !near.current
    near.current = true
    if (arriving) arrive()
    follow(event, zone.current!.getBoundingClientRect(), arriving)
    setGrip(true)
    setHeld(true)
    onDragStart()
  }

  const letGo = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setGrip(false)
    setHeld(false)
    onDragEnd()
    // Nor is a finger that lifts, or a pointer that was taken away.
    if (event.pointerType === 'touch' || event.type === 'pointercancel') part()
  }

  return (
    <div ref={zone} className="pointer-events-none absolute inset-y-10 left-1/2 w-14 -translate-x-1/2">
      <div
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        className={cn(
          'absolute inset-y-0 touch-none outline-none',
          held ? 'cursor-grabbing' : 'cursor-grab',
          // At the edge it is in the way of nothing only once the pill is out.
          edge === 'right' && 'right-0 left-[calc(50%-0.5rem)]',
          edge === 'left' && 'right-[calc(50%-0.5rem)] left-0',
          !atEdge && 'left-1/2 w-4 -translate-x-1/2',
          atEdge && !shown ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        onPointerDown={take}
        onPointerMove={(event) => {
          if (drag.current?.pointerId === event.pointerId) onDrag(event.clientX - drag.current.from)
        }}
        onPointerUp={letGo}
        onPointerCancel={letGo}
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          onStep(event.key === 'ArrowLeft' ? -1 : 1)
        }}
        // From the keyboard only: the pill at its fullest is what shows where focus is.
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) return
          focused.current = true
          leaving.current = false
          scale.stop()
          fade.stop()
          floor.jump(0)
          scale.jump(1)
          fade.jump(1)
          proximity.set(1)
          if (!near.current) toMiddle(true)
          setShown(true)
          onReach?.(true)
        }}
        onBlur={() => {
          if (!focused.current) return
          focused.current = false
          if (near.current || drag.current || hinted.current) return
          proximity.set(0)
          leave()
        }}
      />
      {shown && (
        <motion.div
          aria-hidden="true"
          // Wider at the edge, where it is all there is to see of what it brings back.
          className={cn('absolute top-0 left-1/2 flex items-center transition-[width,margin] duration-200 motion-reduce:transition-none', atEdge ? '-ml-1 w-2' : '-ml-0.75 w-1.5')}
          style={{ y: reduceMotion ? top : easedTop, height: PILL_ROOM }}
        >
          <motion.div className="w-full rounded-full bg-kumo-contrast" style={{ height, opacity }} />
        </motion.div>
      )}
    </div>
  )
}
