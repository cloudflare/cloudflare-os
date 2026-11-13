import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from 'motion/react'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'

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

/** Its size before it opens, and once it has closed: a dot at the top of the window. */
const DOT = 44
/** How long each alarm shakes the mascot before it settles into being sad. */
const SHAKE_FOR = 1800
/** How far up, in pixels, or how fast, in pixels a second, a swipe has to go to put it away. */
const SWIPE = { distance: 24, velocity: 300 }
// As the menus open: one spring, overshooting a little and settling.
const SPRING = { type: 'spring', visualDuration: 0.42, bounce: 0.2 } as const
const LEAVE = { duration: 0.28, ease: [0.4, 0, 1, 1] } as const
const INSTANT = { duration: 0 } as const

/**
 * Over the top of the window, in the middle: that the connection to the backend is being made
 * again, then that it is back. It opens out of a dot the way a menu opens out of its button, with
 * the mascot shaken by each alarm and then sad, and happy once the connection is back; then it
 * swipes away up. A swipe up puts it away sooner.
 */
export const ConnectionIsland = ({ state, onDismiss }: ConnectionIslandProps) => (
  <AnimatePresence>{state && <Island key="island" state={state} onDismiss={onDismiss} />}</AnimatePresence>
)

const Island = ({ state, onDismiss }: ConnectionIslandProps & { state: ConnectionIslandState }) => {
  const reduced = useReducedMotion()
  const emotion = useEmotion(state)

  const content = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: DOT, height: DOT })
  useLayoutEffect(() => {
    const element = content.current!
    const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const label = state.status === 'reconnected' ? 'Reconnected'
    : state.offline ? 'You’re offline'
      : state.long ? 'Can’t reach the server'
        : 'Reconnecting…'

  const endSwipe = (_event: PointerEvent, { offset, velocity }: PanInfo) => {
    if (offset.y < -SWIPE.distance || velocity.y < -SWIPE.velocity) onDismiss()
  }

  return (
    <motion.div
      role="status"
      // Focusable, so that it can be put away from the keyboard too.
      tabIndex={0}
      initial={{ width: DOT, height: DOT, y: -8, opacity: 0 }}
      animate={{ ...size, y: 0, opacity: 1 }}
      exit={{ y: -(size.height + 32), opacity: 0, transition: reduced ? INSTANT : LEAVE }}
      transition={reduced ? INSTANT : SPRING}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      // Up it follows the finger; down it barely gives.
      dragElastic={{ top: 1, bottom: 0.08 }}
      onDragEnd={endSwipe}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
      style={{ borderRadius: DOT / 2 + 2 }}
      className="pointer-events-auto relative cursor-grab touch-none overflow-hidden bg-kumo-contrast text-kumo-inverse shadow-2xl outline-none select-none focus-visible:ring-2 focus-visible:ring-kumo-focus active:cursor-grabbing"
    >
      {/* Laid out at its own size, in the middle, so the surface opens around it. */}
      <motion.div
        ref={content}
        initial={reduced ? false : { opacity: 0, scale: 0.5, filter: 'blur(3px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        transition={reduced ? INSTANT : { opacity: { duration: 0.16, delay: 0.07 }, filter: { duration: 0.2, delay: 0.05 }, scale: SPRING }}
        className="absolute top-0 left-1/2 flex h-11 w-max -translate-x-1/2 items-center gap-2.5 ps-3 pe-5 text-base font-medium"
      >
        {/* Its drawing has room around it: at 32px wide the cloud itself is some 25px tall. */}
        <Mascot emotion={emotion} color="inverse" className="-mx-0.5 w-8" />
        {/* Each wording blurs in over the last, as the surface grows or shrinks to it. */}
        <motion.span
          key={label}
          initial={reduced ? false : { opacity: 0, filter: 'blur(3px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.2 }}
        >
          {label}
        </motion.span>
      </motion.div>
    </motion.div>
  )
}

/** Shaken by each alarm, then sad; happy once the connection is back. */
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
  return settled === alarms ? 'sad' : 'error'
}
