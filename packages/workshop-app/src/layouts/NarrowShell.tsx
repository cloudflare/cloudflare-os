import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, spring, usePresence } from 'motion/react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { SidebarSimpleIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { OPENING_TIMING } from './useEdgeHint'

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
  /** Shows the aside, when none is showing: tapped at the window's far edge, where a pill shows. */
  onOpenAside?: () => void
}

// The room the sidebar's button takes at the start of a page's header: the button and the header's gap.
const BUTTON_ROOM = 'calc(var(--control-size) + 6px)'
// How much of the page stays in sight at the far edge with the sidebar out, to be tapped to put the
// sidebar away. The sidebar has the rest.
const PEEK = 64
// How far the page beneath moves aside, as a share of its width, as the aside comes over it.
const PARALLAX = 0.25
// The aside's surface, over all of the page, with an edge for while it is on its way.
const SURFACE = 'absolute inset-0 z-30 flex flex-col overflow-hidden bg-kumo-base ring-1 ring-kumo-line'
// Where the sidebar is, out and put away, and the aside, there and gone, as `translate`.
const SIDEBAR_AT = { out: '0px', away: `${-PARALLAX * 100}%` }
const ASIDE_AT = { there: '0px', gone: '100%' }

/** Where the page is, as `translate`: aside to the far edge for the sidebar, and a little the other way under the aside. */
const pageAt = (sidebarOpen: boolean, asideShown: boolean) =>
  `calc(${sidebarOpen ? `100% - ${PEEK}px` : '0px'} - ${asideShown ? PARALLAX * 100 : 0}%)`

// The panes' own spring, sampled for the browser to play: Chrome on Android plays motion moved from
// script each frame at 60 Hz once the finger has lifted, and its own animations at the display's rate.
const SLIDE: KeyframeAnimationOptions = (() => {
  const duration = OPENING_TIMING.duration * 1000
  const curve = spring({ keyframes: [0, 1], duration, bounce: OPENING_TIMING.bounce })
  const points = Array.from({ length: 49 }, (_, index) => Number(curve.next((index / 48) * duration).value.toFixed(4)))
  return { duration, easing: `linear(${points.join(', ')})` }
})()

type SlideOptions = {
  /** Where it slides to `to` from when it first appears. Left out, it is simply there. */
  from?: string
  /** It has got to `to`. */
  onDone?: () => void
}

/**
 * Keeps an element's `translate` at `to`, which it renders, and slides it there with the browser's
 * own animation when `to` changes: from wherever it is, part of the way along a slide turned back.
 */
const useSlide = <Element extends HTMLElement>(to: string, reduceMotion: boolean, { from: initial = to, onDone }: SlideOptions = {}) => {
  const element = useRef<Element>(null)
  const from = useRef(initial)
  const sliding = useRef<Animation>(undefined)
  const done = useEffectEvent(() => onDone?.())
  // Before the paint that would show it at `to` already.
  useLayoutEffect(() => {
    if (from.current === to || !element.current) return
    const now = sliding.current?.playState === 'running' ? getComputedStyle(element.current).translate : from.current
    from.current = to
    sliding.current?.cancel()
    sliding.current = undefined
    if (reduceMotion) return done()
    const slide = element.current.animate([{ translate: now === 'none' ? '0px' : now }, { translate: to }], SLIDE)
    slide.onfinish = done
    sliding.current = slide
  }, [to, reduceMotion])
  return element
}

/** The aside over the page, which slides in from the far edge, and stays for as long as going back there takes. */
const NarrowAside = ({ arrives, children }: {
  /** It slides in, rather than being there from the start. */
  arrives: boolean
  children: ReactNode
}) => {
  const [isPresent, safeToRemove] = usePresence()
  const reduceMotion = useReducedMotion() ?? false
  const at = isPresent ? ASIDE_AT.there : ASIDE_AT.gone
  const element = useSlide<HTMLDivElement>(at, reduceMotion, {
    from: arrives ? ASIDE_AT.gone : at,
    onDone: () => {
      if (!isPresent) safeToRemove?.()
    },
  })

  return (
    <div ref={element} style={{ translate: at }} className={SURFACE}>
      {children}
    </div>
  )
}

/**
 * The application frame on a narrow screen, such as a phone, which has room for one thing at a
 * time: the page, filling the window to its edges. The sidebar is beneath it: a button at the
 * start of the page's header moves the page aside to the far edge to show it. The page that stays
 * in sight is tapped to put the sidebar away again, and so is Escape.
 *
 * What is open beside the page on a wider screen comes over all of it here, from the far edge, as
 * the page moves a little aside beneath it. It is had back by a tap at that edge, where a pill
 * shows, and goes by its own back button. Neither is swiped, which the system's own gestures at
 * the window's edges would take.
 */
export const NarrowShell = ({ children, sidebar, status, aside, onOpenAside }: NarrowShellProps) => {
  const reduceMotion = useReducedMotion() ?? false
  const shown = Boolean(aside)
  const sidebarOpen = sidebar?.open ?? false
  // An aside there from the start was not brought, and so does not slide in: it is simply there.
  const [asideWasThere, setAsideWasThere] = useState(shown)
  if (asideWasThere && !shown) setAsideWasThere(false)
  const sidebarAt = sidebarOpen ? SIDEBAR_AT.out : SIDEBAR_AT.away
  const page = pageAt(sidebarOpen, shown)
  const sidebarSlide = useSlide<HTMLDivElement>(sidebarAt, reduceMotion)
  const pageSlide = useSlide<HTMLDivElement>(page, reduceMotion)
  const lead = sidebar?.button ? ({ '--header-lead': BUTTON_ROOM } as CSSProperties) : undefined

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
      <div style={lead} className="relative size-full overflow-hidden">
        {sidebar && (
          // On the backdrop, as beside the page on a wider screen.
          <div
            ref={sidebarSlide}
            style={{ translate: sidebarAt, width: `calc(100% - ${PEEK}px)` }}
            inert={!sidebarOpen}
            className="absolute inset-y-0 left-0 flex flex-col bg-kumo-canvas px-2 py-1"
          >
            {sidebar.content}
          </div>
        )}
        {/* Out of reach under the aside, and while the sidebar is out. Its own surface, with an
            edge, over the sidebar. */}
        <div ref={pageSlide} style={{ translate: page }} inert={shown || sidebarOpen} className="absolute inset-0 flex flex-col bg-kumo-base ring-1 ring-kumo-line">
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          {sidebar?.button && (
            // Where the page's header starts, which leaves it the room (`--header-lead`).
            <div className="absolute top-3 left-3 z-20 flex">
              <HeaderBubble>
                <Button icon={SidebarSimpleIcon} aria-label="Show the sidebar" title="Sidebar" aria-expanded={sidebarOpen} onClick={() => sidebar.onOpenChange(true)} />
              </HeaderBubble>
            </div>
          )}
        </div>
        {sidebarOpen && sidebar && (
          // What is in sight of the page, to be tapped to put the sidebar away; it is out of reach itself.
          <button
            type="button"
            aria-label="Hide the sidebar"
            style={{ translate: page }}
            onClick={() => sidebar.onOpenChange(false)}
            className="absolute inset-0 z-40 cursor-pointer outline-none"
          />
        )}
        {!shown && !sidebarOpen && onOpenAside && (
          // Down the far edge, below the header so as not to be in the way of its buttons, and
          // under the aside, which uncovers it as it goes.
          <button type="button" aria-label="Show the side pane" onClick={onOpenAside} className="group absolute top-16 right-0 bottom-0 z-20 w-6 cursor-pointer outline-none">
            {/* In the middle of the window: the strip starts below the header, 4rem down. */}
            <span aria-hidden="true" className="absolute top-[calc(50%-2rem)] right-1.5 h-12 w-1.5 -translate-y-1/2 rounded-full bg-kumo-contrast opacity-25 transition-opacity group-focus-visible:opacity-70" />
          </button>
        )}
        <AnimatePresence initial={false}>
          {shown ? <NarrowAside key="aside" arrives={!asideWasThere}>{aside}</NarrowAside> : null}
        </AnimatePresence>
        {status && <div className="pointer-events-none absolute inset-x-0 top-2 z-50 flex justify-center">{status}</div>}
      </div>
    </div>
  )
}
