import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { animate, useMotionValue } from 'motion/react'
import { publishHeight, useReducedMotion } from '@gadgets/ui'
import { OPENING_TIMING } from './useEdgeHint'

// The column at the end, open, is 19rem wide: a 17rem card, 0.75rem in from the edge (the header's
// padding), with room before it. The conversation is no narrower than it is worth making room for
// it beside. All in rem.
const SIDE = 19
const MIN_COLUMN = 28

const remOf = (root: HTMLElement) => Number.parseFloat(getComputedStyle(root).fontSize)

/** Whether `root` is too narrow to make room beside the conversation for the column at the end. */
const tooNarrow = (root: HTMLElement) => root.clientWidth < (SIDE + MIN_COLUMN) * remOf(root)

export type ChatLayoutProps = {
  header?: ReactNode
  /**
   * At the far end of the header's line, such as the button for what the chat has. As a function, it
   * is told whether the column at the end has room beside the messages (`side`) or what it opens
   * floats over them, for where there is not. It takes the pointer itself, as the header's gaps let it through.
   */
  headerEnd?: ReactNode | ((room: 'beside' | 'floating') => ReactNode)
  /**
   * A column at the end, beside the messages and the composer, under the header's end, where there
   * is room for it. It is drawn only while it is open and as it opens or closes, which it does by
   * taking its room from the conversation, which stays centred in what is left.
   */
  side?: ReactNode
  sideOpen?: boolean
  composer: ReactNode
  /** The message list, which owns its scrolling. */
  children?: ReactNode
}

/**
 * A conversation screen: the messages scroll the full height, with the header and the composer
 * floating over them, unfilled. Messages and composer share one centered column, so wide screens
 * keep a readable line length. An open column at the end takes its width from it, as a second
 * column beside it, over the end of the page the conversation keeps clear.
 */
export const ChatLayout = ({ header, headerEnd, side, sideOpen = false, composer, children }: ChatLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // Whether there is room for the column at the end beside the conversation, measured before it is drawn.
  const [room, setRoom] = useState<'floating' | 'beside'>('floating')
  // Drawn while it has any width, so that what it holds is not made while it is shut.
  const [sideShown, setSideShown] = useState(false)
  const end = typeof headerEnd === 'function' ? headerEnd(room) : headerEnd
  const hasHeader = Boolean(header || end)
  const hasSide = Boolean(side)

  // The bars are out of flow, so their heights are measured to keep the messages clear of them.
  // Variables on the root, not React state, so an animating composer does not re-render the chat.
  useLayoutEffect(() => {
    const root = rootRef.current!
    const stopHeader = publishHeight(headerRef.current, root, '--header-height')
    const stopHalf = publishHeight(composerRef.current, root, '--composer-half', 0.5)
    return () => {
      stopHeader()
      stopHalf()
    }
  }, [hasHeader])

  // The column's width in pixels, and how far open it is, as variables on the root like the bars'
  // heights, so that what it opens at is not rendered again at each step. The conversation is laid
  // out beside it at each step: it grows into the room the column gives up, and narrows as it takes it.
  const width = useMotionValue(0)
  const full = useRef(0)
  const goal = useRef(0)
  const wanted = useRef(false)
  // Whether there was something at the end when it was last placed: it is placed where it is when
  // that arrives, rather than opening, as when the conversation is only now loaded.
  const placed = useRef(false)
  const reduceMotion = useReducedMotion()
  useLayoutEffect(() => width.on('change', (px) => {
    const root = rootRef.current!
    root.style.setProperty('--side-width', `${px}px`)
    root.style.setProperty('--side-progress', full.current > 0 ? String(px / full.current) : '0')
  }), [width])
  useLayoutEffect(() => () => width.stop(), [width])

  // Open where it is wanted and there is room, else shut: at once, or as a glide that an open or shut one in the way is carried on from.
  const settle = useCallback((glides: boolean) => {
    const root = rootRef.current!
    full.current = SIDE * remOf(root)
    const to = wanted.current && !tooNarrow(root) ? full.current : 0
    if (to === goal.current) return
    goal.current = to
    if (to > 0) setSideShown(true)
    if (!glides) {
      width.jump(to)
      if (to === 0) setSideShown(false)
      return
    }
    animate(width, to, { ...OPENING_TIMING, onComplete: () => goal.current === 0 && setSideShown(false) })
  }, [width])

  useLayoutEffect(() => {
    wanted.current = sideOpen
    settle(placed.current && !reduceMotion)
    placed.current = hasSide
  }, [sideOpen, hasSide, reduceMotion, settle])
  useLayoutEffect(() => {
    const root = rootRef.current!
    let was: 'floating' | 'beside' | undefined
    const update = () => {
      const now = tooNarrow(root) ? 'floating' : 'beside'
      // Going between beside and floating gives the room back or takes it, such as when the window is narrowed or something opens beside the chat: it glides.
      settle(was !== undefined && was !== now && !reduceMotion)
      was = now
      setRoom(now)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [settle, reduceMotion])

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      {/* End halfway down the composer so faded messages cannot reappear below it. */}
      <div className="absolute inset-x-0 top-0 bottom-[var(--composer-half,0px)]">
        {children}
      </div>
      <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 pe-(--side-width,0px)">
        <div className="pointer-events-auto mx-auto w-full max-w-4xl p-3">{composer}</div>
      </div>
      {sideShown && side && (
        // Over the room the conversation leaves at its end, which it keeps by its own padding (`MessageList`), so that its scrollbar stays at the window's edge. Cut to the room it has been given, with what is in it kept at its own width and place from its start, so that it slides in from the edge as the room opens. Only what is in it takes the pointer, not the gap by the edge, which is the scrollbar's.
        <div inert={!sideOpen} className="pointer-events-none absolute inset-y-0 end-0 w-(--side-width,0px) overflow-x-clip">
          <div style={{ width: `${SIDE}rem` }} className="flex h-full flex-col pt-3 pe-3 pb-3 ps-5 opacity-(--side-progress,0) *:pointer-events-auto">{side}</div>
        </div>
      )}
      {/* Only the bars' own content takes the pointer; the gaps around it let it through. The
          header starts clear of what the frame puts there (`--header-lead`), such as a back button. */}
      {hasHeader && (
        <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex gap-1.5 p-3 ps-[calc(0.75rem+var(--header-lead,0px))]">
          {header && <div className="pointer-events-auto min-w-0">{header}</div>}
          {end && <div className="ms-auto shrink-0">{end}</div>}
        </header>
      )}
    </div>
  )
}
