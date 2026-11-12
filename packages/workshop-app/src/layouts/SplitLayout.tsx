import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, usePresence, useReducedMotion, useTransform, type MotionValue } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { ResizeHandle } from '@/components/ResizeHandle'
import { clampSize, resistSize, settleSize } from '@/components/resizing'
import { SCROLLBARS_AWAY, useScrollbarsAway } from './useScrollbarsAway'

export type SplitLayoutProps = {
  /** The page. */
  children: ReactNode
  /** What is open beside the page, if anything. */
  aside?: ReactNode
  /** The aside fills the window, over the page and everything else. */
  asideFullScreen?: boolean
  /**
   * Shows the aside, when none is showing. The page's far edge then has a handle for it, which
   * comes out when the pointer reaches the edge, and for a moment after the aside is put away.
   */
  onOpenAside?: () => void
  /**
   * The divider was let go far past the aside's narrowest, which asks for the aside to be put
   * away. Left out, the aside only resists there.
   */
  onCloseAside?: () => void
  /**
   * How much room there is past the layout's far edge, in pixels, such as the padding of what it
   * is in. The handle at the edge is set midway between the page and the end of that room.
   */
  edgeInset?: number
}

const GAP = 12
// The gap held open at the page's far edge for the handle, with the aside away. Wider than the
// gap between the cards, so that the handle stands clear of the page.
const EDGE_GAP = 24
// Neither pane is dragged narrower than this, or than half the room when there is less than twice it.
const MIN_PANE_WIDTH = 320
const EVEN = 0.5
// What an arrow key moves the divider by, as a share of the room.
const STEP = 0.02
// Dragged narrower than this share of its narrowest, the aside closes when let go, and is dimmed
// by this much meanwhile to say so.
const CLOSES_AT = 0.6
const CLOSING_DIM = 0.6
// Pulled out of the edge by at least this many pixels, the aside opens when let go. A pointer that
// moved less than the slop between pressing and letting go only clicked, which opens it too.
const OPENS_AT = 48
const CLICK_SLOP = 4
// How long the edge's handle stays out after the aside is put away, counted from when it starts to go.
const HINT_TIME = 700
const PANE = 'flex min-w-0 basis-0 flex-col overflow-hidden rounded-3xl bg-kumo-base ring ring-kumo-line'
// The card's corners beside the page (`rounded-3xl`). Filling the window it has none, nor any
// room around it: its ring is then past the window's edges.
const CORNER = 24
const FULL_SCREEN_TIMING = { type: 'spring', duration: 0.4, bounce: 0.08 } as const
// The aside coming and going: setting off gently, rather than all at once.
const OPENING_TIMING = { type: 'spring', duration: 0.4, bounce: 0 } as const

/**
 * Where the card is from each edge of the window while it is out of its place, and how round its
 * corners are: filling the window, edge to edge, or on its way there or back. By the edges rather than a scale, so that what is in it
 * is laid out at each size on the way instead of stretched.
 */
const useFullScreen = (fullScreen: boolean, reduceMotion: boolean) => {
  const slot = useRef<HTMLDivElement>(null)
  const top = useMotionValue(0)
  const right = useMotionValue(0)
  const bottom = useMotionValue(0)
  const left = useMotionValue(0)
  const corner = useMotionValue(CORNER)
  const [lifted, setLifted] = useState(fullScreen)

  // Before paint, so the card is never seen anywhere but where it was and where it is going.
  useLayoutEffect(() => {
    const box = slot.current!.getBoundingClientRect()
    const inPlace = [box.top, window.innerWidth - box.right, window.innerHeight - box.bottom, box.left]
    const edges = [top, right, bottom, left, corner]
    if (fullScreen) {
      edges.forEach((edge, index) => edge.jump([...inPlace, CORNER][index]))
      setLifted(true)
    }
    const to = fullScreen ? edges.map(() => 0) : [...inPlace, CORNER]
    if (reduceMotion) {
      edges.forEach((edge, index) => edge.jump(to[index]))
      if (!fullScreen) setLifted(false)
      return
    }
    const moves = edges.map((edge, index) => animate(edge, to[index], FULL_SCREEN_TIMING))
    if (!fullScreen) void Promise.all(moves).then(() => setLifted(false))
    return () => moves.forEach((move) => move.stop())
  }, [fullScreen, reduceMotion, top, right, bottom, left, corner])

  return { slot, style: lifted ? { position: 'fixed' as const, top, right, bottom, left, borderRadius: corner, zIndex: 50 } : undefined }
}

/** The second card, which stays for as long as closing takes. */
const AsideCard = ({ share, open, dim, fullScreen, onGone, children }: {
  share: MotionValue<number>
  open: MotionValue<number>
  dim: MotionValue<number>
  fullScreen: boolean
  /** It has gone, all the way. */
  onGone: () => void
  children: ReactNode
}) => {
  const [isPresent, safeToRemove] = usePresence()
  const reduceMotion = useReducedMotion() ?? false
  const grow = useTransform(() => share.get() * open.get())
  // The card is there first, then what is in it: at a few pixels' width that would only be a smear.
  const cardOpacity = useTransform(() => clampSize(open.get() / 0.4, 0, 1) * (1 - CLOSING_DIM * dim.get()))
  const contentOpacity = useTransform(open, [0.4, 1], [0, 1])
  // Going, what is in it keeps the width it had, so it slides out under the edge rather than
  // being laid out again, narrower, at every step.
  const content = useRef<HTMLDivElement>(null)
  const contentWidth = useMotionValue<number | 'auto'>('auto')

  const closed = useEffectEvent(() => {
    if (isPresent) return
    onGone()
    safeToRemove?.()
  })
  // From however far open it is: it may have been pulled part of the way out of the edge.
  useEffect(() => {
    const to = isPresent ? 1 : 0
    // Shown again before it had gone, it is not about to close any more.
    if (isPresent) dim.jump(0)
    contentWidth.jump(isPresent ? 'auto' : content.current!.offsetWidth)
    if (reduceMotion) {
      open.jump(to)
      closed()
      return
    }
    const opening = animate(open, to, { ...OPENING_TIMING, onComplete: closed })
    return () => opening.stop()
  }, [isPresent, reduceMotion, open, dim, contentWidth])

  const lift = useFullScreen(fullScreen, reduceMotion)

  return (
    // Its place beside the page, which it keeps while it fills the window, to go back to. Faded
    // in, for when it arrives into room that was pulled open for it.
    <motion.div ref={lift.slot} style={{ flexGrow: grow, opacity: cardOpacity }} className="appears flex min-w-0 basis-0 flex-col">
      <motion.div style={lift.style} className={cn(PANE, 'flex-1')}>
        <motion.div ref={content} style={{ opacity: contentOpacity, width: contentWidth }} className="flex min-h-0 flex-1 flex-col">{children}</motion.div>
      </motion.div>
    </motion.div>
  )
}

/**
 * The page as a card, and beside it a second card for whatever is open there. The second grows
 * in from the side as the page makes room, and goes the same way. The gap between the two is
 * dragged to divide the room between them (see `ResizeHandle`); the division is kept for the next
 * time. Dragged well past the second card's narrowest, the card dims, and closes when let go.
 *
 * An aside that was put away can be had back from the page's far edge. The pointer reaching the
 * edge moves the page in a little and brings a handle out there, as putting the aside away does
 * for a moment, to show where it went. Clicking the handle opens the aside, and so does pulling
 * it out.
 */
export const SplitLayout = ({ children, aside, asideFullScreen = false, onOpenAside, onCloseAside, edgeInset = 0 }: SplitLayoutProps) => {
  const reduceMotion = useReducedMotion() ?? false
  const root = useRef<HTMLDivElement>(null)
  const shown = Boolean(aside)
  // The aside's share of the room the two cards have between them, how far open it is, and how
  // far the gap is held open at the edge with the aside away, each 0 to 1. Motion values, so that
  // neither dragging nor opening renders the page again.
  const share = useMotionValue(EVEN)
  const open = useMotionValue(shown ? 1 : 0)
  const peek = useMotionValue(0)
  const pageGrow = useTransform(() => 1 - share.get() * open.get())
  // The edge's gap becomes the gap between the cards as the aside opens.
  const gap = useTransform(() => EDGE_GAP * peek.get() * (1 - open.get()) + GAP * open.get())
  // The handle is in the middle of the gap between the cards. At the edge it is as far from the
  // page as from the end of the room past the layout, which is past the middle of the gap by
  // half that room.
  const handleShift = useTransform(open, (amount) => ((1 - amount) * edgeInset) / 2)
  // Whatever resizes the cards: dragging the divider, the aside coming or going, the edge's gap.
  // By what is laid out, since not all that goes on moves anything: the pointer coming near
  // the divider between two cards does not.
  const scrollbars = useScrollbarsAway(root)
  useMotionValueEvent(pageGrow, 'change', scrollbars.moved)
  useMotionValueEvent(gap, 'change', scrollbars.moved)
  // How far the aside has dimmed, and whether letting go of the handle now would close it.
  const dim = useMotionValue(0)
  const closes = useRef(false)
  // Where the divider rests, for assistive technology. Not followed while it is dragged.
  const [rest, setRest] = useState(EVEN)
  // The drag under way: the aside's width and share when the handle was taken hold of, whether
  // that was at the edge with the aside away, and the furthest the pointer has been from there.
  const drag = useRef({ width: 0, share: EVEN, opening: false, moved: 0 })
  const openedAt = useRef(0)
  // The share the aside had before it was dragged shut: it goes at the width it was dragged to,
  // and has this again once it has gone, or as soon as it is back.
  const reopensAt = useRef<number>(undefined)
  const reopened = () => {
    if (reopensAt.current === undefined) return
    share.jump(reopensAt.current)
    reopensAt.current = undefined
  }

  // The handle is shown at the edge for a moment after the aside is put away.
  const [wasShown, setWasShown] = useState(shown)
  const [hinting, setHinting] = useState(false)
  if (wasShown !== shown) {
    setWasShown(shown)
    setHinting(!shown)
  }
  useEffect(() => {
    if (!hinting) return
    const timer = setTimeout(() => setHinting(false), HINT_TIME)
    return () => clearTimeout(timer)
  }, [hinting])

  /** The room the two cards have between them, and the aside's limits within it. */
  const room = () => {
    const width = root.current!.clientWidth - GAP
    const min = Math.min(MIN_PANE_WIDTH, width / 2)
    return { width, min, max: width - min }
  }
  const within = (wanted: number) => {
    const { width, min, max } = room()
    return clampSize(wanted * width, min, max) / width
  }
  const settle = (to: number) => {
    setRest(to)
    settleSize(share, to, reduceMotion)
  }
  const setCloses = (value: boolean) => {
    if (closes.current === value) return
    closes.current = value
    if (reduceMotion) dim.jump(value ? 1 : 0)
    else animate(dim, value ? 1 : 0, { duration: 0.15 })
  }

  const dragTo = (offset: number) => {
    const { width, min, max } = room()
    const wanted = drag.current.width - offset
    drag.current.moved = Math.max(drag.current.moved, Math.abs(offset))
    if (!drag.current.opening) {
      share.set(resistSize(wanted, min, max) / width)
      setCloses(onCloseAside !== undefined && wanted < min * CLOSES_AT)
      return
    }
    // Pulled out of the edge, room opens as far as it is pulled: up to the width the aside had,
    // and wider from there.
    open.set(clampSize(wanted / (drag.current.share * width), 0, 1))
    share.set(Math.max(drag.current.share, resistSize(wanted, min, max) / width))
  }

  const dragEnd = () => {
    scrollbars.release()
    const { opening, moved } = drag.current
    if (opening) {
      const pulled = open.get() * share.get() * room().width
      if (moved >= CLICK_SLOP && pulled < OPENS_AT) return settleSize(open, 0, reduceMotion)
      // The card that arrives carries on opening from here.
      openedAt.current = performance.now()
      onOpenAside?.()
      return settle(within(share.get()))
    }
    if (!closes.current) return settle(within(share.get()))
    // It goes as it is, dimmed, and is as wide the next time as before it was dragged shut.
    closes.current = false
    reopensAt.current = within(drag.current.share)
    setRest(reopensAt.current)
    onCloseAside?.()
  }

  // Back before it had gone.
  useEffect(() => {
    if (!shown || reopensAt.current === undefined) return
    settleSize(share, reopensAt.current, reduceMotion)
    reopensAt.current = undefined
  }, [shown, share, reduceMotion])

  return (
    <div ref={root} className={cn('flex min-w-0 flex-1', SCROLLBARS_AWAY)}>
      {/* Out of reach under an aside that fills the window. */}
      <motion.main style={{ flexGrow: pageGrow }} inert={asideFullScreen} className={PANE}>{children}</motion.main>
      <motion.div
        style={{ width: gap }}
        inert={asideFullScreen}
        className="relative z-20 shrink-0"
        onPointerEnter={() => scrollbars.pointerInGap(true)}
        onPointerLeave={() => scrollbars.pointerInGap(false)}
      >
        <motion.div style={{ x: handleShift }} className="absolute inset-y-0 left-1/2 w-0">
          {(shown || onOpenAside) && (
            <ResizeHandle
              aria-label="Resize panes"
              // The divider's place, as the page's share of the room.
              value={shown ? Math.round((1 - rest) * 100) : 100}
              min={0}
              max={100}
              edge={!shown}
              hint={hinting}
              // With the aside open, holding the edge's gap open changes nothing that is seen.
              onReach={(reached) => settleSize(peek, reached ? 1 : 0, reduceMotion || (reached && open.get() >= 1))}
              onDragStart={() => {
                scrollbars.hold()
                share.stop()
                open.stop()
                drag.current = { width: shown ? share.get() * room().width : 0, share: share.get(), opening: !shown, moved: 0 }
              }}
              onDrag={dragTo}
              onDragEnd={dragEnd}
              onStep={(direction) => {
                if (!shown) {
                  if (direction === -1) onOpenAside?.()
                  return
                }
                const to = within(share.get() - direction * STEP)
                share.jump(to)
                setRest(to)
              }}
              // Not by the second click of two that opened it.
              onReset={() => {
                if (shown && performance.now() - openedAt.current > 500) settle(EVEN)
              }}
            />
          )}
        </motion.div>
      </motion.div>
      <AnimatePresence initial={false}>
        {shown ? <AsideCard key="aside" share={share} open={open} dim={dim} fullScreen={asideFullScreen} onGone={reopened}>{aside}</AsideCard> : null}
      </AnimatePresence>
    </div>
  )
}
