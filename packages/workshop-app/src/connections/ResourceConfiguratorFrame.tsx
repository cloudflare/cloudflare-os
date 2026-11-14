import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResourceConfiguratorFrame as Frame } from '@gadgets/workshop-shared/gatekeeper'
import { ResourceConfiguratorSession, type ConfiguratorSetup } from './ResourceConfiguratorSession'

export type ResourceConfiguratorFrameProps = Omit<ConfiguratorSetup, 'ui' | 'onResize' | 'onScroll'> & {
  frame: Frame
  /** Hands over the way to collect what is chosen in it, while it is there to collect from. */
  onCollect: (collect: (() => Promise<string>) | undefined) => void
}

const MIN_HEIGHT = 80

const scrollerOf = (element: HTMLElement | null) => {
  for (let node = element?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return undefined
}

/**
 * A gatekeeper's resource configurator (`ResourceConfiguratorSession`), in place in what it is in,
 * as tall as its form says. A menu in the form draws past that, over what follows, as a select's
 * would, rather than pushing it down. Scrolled over, it scrolls what it is in.
 */
export const ResourceConfiguratorFrame = ({ frame, onCollect, ...setup }: ResourceConfiguratorFrameProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [{ drawn, layout }, setSize] = useState({ drawn: MIN_HEIGHT, layout: MIN_HEIGHT })
  // The latest render's, read by the session when it needs them.
  const latest = useRef<ConfiguratorSetup>(undefined)
  latest.current = {
    ...setup,
    ui: frame.ui,
    onResize: (nextDrawn, nextLayout) => setSize({ drawn: nextDrawn, layout: nextLayout }),
    onScroll: (deltaX, deltaY) => scrollerOf(wrapperRef.current)?.scrollBy({ left: deltaX, top: deltaY }),
  }
  const handOver = useRef(onCollect)
  handOver.current = onCollect

  // One session for each page given, which a new page replaces.
  const [session, setSession] = useState<{ html: string; session: ResourceConfiguratorSession }>()
  useLayoutEffect(() => {
    const next = new ResourceConfiguratorSession(() => iframeRef.current?.contentWindow, () => latest.current!)
    setSession({ html: frame.iframeHtml, session: next })
    setSize({ drawn: MIN_HEIGHT, layout: MIN_HEIGHT })
    window.addEventListener('message', next.receive)
    handOver.current(() => next.collect())
    return () => {
      window.removeEventListener('message', next.receive)
      handOver.current(undefined)
      latest.current?.onReady(false)
      next.dispose()
    }
  }, [frame.iframeHtml])

  // Where it is in the window, for where its menus open: as it moves, and as the window does.
  useEffect(() => {
    if (!session) return
    let scheduled = 0
    const place = () => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(() => {
        const top = wrapperRef.current?.getBoundingClientRect().top
        if (top !== undefined) session.session.viewport(top, window.innerHeight)
      })
    }
    const resized = () => {
      place()
      session.session.windowResized()
    }
    place()
    window.addEventListener('resize', resized)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(scheduled)
      window.removeEventListener('resize', resized)
      window.removeEventListener('scroll', place, true)
    }
  }, [session, layout])

  const mode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light'
  return (
    <div ref={wrapperRef} className="relative" style={{ height: layout }}>
      {session?.html === frame.iframeHtml && (
        <iframe
          ref={iframeRef}
          srcDoc={frame.iframeHtml}
          onLoad={session.session.loaded}
          // Its own scripts and nothing else: no origin, so it reaches nothing of the app's.
          sandbox="allow-scripts"
          title="Resource configurator"
          className="absolute inset-x-0 top-0 z-10 w-full border-0 bg-transparent"
          style={{ height: drawn, colorScheme: mode }}
        />
      )}
    </div>
  )
}
