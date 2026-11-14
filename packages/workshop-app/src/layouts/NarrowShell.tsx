import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, usePresence, useReducedMotion, useTransform, type MotionValue } from 'motion/react'
import { SidebarSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { clampSize } from '@/components/resizing'
import { CLICK_SLOP, OPENING_TIMING } from './useEdgeHint'

export type NarrowShellProps = {
  /** The page. */
  children: ReactNode
  /** The sidebar, beneath the page, which moves aside to the far edge to show it. */
  sidebar?: {
    content: ReactNode
    /** The page is aside, showing the sidebar. */
    open: boolean
    onOpenChange: (open: boolean) => void
    /**
     * The page has a button at the start of its header that shows the sidebar: one the sidebar
     * goes to. A page further in has its own way up to one of those instead.
     */
    button: boolean
  }
  /** Said over the content, at the top of the window, without moving it (see `SplitLayout`). */
  status?: ReactNode
  /** What is open beside the page, which here covers it. */
  aside?: ReactNode
  /** Shows the aside, when none is showing: pulled out of the window's far edge, or tapped there. */
  onOpenAside?: () => void
  /** The aside was swiped away, back off the far edge. Left out, it only springs back. */
  onCloseAside?: () => void
}

// The room the sidebar's button takes at the start of a page's header: the button and the header's gap.
const BUTTON_ROOM = 36 + 6
// How much of the page stays in sight at the far edge with the sidebar out, to be tapped to put the
// sidebar away. The sidebar has the rest.
const PEEK = 64
// How far the page beneath moves aside, as a share of its width, as the aside comes over it.
const PARALLAX = 0.25
// Pulled or swiped further than this share of the window, the aside opens or goes when let go.
const COMMITS_AT = 0.3
// Let go moving faster than this, in pixels a millisecond, the aside goes the way it was flung.
const FLING = 0.4
// A sample of how fast a finger moves older than this is not how fast it was going when let go.
const STALE = 100
// The aside's surface, over all of the page, with an edge for while it is on its way.
const SURFACE = 'absolute inset-0 z-30 flex flex-col overflow-hidden bg-kumo-base ring-1 ring-kumo-line'

type EdgeSwipeProps = {
  /** Which edge it runs down. */
  side: 'left' | 'right'
  onStart: () => void
  /** The finger is `offset` pixels to the right of where it took hold. */
  onMove: (offset: number) => void
  /** Let go `offset` pixels to the right of where it took hold, moving right at `velocity` pixels a millisecond. */
  onEnd: (offset: number, velocity: number) => void
  /** Tapped, or pressed from the keyboard, rather than pulled. Given, the strip is a button by this name. */
  tap?: { label: string; onTap: () => void }
  children?: ReactNode
}

/**
 * A strip down an edge of the window to be swiped from, below the header so as not to be in the
 * way of the header's buttons. It only reports what is asked of it; whoever places it owns what
 * moves.
 */
const EdgeSwipe = ({ side, onStart, onMove, onEnd, tap, children }: EdgeSwipeProps) => {
  const drag = useRef<{ pointerId: number; from: number; x: number; at: number; velocity: number; moved: number }>(undefined)
  // Whether the last time it was taken hold of, it was pulled rather than tapped.
  const pulled = useRef(false)

  const take = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current || event.button !== 0) return
    // Nothing is selected, and no drag of the page's own starts, as the finger moves on.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, from: event.clientX, x: event.clientX, at: event.timeStamp, velocity: 0, moved: 0 }
    pulled.current = false
    onStart()
  }

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    const elapsed = event.timeStamp - current.at
    if (elapsed > 0) current.velocity = (event.clientX - current.x) / elapsed
    current.x = event.clientX
    current.at = event.timeStamp
    current.moved = Math.max(current.moved, Math.abs(event.clientX - current.from))
    onMove(event.clientX - current.from)
  }

  const letGo = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    drag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    pulled.current = current.moved >= CLICK_SLOP
    const velocity = event.type === 'pointercancel' || event.timeStamp - current.at > STALE ? 0 : current.velocity
    onEnd(current.x - current.from, velocity)
  }

  const shared = {
    onPointerDown: take,
    onPointerMove: move,
    onPointerUp: letGo,
    onPointerCancel: letGo,
    className: cn('group absolute top-16 bottom-0 z-40 w-4 touch-none outline-none', side === 'left' ? 'left-0' : 'right-0'),
  }

  return tap ? (
    <button
      type="button"
      aria-label={tap.label}
      onClick={() => {
        if (!pulled.current) tap.onTap()
      }}
      {...shared}
    >
      {children}
    </button>
  ) : (
    <div aria-hidden="true" {...shared}>{children}</div>
  )
}

/** The aside over the page, which stays for as long as going takes, and is swiped away from its near edge. */
const NarrowAside = ({ open, onClose, children }: {
  /** How far it has come over the page, 0 to 1. */
  open: MotionValue<number>
  onClose?: () => void
  children: ReactNode
}) => {
  const [isPresent, safeToRemove] = usePresence()
  const reduceMotion = useReducedMotion() ?? false
  const element = useRef<HTMLDivElement>(null)
  const x = useTransform(open, (amount) => `${(1 - amount) * 100}%`)
  const width = useRef(0)

  const gone = useEffectEvent(() => {
    if (!isPresent) safeToRemove?.()
  })
  // From however far over it is: it may have been pulled part of the way out of the edge, or
  // swiped part of the way back.
  useEffect(() => {
    const moving = animate(open, isPresent ? 1 : 0, { ...(reduceMotion ? { duration: 0 } : OPENING_TIMING), onComplete: gone })
    return () => moving.stop()
  }, [isPresent, reduceMotion, open])

  return (
    <motion.div ref={element} style={{ x }} className={SURFACE}>
      {children}
      {isPresent && (
        <EdgeSwipe
          side="left"
          onStart={() => {
            open.stop()
            width.current = element.current!.offsetWidth
          }}
          onMove={(offset) => open.set(clampSize(1 - offset / width.current, 0, 1))}
          onEnd={(_, velocity) => {
            const away = velocity > FLING || (velocity >= -FLING && 1 - open.get() > COMMITS_AT)
            if (away && onClose) return onClose()
            animate(open, 1, reduceMotion ? { duration: 0 } : OPENING_TIMING)
          }}
        />
      )}
    </motion.div>
  )
}

/**
 * The application frame on a narrow screen, such as a phone, which has room for one thing at a
 * time: the page, filling the window to its edges. The sidebar is beneath it: a button at the
 * start of the page's header moves the page aside to the far edge to show it. The page that stays
 * in sight is tapped to put the sidebar away again, and so is Escape.
 *
 * What is open beside the page on a wider screen comes over all of it here, from the far edge, as
 * the page moves a little aside beneath it. It is had back from that edge, as it is on a wider
 * screen: pulled out of it, which brings it as far as it is pulled, or tapped there, where a pill
 * shows. It goes by its own back button, or swiped back off the edge from its near one.
 */
export const NarrowShell = ({ children, sidebar, status, aside, onOpenAside, onCloseAside }: NarrowShellProps) => {
  const reduceMotion = useReducedMotion() ?? false
  const timing = reduceMotion ? { duration: 0 } : OPENING_TIMING
  const frame = useRef<HTMLDivElement>(null)
  const width = useRef(0)
  const shown = Boolean(aside)
  const sidebarOpen = sidebar?.open ?? false
  // How far the aside has come over the page, and how far the page has moved aside for the
  // sidebar, each 0 to 1. Motion values, so that pulling and moving render nothing again.
  const open = useMotionValue(shown ? 1 : 0)
  const away = useMotionValue(sidebarOpen ? 1 : 0)
  const asideX = useTransform(open, (amount) => `${(1 - amount) * 100}%`)
  const pageX = useTransform(() => `calc(${away.get()} * (100% - ${PEEK}px) - ${open.get() * PARALLAX * 100}%)`)
  const sidebarX = useTransform(away, (amount) => `${-(1 - amount) * PARALLAX * 100}%`)
  // Pulled out of the edge, or let go to open, until the aside arrives: until then its surface
  // comes out empty.
  const [pulled, setPulled] = useState(false)
  if (pulled && shown) setPulled(false)
  const lead = sidebar?.button ? ({ '--header-lead': `${BUTTON_ROOM}px` } as CSSProperties) : undefined

  useEffect(() => {
    const moving = animate(away, sidebarOpen ? 1 : 0, reduceMotion ? { duration: 0 } : OPENING_TIMING)
    return () => moving.stop()
  }, [sidebarOpen, away, reduceMotion])
  // Escape is for whatever has focus first, such as a menu that is open.
  const onOpenChange = sidebar?.onOpenChange
  useEffect(() => {
    if (!sidebarOpen || !onOpenChange) return
    const pressed = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onOpenChange(false)
    }
    window.addEventListener('keydown', pressed)
    return () => window.removeEventListener('keydown', pressed)
  }, [sidebarOpen, onOpenChange])


  return (
    // Clear of what the system draws over the window's edges, such as a phone's notch.
    <div className="h-full bg-kumo-base pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <div ref={frame} style={lead} className="relative size-full overflow-hidden">
        {sidebar && (
          // On the backdrop, as beside the page on a wider screen.
          <motion.div
            style={{ x: sidebarX, width: `calc(100% - ${PEEK}px)` }}
            inert={!sidebarOpen}
            className="absolute inset-y-0 left-0 flex flex-col bg-kumo-canvas px-2 py-1"
          >
            {sidebar.content}
          </motion.div>
        )}
        {/* Out of reach under the aside, and while the sidebar is out. Its own surface, with an
            edge, over the sidebar. */}
        <motion.div style={{ x: pageX }} inert={shown || sidebarOpen} className="absolute inset-0 flex flex-col bg-kumo-base ring-1 ring-kumo-line">
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          {sidebar?.button && (
            // Where the page's header starts, which leaves it the room (`--header-lead`).
            <div className="absolute top-3 left-3 z-20 flex">
              <HeaderBubble>
                <Button icon={SidebarSimpleIcon} aria-label="Show the sidebar" title="Sidebar" aria-expanded={sidebarOpen} onClick={() => sidebar.onOpenChange(true)} />
              </HeaderBubble>
            </div>
          )}
        </motion.div>
        {sidebarOpen && sidebar && (
          // What is in sight of the page, to be tapped to put the sidebar away; it is out of reach itself.
          <motion.button
            type="button"
            aria-label="Hide the sidebar"
            style={{ x: pageX }}
            onClick={() => sidebar.onOpenChange(false)}
            className="absolute inset-0 z-40 outline-none"
          />
        )}
        {!shown && !sidebarOpen && onOpenAside && (
          <EdgeSwipe
            side="right"
            tap={{ label: 'Show the side pane', onTap: onOpenAside }}
            onStart={() => {
              open.stop()
              width.current = frame.current!.clientWidth
              setPulled(true)
            }}
            onMove={(offset) => open.set(clampSize(-offset / width.current, 0, 1))}
            onEnd={(_, velocity) => {
              const opens = velocity < -FLING || (velocity <= FLING && open.get() > COMMITS_AT)
              if (!opens) return void animate(open, 0, { ...timing, onComplete: () => setPulled(false) })
              // The aside that arrives carries on from here.
              animate(open, 1, timing)
              onOpenAside()
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1/2 right-1 h-10 w-1 -translate-y-1/2 rounded-full bg-kumo-contrast opacity-25 transition-opacity group-focus-visible:opacity-70',
                pulled && 'opacity-0',
              )}
            />
          </EdgeSwipe>
        )}
        {!shown && pulled && <motion.div aria-hidden="true" style={{ x: asideX }} className={SURFACE} />}
        <AnimatePresence initial={false}>
          {shown ? <NarrowAside key="aside" open={open} onClose={onCloseAside}>{aside}</NarrowAside> : null}
        </AnimatePresence>
        {status && <div className="pointer-events-none absolute inset-x-0 top-2 z-50 flex justify-center">{status}</div>}
      </div>
    </div>
  )
}
