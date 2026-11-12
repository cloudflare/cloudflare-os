import { useRef, useState, type ReactNode } from 'react'
import { motion, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { ResizeHandle } from '@/components/ResizeHandle'
import { clampSize, resistSize, settleSize } from '@/components/resizing'
import { SplitLayout } from './SplitLayout'
import { SCROLLBARS_AWAY, useScrollbarsAway } from './useScrollbarsAway'

export type AppShellProps = {
  sidebar: ReactNode
  children: ReactNode
  /** What is open beside the page, if anything. */
  aside?: ReactNode
  /** The aside fills the window (see `SplitLayout`). */
  asideFullScreen?: boolean
  /** Shows the aside, when none is showing (see `SplitLayout`). */
  onOpenAside?: () => void
  /** The aside was dragged shut (see `SplitLayout`). */
  onCloseAside?: () => void
}

// The sidebar's width, in pixels. An arrow key moves it by a step.
const SIDEBAR = { min: 208, initial: 248, max: 400, step: 8 }

/**
 * The application frame: the sidebar, then the page and whatever is open beside it (see
 * `SplitLayout`). The gap after the sidebar is dragged to set its width (see `ResizeHandle`).
 */
export const AppShell = ({ sidebar, children, aside, asideFullScreen = false, onOpenAside, onCloseAside }: AppShellProps) => {
  const reduceMotion = useReducedMotion() ?? false
  // A motion value, so that dragging renders nothing again.
  const width = useMotionValue(SIDEBAR.initial)
  // The width when the handle was taken hold of.
  const grabbed = useRef(SIDEBAR.initial)
  // Where the width rests, for assistive technology. Not followed while it is dragged.
  const [rest, setRest] = useState(SIDEBAR.initial)
  const settle = (to: number) => {
    setRest(to)
    settleSize(width, to, reduceMotion)
  }
  // The sidebar's width resizes the page beside it too.
  const frame = useRef<HTMLDivElement>(null)
  const scrollbars = useScrollbarsAway(frame)
  useMotionValueEvent(width, 'change', scrollbars.moved)

  return (
    <div ref={frame} className={cn('flex h-full p-2', SCROLLBARS_AWAY)}>
      <motion.aside style={{ width }} inert={asideFullScreen} className="flex shrink-0 flex-col">{sidebar}</motion.aside>
      <div
        inert={asideFullScreen}
        className="relative z-20 w-3 shrink-0"
        onPointerEnter={() => scrollbars.pointerInGap(true)}
        onPointerLeave={() => scrollbars.pointerInGap(false)}
      >
        <ResizeHandle
          aria-label="Resize sidebar"
          value={Math.round(rest)}
          min={SIDEBAR.min}
          max={SIDEBAR.max}
          onDragStart={() => {
            scrollbars.hold()
            width.stop()
            grabbed.current = width.get()
          }}
          onDrag={(offset) => width.set(resistSize(grabbed.current + offset, SIDEBAR.min, SIDEBAR.max))}
          onDragEnd={() => {
            scrollbars.release()
            settle(clampSize(width.get(), SIDEBAR.min, SIDEBAR.max))
          }}
          onStep={(direction) => {
            const to = clampSize(width.get() + direction * SIDEBAR.step, SIDEBAR.min, SIDEBAR.max)
            width.jump(to)
            setRest(to)
          }}
          onReset={() => settle(SIDEBAR.initial)}
        />
      </div>
      {/* The inset is this frame's own padding. */}
      <SplitLayout aside={aside} asideFullScreen={asideFullScreen} onOpenAside={onOpenAside} onCloseAside={onCloseAside} edgeInset={8}>{children}</SplitLayout>
    </div>
  )
}
