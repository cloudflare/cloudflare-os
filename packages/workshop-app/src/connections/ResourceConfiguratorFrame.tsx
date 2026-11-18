import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ResourceConfiguratorFrame as Frame } from '@gadgets/workshop-shared/gatekeeper'
import { placeFrame } from './framePlacement'
import { ResourceConfiguratorSession, type ConfiguratorSetup } from './ResourceConfiguratorSession'

export type ResourceConfiguratorFrameProps = Omit<ConfiguratorSetup, 'ui' | 'onResize' | 'onScroll'> & {
  /** The gatekeeper's frame; undefined while it is being opened. */
  frame: Frame | undefined
  /** What shows in its place until its form is drawn, such as that it is opening. */
  opening: ReactNode
  /** Hands over the way to collect what is chosen in it, while it is there to collect from. */
  onCollect: (collect: (() => Promise<string>) | undefined) => void
}

// The room kept while the form opens: a line, for what `opening` says.
const OPENING_HEIGHT = 24
// The runtime keeps its form this far in from the frame's sides, for its focus rings. The frame is
// that much wider than its room, so the form lines up with what is beside it in the dialog.
const FORM_INSET = 2

const scrollerOf = (element: HTMLElement | null) => {
  for (let node = element?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return undefined
}

// The app's theme, which `index.html` keeps on the root as it changes.
const subscribeMode = (onChange: () => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
  return () => observer.disconnect()
}
const readMode = () => (document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light')

/**
 * A gatekeeper's resource configurator (`ResourceConfiguratorSession`), in place in what it is in,
 * as tall as its form says once it is drawn, and until then `opening`, the frame kept out of sight
 * so that nothing half-drawn shows. The room grows to the form rather than jumping to it.
 *
 * The frame itself is fixed to the window over that room (`placeFrame`), placed again each frame
 * as what it is in scrolls or moves, so that a menu in the form draws past what it is in, over
 * what follows, as a select's would, rather than pushing it down or being cut off by a scrolled
 * dialog. So nothing it is in may be transformed while it shows: where something is (a dialog
 * scaling as it closes), the frame is hidden until it can be placed again. It never scrolls
 * itself; scrolled over, it scrolls what it is in.
 */
export const ResourceConfiguratorFrame = ({ frame, opening, onCollect, ...setup }: ResourceConfiguratorFrameProps) => {
  const roomRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // The latest render's, read by the session when it needs them.
  const latest = useRef<Omit<ConfiguratorSetup, 'onResize'>>(undefined)
  latest.current = {
    ...setup,
    ui: frame?.ui,
    onScroll: (deltaX, deltaY) => scrollerOf(roomRef.current)?.scrollBy({ left: deltaX, top: deltaY }),
  }
  const handOver = useRef(onCollect)
  handOver.current = onCollect
  const mode = useSyncExternalStore(subscribeMode, readMode)

  // One session for each frame given, which a new one replaces, and its form's size once drawn.
  // Each in a frame of its own (`key`), as two may be the same page.
  const sessions = useRef(0)
  const [session, setSession] = useState<{ frame: Frame; session: ResourceConfiguratorSession; key: number }>()
  const [drawnSize, setSize] = useState<{ session: ResourceConfiguratorSession; drawn: number; layout: number }>()
  useLayoutEffect(() => {
    if (!frame) return
    const onResize = (drawn: number, layout: number) =>
      setSize((last) => (last?.session === next && last.drawn === drawn && last.layout === layout ? last : { session: next, drawn, layout }))
    const next: ResourceConfiguratorSession = new ResourceConfiguratorSession(() => iframeRef.current?.contentWindow, () => ({ ...latest.current!, onResize }))
    setSession({ frame, session: next, key: ++sessions.current })
    window.addEventListener('message', next.receive)
    handOver.current(() => next.collect())
    return () => {
      window.removeEventListener('message', next.receive)
      handOver.current(undefined)
      latest.current?.onReady(false)
      next.dispose()
    }
  }, [frame])
  const current = session?.frame === frame ? session : undefined
  const size = current && drawnSize?.session === current.session ? drawnSize : undefined
  const latestSize = useRef(size)
  latestSize.current = size

  // Over its room, each frame: a dialog moves what is in it as it grows, which no event says.
  useEffect(() => {
    const room = roomRef.current
    const iframe = iframeRef.current
    if (!current || !room || !iframe) return
    const scroller = scrollerOf(room)
    let scheduled = 0
    let placed = ''
    let viewportTop: number | undefined
    const place = () => {
      scheduled = requestAnimationFrame(place)
      const { drawn, layout } = latestSize.current ?? { drawn: OPENING_HEIGHT, layout: OPENING_HEIGHT }
      const bounds = scroller?.getBoundingClientRect() ?? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
      const box = room.getBoundingClientRect()
      const { top, left, width, clip } = placeFrame({
        room: { top: box.top, bottom: box.bottom, left: box.left - FORM_INSET, right: box.right + FORM_INSET },
        bounds,
        drawn,
        layout,
        windowHeight: window.innerHeight,
      })
      const next = `${top} ${left} ${width} ${clip.top} ${clip.right} ${clip.bottom} ${clip.left}`
      if (next !== placed) {
        placed = next
        Object.assign(iframe.style, {
          top: `${top}px`,
          left: `${left}px`,
          width: `${width}px`,
          clipPath: `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`,
        })
      }
      // Fixed within something transformed, it is placed by that rather than by the window.
      const actual = iframe.getBoundingClientRect()
      iframe.style.visibility = Math.abs(actual.top - top) > 1 || Math.abs(actual.left - left) > 1 ? 'hidden' : ''
      // Where it is in the window, for where its menus open.
      if (top !== viewportTop) {
        viewportTop = top
        current.session.viewport(top, window.innerHeight)
      }
    }
    place()
    // A new window size closes its menus, and changes how far down they may open.
    const resized = () => {
      viewportTop = undefined
      current.session.windowResized()
    }
    window.addEventListener('resize', resized)
    return () => {
      cancelAnimationFrame(scheduled)
      window.removeEventListener('resize', resized)
    }
  }, [current])

  return (
    <div
      ref={roomRef}
      // Not shrunk in a column that scrolls, as nothing in it is laid out to say how tall it is.
      className="relative shrink-0 transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{ height: size?.layout ?? OPENING_HEIGHT }}
    >
      {!size && opening}
      {current && (
        <iframe
          key={current.key}
          ref={iframeRef}
          srcDoc={current.frame.iframeHtml}
          onLoad={current.session.loaded}
          // Its own scripts and nothing else: no origin, so it reaches nothing of the app's.
          sandbox="allow-scripts"
          // Never scrolled within: one that could would show a scrollbar each time its form outgrew it,
          // before it says so, which narrows the form, which can make it say so again, and so on.
          scrolling="no"
          title="Resource configurator"
          // Out of reach until its form is drawn, as it is out of sight.
          inert={!size}
          className="fixed top-0 left-0 z-10 border-0 bg-transparent transition-opacity duration-150 motion-reduce:transition-none"
          style={{ height: size?.drawn ?? OPENING_HEIGHT, opacity: size ? 1 : 0, colorScheme: mode }}
        />
      )}
    </div>
  )
}
