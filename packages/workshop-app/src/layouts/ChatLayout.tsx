import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { animate, useMotionValue, type MotionValue } from 'motion/react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { publishHeight } from './publishHeight'

// The card at the header's end, open, is 17rem wide, 0.75rem in from the edge (the header's padding),
// and is kept at least 2rem from the column. It has no surface, so what is seen of it starts 0.875rem
// in from its edge (its padding and its rows'), which counts as part of the way from the column.
// The column is `max-w-4xl` wide, and no narrower than it is worth making room for the card
// beside it. All in rem.
const CARD_EDGE = 17.75 - 0.875
const MIN_GAP = 2
const COLUMN = 56
const MIN_COLUMN = 28
const SLIDE = { type: 'spring', duration: 0.36, bounce: 0 } as const

/**
 * How much room to leave at the end of `root` for an open card, in pixels. The column is centred
 * in the width up to the card, so that it is as far from the card as it is from the other edge, and
 * where that is less than `MIN_GAP`, it is moved over until it is that far. None where what is left
 * of the column would be too narrow to read.
 */
const endShift = (root: HTMLElement) => {
  if (tooNarrow(root)) return 0
  const rem = Number.parseFloat(getComputedStyle(root).fontSize)
  const room = CARD_EDGE * rem
  const gap = MIN_GAP * rem
  return Math.min(room + gap, Math.max(room, 2 * (room + gap) - (root.clientWidth - COLUMN * rem)))
}

/**
 * Puts the room at the end at `to`, in pixels, at once, which is where the column is laid out. With
 * `slides` the column is not seen to jump there: it is drawn where it was (`--end-slide`, which what
 * is in the column moves by) and glides to where it is. The column is centred in what is left of the
 * width, so it moves by half of the room that changes, whatever width it has, and gliding by that
 * moves nothing that is laid out, which sliding the room itself would at every step.
 */
const moveTo = (shift: MotionValue<number>, slide: MotionValue<number>, to: number, slides: boolean) => {
  const from = shift.get()
  if (to === from) return
  shift.jump(to)
  if (!slides) return
  slide.jump(slide.get() + (to - from) / 2)
  animate(slide, 0, SLIDE)
}

/** Whether `root` is too narrow to make room beside the column for the card at the end. */
const tooNarrow = (root: HTMLElement) => {
  const rem = Number.parseFloat(getComputedStyle(root).fontSize)
  return root.clientWidth < (CARD_EDGE + MIN_GAP + MIN_COLUMN) * rem
}

export type ChatLayoutProps = {
  header?: ReactNode
  /**
   * At the far end of the header's line, such as what the chat has. As a function, it is told
   * whether what is opened there has room beside the messages (`headerEndOpen`) or floats over
   * them, for where there is not.
   */
  headerEnd?: ReactNode | ((room: 'beside' | 'floating') => ReactNode)
  /**
   * What `headerEnd` has opened is out under it, beside the messages: they and the composer are
   * centred in the width that is left, instead of the whole of it.
   */
  headerEndOpen?: boolean
  composer: ReactNode
  /** The message list, which owns its scrolling. */
  children?: ReactNode
}

/**
 * A conversation screen: the messages scroll the full height, with the header and the composer
 * floating over them, unfilled. Messages and composer share one centered column, so wide screens
 * keep a readable line length.
 */
export const ChatLayout = ({ header, headerEnd, headerEndOpen = false, composer, children }: ChatLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // Whether there is room for what is opened at the end beside the column, measured before it is drawn.
  const [room, setRoom] = useState<'floating' | 'beside'>('floating')
  const end = typeof headerEnd === 'function' ? headerEnd(room) : headerEnd
  const hasEnd = Boolean(end)
  const hasHeader = Boolean(header || end)

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

  // The room left at the end for what is opened there, in pixels, as a variable on the root like the
  // bars' heights, which the column is laid out with at once. It glides to where it is when what is
  // opened at the end opens or closes, and follows the window when that is resized (`moveTo`).
  const shift = useMotionValue(0)
  const slide = useMotionValue(0)
  const reduceMotion = useReducedMotion() ?? false
  const wanted = useRef(false)
  // Whether there was something at the end when the column was last placed: it is placed where it
  // is when that arrives, rather than sliding there, as when the conversation is only now loaded.
  const placed = useRef(false)
  useLayoutEffect(() => shift.on('change', (value) => rootRef.current!.style.setProperty('--end-shift', `${value}px`)), [shift])
  // None at rest, as even a translation of nothing would make what is moved the place that what is fixed in it is fixed to.
  useLayoutEffect(() => slide.on('change', (value) => rootRef.current!.style.setProperty('--end-slide', value === 0 ? 'none' : `${value}px`)), [slide])
  useLayoutEffect(() => {
    wanted.current = headerEndOpen
    moveTo(shift, slide, headerEndOpen ? endShift(rootRef.current!) : 0, placed.current && !reduceMotion)
    placed.current = hasEnd
  }, [headerEndOpen, hasEnd, reduceMotion, shift, slide])
  useLayoutEffect(() => {
    const root = rootRef.current!
    let was: 'floating' | 'beside' | undefined
    const update = () => {
      const now = tooNarrow(root) ? 'floating' : 'beside'
      const to = wanted.current ? endShift(root) : 0
      // Going between beside and floating moves the column all of the card's room at once, when
      // the window is narrowed past what it needs, such as by what opens beside the chat: it glides.
      moveTo(shift, slide, to, was !== undefined && was !== now && !reduceMotion)
      was = now
      setRoom(now)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [shift, slide, reduceMotion])

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      {/* End halfway down the composer so faded messages cannot reappear below it. */}
      <div className="absolute inset-x-0 top-0 bottom-[var(--composer-half,0px)]">
        {children}
      </div>
      {/* Only the bars' own content takes the pointer; the gaps around it let it through. The
          header starts clear of what the frame puts there (`--header-lead`), such as a back button. */}
      {hasHeader && (
        <header ref={headerRef} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex gap-1.5 p-3 ps-[calc(0.75rem+var(--header-lead,0px))]">
          {header && <div className="pointer-events-auto min-w-0">{header}</div>}
          {end && <div className="pointer-events-auto ms-auto shrink-0">{end}</div>}
        </header>
      )}
      <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 pe-[var(--end-shift,0px)]">
        <div className="pointer-events-auto mx-auto w-full max-w-4xl [translate:var(--end-slide,none)] p-3">{composer}</div>
      </div>
    </div>
  )
}
