import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform, type Variants } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { ResizeHandle } from '@/components/ResizeHandle'
import { clampSize, resistSize, settleSize } from '@/components/resizing'
import { SplitLayout, type SplitLayoutProps } from './SplitLayout'
import { SCROLLBARS_AWAY, useScrollbarsAway } from './useScrollbarsAway'

/** How the sidebar rests: on the rail, or expanded at a width. */
export type SidebarSize = { collapsed: boolean; width: number }

export type AppShellProps = {
  /** The sidebar, drawn as a rail one button wide while it is `collapsed`. */
  sidebar: (collapsed: boolean) => ReactNode
  /** How the sidebar starts out, such as how it was left. Its width is kept within its limits. */
  initialSidebar?: SidebarSize
  /** The sidebar came to rest on the rail or at another width, to be kept for the next time. */
  onSidebarChange?: (size: SidebarSize) => void
  children: ReactNode
} & Pick<SplitLayoutProps, 'status' | 'aside' | 'asideAlone' | 'asideFullScreen' | 'onOpenAside' | 'onCloseAside' | 'initialAsideShare' | 'onAsideShareChange'>

// The sidebar's width expanded, in pixels. An arrow key moves it by a step.
const SIDEBAR = { min: 208, initial: 248, max: 400, step: 8 }
// Collapsed, it is a rail one button wide (36), with room around it (the rail's `px-2` in `Sidebar`).
const RAIL = 52
// Dragged narrower than midway between the rail and its narrowest expanded, the sidebar collapses
// to the rail, and dragged back past there it expands again.
const COLLAPSES_AT = (RAIL + SIDEBAR.min) / 2
const GAP = 12
// Over the rail, the handle's pill comes out only for a pointer in the gap or the rail's padding,
// not one on the rail's buttons. Over the page it reaches as far as ever.
const RAIL_REACH = { left: GAP / 2 + 4, right: 28 }
// The frame's own padding, which is the room past the gap at the window's edge.
const INSET = 8
// Between the rail and expanded, which is a jump in width when dragged across.
const SNAP_TIMING = { type: 'spring', duration: 0.3, bounce: 0.1 } as const
// Between the rail and expanded, what was in the sidebar goes before the other comes, rather than
// the two showing through each other: out quickly, then in, coming into focus as what arrives in
// a conversation does (`Arrival.css`). `instant` with nothing to see it.
const SWAP: Variants = {
  away: (instant: boolean) => instant
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, filter: 'blur(2px)', transition: { duration: 0.1, ease: 'easeIn' } },
  here: (instant: boolean) => instant
    ? { opacity: 1, filter: 'blur(0px)', transition: { duration: 0 } }
    : { opacity: 1, filter: 'blur(0px)', transition: { duration: 0.2, ease: 'easeOut' } },
}

/** One layout of what is in the sidebar, the rail or expanded, which stays for as long as going takes. */
const SidebarLayout = ({ instant, children }: { instant: boolean; children: ReactNode }) => {
  const isPresent = useIsPresent()
  const element = useRef<HTMLDivElement>(null)
  const width = useMotionValue<number | 'auto'>('auto')
  // Going, it keeps the width it had, rather than being laid out again as the sidebar changes
  // width under it. Measured before paint, from the commit that let it go.
  useLayoutEffect(() => {
    if (!isPresent) width.jump(element.current!.offsetWidth)
  }, [isPresent, width])

  return (
    <motion.div
      ref={element}
      custom={instant}
      variants={SWAP}
      initial="away"
      animate="here"
      exit="away"
      style={{ width }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {children}
    </motion.div>
  )
}

/**
 * The application frame: the sidebar, then the page and whatever is open beside it (see
 * `SplitLayout`). The gap after the sidebar is dragged to set its width (see `ResizeHandle`).
 *
 * Dragged well past its narrowest, the sidebar collapses to a rail of icons, and dragged out again
 * it expands. It is never put away entirely: the rail is the least of it. What fills the window
 * covers it instead (`asideFullScreen`).
 */
export const AppShell = ({
  sidebar, initialSidebar, onSidebarChange, status, children, aside, asideAlone, asideFullScreen = false, onOpenAside, onCloseAside, initialAsideShare, onAsideShareChange,
}: AppShellProps) => {
  const reduceMotion = useReducedMotion() ?? false
  const [start] = useState(() => ({
    collapsed: initialSidebar?.collapsed ?? false,
    width: clampSize(initialSidebar?.width ?? SIDEBAR.initial, SIDEBAR.min, SIDEBAR.max),
  }))
  const [collapsed, setCollapsed] = useState(start.collapsed)
  // The width expanded, where it rests: for assistive technology, and to expand to from the rail.
  // Not followed while it is dragged.
  const [rest, setRest] = useState(start.width)
  // Motion values, so that dragging renders nothing again: the width it is laid out at (the
  // rail's, collapsed), and what is left of a jump between the rail and expanded.
  const size = useMotionValue(start.collapsed ? RAIL : start.width)
  const snap = useMotionValue(0)
  const width = useTransform(() => size.get() + snap.get())
  // Clipped only while it is narrower than what is in it, which leaves focus rings alone otherwise.
  const overflow = useTransform(() => (snap.get() !== 0 ? 'hidden' : 'visible'))
  // The sidebar's width resizes the page beside it too.
  const frame = useRef<HTMLDivElement>(null)
  const scrollbars = useScrollbarsAway(frame)
  useMotionValueEvent(width, 'change', scrollbars.moved)
  // The drag under way: the width when the handle was taken hold of, and whether it is collapsed now.
  const drag = useRef({ from: 0, collapsed: false })

  /** Lays the sidebar out as the rail or expanded, `to` wide, springing there from where it is. */
  const relayout = (toCollapsed: boolean, to: number) => {
    const from = width.get()
    setCollapsed(toCollapsed)
    size.jump(to)
    snap.jump(from - to)
    if (reduceMotion) snap.jump(0)
    else animate(snap, 0, SNAP_TIMING)
  }
  const rested = (asCollapsed: boolean, at: number) => {
    setRest(at)
    onSidebarChange?.({ collapsed: asCollapsed, width: at })
  }
  /** Brings the sidebar to rest as it is now: on the rail, or within its limits expanded. */
  const settle = (asCollapsed: boolean) => {
    if (asCollapsed) {
      onSidebarChange?.({ collapsed: true, width: rest })
      return settleSize(size, RAIL, reduceMotion)
    }
    const to = clampSize(size.get(), SIDEBAR.min, SIDEBAR.max)
    rested(false, to)
    settleSize(size, to, reduceMotion)
  }

  const dragStart = () => {
    scrollbars.hold()
    const current = width.get()
    drag.current = { from: current, collapsed }
    size.jump(current)
    snap.jump(0)
  }

  const dragTo = (offset: number) => {
    const wanted = drag.current.from + offset
    const toCollapsed = wanted < COLLAPSES_AT
    const to = toCollapsed ? resistSize(wanted, RAIL, RAIL) : resistSize(wanted, SIDEBAR.min, SIDEBAR.max)
    if (toCollapsed === drag.current.collapsed) size.set(to)
    else {
      drag.current.collapsed = toCollapsed
      relayout(toCollapsed, to)
    }
  }

  const dragEnd = () => {
    scrollbars.release()
    settle(drag.current.collapsed)
  }

  const step = (direction: -1 | 1) => {
    if (collapsed) {
      if (direction === 1) {
        relayout(false, rest)
        onSidebarChange?.({ collapsed: false, width: rest })
      }
      return
    }
    const to = size.get() + direction * SIDEBAR.step
    if (to < SIDEBAR.min) {
      relayout(true, RAIL)
      onSidebarChange?.({ collapsed: true, width: rest })
      return
    }
    const clamped = clampSize(to, SIDEBAR.min, SIDEBAR.max)
    size.jump(clamped)
    rested(false, clamped)
  }

  // Expanded as it started out.
  const reset = () => {
    rested(false, SIDEBAR.initial)
    if (collapsed) relayout(false, SIDEBAR.initial)
    else settleSize(size, SIDEBAR.initial, reduceMotion)
  }

  return (
    <div ref={frame} className={cn('flex h-full p-2', SCROLLBARS_AWAY)}>
      <motion.aside style={{ width, overflow }} inert={asideFullScreen} className="flex shrink-0 justify-end">
        <motion.div style={{ width }} className="flex shrink-0 flex-col">
          <AnimatePresence mode="wait" initial={false} custom={reduceMotion}>
            <SidebarLayout key={collapsed ? 'rail' : 'expanded'} instant={reduceMotion}>
              {sidebar(collapsed)}
            </SidebarLayout>
          </AnimatePresence>
        </motion.div>
      </motion.aside>
      <div
        style={{ width: GAP }}
        inert={asideFullScreen}
        className="relative z-20 shrink-0"
        onPointerEnter={() => scrollbars.pointerInGap(true)}
        onPointerLeave={() => scrollbars.pointerInGap(false)}
      >
        <div className="absolute inset-y-0 left-1/2 w-0">
          <ResizeHandle
            aria-label="Resize sidebar"
            value={collapsed ? RAIL : Math.round(rest)}
            min={RAIL}
            max={SIDEBAR.max}
            onDragStart={dragStart}
            onDrag={dragTo}
            onDragEnd={dragEnd}
            onStep={step}
            onReset={reset}
            reach={collapsed ? RAIL_REACH : undefined}
          />
        </div>
      </div>
      {/* The inset is this frame's own padding. */}
      <SplitLayout
        aside={aside}
        status={status}
        asideAlone={asideAlone}
        asideFullScreen={asideFullScreen}
        onOpenAside={onOpenAside}
        onCloseAside={onCloseAside}
        initialAsideShare={initialAsideShare}
        onAsideShareChange={onAsideShareChange}
        edgeInset={INSET}
      >
        {children}
      </SplitLayout>
    </div>
  )
}
