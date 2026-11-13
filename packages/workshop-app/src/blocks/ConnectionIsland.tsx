import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { animate, AnimatePresence, motion, useMotionValue, usePresence, useReducedMotion, type MotionStyle, type PanInfo } from 'motion/react'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'
import { springCurve } from '@/components/springCurve'
import './ConnectionIsland.css'

export type ConnectionIslandState =
  | {
      status: 'reconnecting'
      /** Bumped for each fresh alarm: it coming up, or something that could not be done meanwhile. */
      alarms: number
      /** It has been a while: the server may be down rather than the connection dropped. */
      long: boolean
      /** The device has no network. */
      offline: boolean
    }
  | { status: 'reconnected' }

export type ConnectionIslandProps = {
  /** What there is to say; left out, it goes. */
  state?: ConnectionIslandState
  /** Put away by a swipe up, or by Escape. */
  onDismiss: () => void
}

/** The island's height (`h-11`). */
const HEIGHT = 44
/** How far above the island the point it opens out of is: placed at `top-4`, the window's top edge. */
const ORIGIN_ABOVE = 16
/** The mascot's width, and how far in from the surface's start it is (`w-8`, `ps-2.5`). */
const MASCOT = 32
const MASCOT_AT = 10
/** How long each alarm shakes the mascot before it settles. */
const SHAKE_FOR = 1800
/** How far up, in pixels, or how fast, in pixels a second, a swipe has to go to put it away. */
const SWIPE = { distance: 24, velocity: 300 }

/** How wide the bead it falls out of the top edge as is, before it spreads into the pill. */
const BEAD = 24
/**
 * How far, in pixels, it lands past its place as it falls out of the edge, and how far each side
 * spreads past where it settles, which set how deep each opening spring goes. The bottom squashes
 * up by half the spread meanwhile.
 */
const RECOIL = { drop: 5, spread: 6 }
// The menus' spring (`useMenuMorph`), peaking at the same point of its time: the fall first, then
// the spread, which lags it and takes a little longer. Closing into the edge has nothing to recoil
// past: it draws in across, then rises (the fall eases in, so it waits for the spread).
const DROP = { duration: 0.42, peak: 0.42 }
const SPREAD = { duration: 0.5, peak: 0.45 }
const CLOSE = { duration: 0.31, ease: [0.4, 0, 0.2, 1] } as const
const RISE = { duration: 0.31, ease: [0.55, 0, 1, 0.45] } as const
/** Swiped away, it carries on up at least this fast, in pixels a second, out of the window. */
const FLING = 900
// A wording's width is sprung to the way the menus' surfaces settle.
const RESIZE = { type: 'spring', visualDuration: 0.42, bounce: 0.2 } as const
// Pulled any way but up, it gives this much of the way, and springs back.
const GIVE = 0.15
const INSTANT = { duration: 0 } as const

/**
 * Over the top of the window, in the middle: that the connection to the backend is being made
 * again, then that it is back. It opens the way a menu does (`ConnectionIsland.css`): it falls
 * out of the top edge of the window as a bead and spreads into a pill, overshooting and settling,
 * its contents feathered at the moving edges, scaled up and brought into focus; and closes back
 * into the edge. The mascot is shaken by each
 * alarm, then thinks while it reconnects and is sad once it is offline or cannot reach the server,
 * and happy once the connection is back. A swipe up puts it away sooner; pulled any other way, it
 * gives a little and springs back.
 */
export const ConnectionIsland = ({ state, onDismiss }: ConnectionIslandProps) => (
  <AnimatePresence>{state && <Island key="island" state={state} onDismiss={onDismiss} />}</AnimatePresence>
)

const Island = ({ state, onDismiss }: ConnectionIslandProps & { state: ConnectionIslandState }) => {
  const reduced = useReducedMotion()
  const [present, safeToRemove] = usePresence()
  const emotion = useEmotion(state)
  // The clocks `ConnectionIsland.css` moves everything by: 0 is the bead in the edge, 1 open.
  const drop = useMotionValue(reduced ? 1 : 0)
  const open = useMotionValue(reduced ? 1 : 0)
  // Dragged, and swiped away: then it goes the way it was flung, not back into the edge.
  const y = useMotionValue(0)
  const flung = useRef<Promise<unknown>>(undefined)

  // As wide as its wording, springing from one to the next. The first wording it is measured at
  // sets how deep the spreading spring goes, so that its sides go RECOIL pixels past their place.
  const content = useRef<HTMLDivElement>(null)
  const width = useMotionValue(0)
  const [target, setTarget] = useState(0)
  useLayoutEffect(() => {
    const element = content.current!
    let first = true
    const measure = () => {
      const next = element.offsetWidth
      setTarget(next)
      if (first && !reduced && open.get() === 0) {
        // The bottom edge falls the furthest, `from-bottom`.
        animate(drop, 1, { duration: DROP.duration, ease: springCurve(RECOIL.drop / (HEIGHT + ORIGIN_ABOVE), DROP.peak) })
        // Past full size the sides move at twice the clock's rate, `from-x` each.
        animate(open, 1, { duration: SPREAD.duration, ease: springCurve(RECOIL.spread / Math.max(next - BEAD, 1), SPREAD.peak) })
      }
      if (first || reduced) width.jump(next)
      else animate(width, next, RESIZE)
      first = false
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [width, drop, open, reduced])

  // Gone, it closes back into the edge before it is removed, unless it was swiped away.
  useEffect(() => {
    if (present) return
    if (flung.current) return void flung.current.then(safeToRemove)
    if (reduced) return safeToRemove()
    const closing = [animate(open, 0, CLOSE), animate(drop, 0, RISE)]
    void Promise.all(closing).then(safeToRemove)
    return () => closing.forEach((animation) => animation.stop())
  }, [present, safeToRemove, drop, open, reduced])

  const label = state.status === 'reconnected' ? 'Reconnected'
    : state.offline ? 'You’re offline'
      : state.long ? 'Can’t reach the server'
        : 'Reconnecting…'

  const geometry = {
    '--island-from-x': `${(target - BEAD) / 2}px`,
    '--island-from-top': `${-ORIGIN_ABOVE}px`,
    '--island-from-bottom': `${HEIGHT + ORIGIN_ABOVE}px`,
    // The contents grow out of the mascot's middle.
    '--island-origin-x': `${MASCOT_AT + MASCOT / 2}px`,
    '--island-origin-y': `${HEIGHT / 2}px`,
  } as CSSProperties

  const endSwipe = (_event: PointerEvent, { offset, velocity }: PanInfo) => {
    if (offset.y >= -SWIPE.distance && velocity.y >= -SWIPE.velocity) return
    // Out of the window, shadow and all, rather than back to where it was held.
    flung.current = animate(y, -(ORIGIN_ABOVE + HEIGHT) * 3, {
      type: 'spring',
      velocity: Math.min(velocity.y, -FLING),
      bounce: 0,
      visualDuration: 0.3,
    }).then(() => undefined)
    onDismiss()
  }

  return (
    <motion.div
      role="status"
      // Focusable, so that it can be put away from the keyboard too.
      tabIndex={0}
      data-ending={!present || undefined}
      drag
      dragConstraints={{ top: 0, right: 0, bottom: 0, left: 0 }}
      // Up it follows the finger, to be put away; any other way it only gives a little.
      dragElastic={{ top: 1, right: GIVE, bottom: GIVE, left: GIVE }}
      onDragEnd={endSwipe}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
      style={{ width, y, '--island-drop': drop, '--island-open': open, ...geometry } as MotionStyle}
      className="connection-island group pointer-events-auto relative isolate h-11 cursor-grab touch-none outline-none select-none active:cursor-grabbing"
    >
      <div aria-hidden="true" className="connection-island-surface pointer-events-none absolute -z-10 bg-kumo-contrast group-focus-visible:ring-2 group-focus-visible:ring-kumo-focus">
        <div className="connection-island-shadow absolute inset-0 rounded-[inherit] shadow-2xl" />
      </div>
      <div className="connection-island-content absolute inset-0 text-kumo-inverse">
        {/*
          Laid out at its own size from the surface's start, with the mascot at its end: as the
          surface springs to another wording's width, the mascot moves only with its edge, and the
          wording is uncovered or covered by it.
        */}
        <div ref={content} className="connection-island-items absolute top-0 left-0 flex h-11 w-max items-center gap-2 ps-2.5 pe-5 text-base font-medium">
          {/* Its drawing has room around it: at 32px wide the cloud itself is some 25px tall. */}
          <Mascot emotion={emotion} color="inverse" className="w-8 shrink-0" />
          {/* Each wording blurs in over the last, in the same place, which leaves out of the way. */}
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={label}
              initial={reduced ? false : { opacity: 0, filter: 'blur(3px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(3px)' }}
              transition={reduced ? INSTANT : { duration: 0.2 }}
              className="whitespace-nowrap"
            >
              {label}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}

/**
 * Shaken by each alarm, then thinking while it reconnects, or sad once it is offline or cannot
 * reach the server; happy once the connection is back.
 */
const useEmotion = (state: ConnectionIslandState): MascotEmotion => {
  const alarms = state.status === 'reconnecting' ? state.alarms : undefined
  // The alarm it has settled down after.
  const [settled, setSettled] = useState<number>()
  useEffect(() => {
    if (alarms === undefined) return
    const timer = setTimeout(() => setSettled(alarms), SHAKE_FOR)
    return () => clearTimeout(timer)
  }, [alarms])
  if (state.status === 'reconnected') return 'happy'
  if (settled !== alarms) return 'error'
  return state.offline || state.long ? 'sad' : 'thinking'
}
