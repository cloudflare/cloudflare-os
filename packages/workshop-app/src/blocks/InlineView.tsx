import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { AppWindowIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { CARD } from '@/components/Card'
import { inlineViewPage, readViewMessage, readViewTheme, VIEW_HANDSHAKE } from './inlineViewPage'
import './InlineView.css'

export type InlineViewProps = {
  /** The block's HTML, as the agent wrote it between its tags. */
  html: string
  /** What the view is, from its `<title>`; it is not drawn in the view itself. */
  title?: string
  /** Why it will not run: it has nothing in it but its title. */
  error?: string
  /**
   * The view's code asked the viewer to send `message` (`agent.send`), for whoever lays out the
   * answer to put to them (`ViewAsk`). Absent where nothing can be sent: the asks are dropped.
   */
  onAsk?: (message: string) => void
}

// Before its first height is known: about a short chart's.
const DRAWING_HEIGHT = 136
// As tall as its content, up to this, and never taller than most of the window; beyond, it scrolls.
const MAX_HEIGHT = 720
const fit = (height: number) => Math.min(height, MAX_HEIGHT, Math.max(window.innerHeight - 160, 240))

// The nearest box that scrolls it, which clips it before the window does, for it to be started a
// screen before it is scrolled to.
const scrollerOf = (element: Element): Element | null => {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return null
}

/**
 * A live view the agent drew in its answer, on a card of its own between what it says: its HTML
 * running in a sandboxed frame as tall as what it draws, in the app's theme. It starts as it
 * nears the screen and stops once far from it, as its code is told, keeping its height meanwhile;
 * while it is first drawn, a sketch of lines stands in. Its foot names it, and stops it or runs it
 * again. What its code asks the viewer to send goes to whoever lays out the answer (`onAsk`).
 */
export const InlineView = ({ html, title, error, onAsk }: InlineViewProps) => {
  const name = title ?? 'View'
  const card = useRef<HTMLElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const port = useRef<MessagePort>(undefined)
  const [near, setNear] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [height, setHeight] = useState<number>()
  // Taller than it may be drawn: it scrolls within, and its foot fades to say so.
  const [overflows, setOverflows] = useState(false)
  const [problem, setProblem] = useState<string>()
  const live = near && !stopped && error === undefined

  // Read when the page asks, so a new function each render does not start it again.
  const onAskRef = useRef(onAsk)
  useLayoutEffect(() => {
    onAskRef.current = onAsk
  })

  useEffect(() => {
    const element = card.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting ?? false), {
      root: scrollerOf(element),
      rootMargin: '100% 0px',
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Each load of the page, the first or one its own code started, hands over a port of its own.
  // Listening from layout, before the frame's page can have started.
  useLayoutEffect(() => {
    if (!live) return
    const handshake = (event: MessageEvent) => {
      // Our own frame, still at no origin ("null" is the string the browser reports for that).
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || event.data !== VIEW_HANDSHAKE) return
      const [given] = event.ports
      if (!given) return
      port.current?.close()
      port.current = given
      setProblem(undefined)
      given.addEventListener('message', ({ data }) => {
        const message = readViewMessage(data)
        if (message?.type === 'height') {
          setHeight(fit(message.height))
          setOverflows(fit(message.height) < message.height)
        } else if (message?.type === 'error') setProblem(message.message)
        else if (message?.type === 'send') onAskRef.current?.(message.message)
      })
      // What the page sent before this was listening is queued until then.
      given.start()
    }
    window.addEventListener('message', handshake)
    return () => {
      window.removeEventListener('message', handshake)
      port.current?.close()
      port.current = undefined
      // An error goes with the page that threw it.
      setProblem(undefined)
    }
  }, [live])

  // The app's theme follows the system's (index.html), and the page follows the app's.
  useEffect(() => {
    if (!live) return
    const observer = new MutationObserver(() => port.current?.postMessage({ type: 'theme', ...readViewTheme() }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
    return () => observer.disconnect()
  }, [live])

  const drawn = height !== undefined
  return (
    <div className="flex w-full flex-col gap-2">
      {/* On the agent's side, as its words are: a little wider than a bubble may be, for a chart's
          room, and never across to where the viewer's own messages are. A phone gives it the column. */}
      <figure ref={card} aria-label={name} className={cn(CARD, 'group/view flex max-w-[min(100%,36rem)] flex-col overflow-hidden', error === undefined ? 'w-full' : 'w-fit')}>
        {error === undefined && !stopped && (
          <div className="relative p-3">
            {/* The frame reaches past the padding by its page's own, so what it draws lines up with the card's inset. */}
            <div
              className={cn(
                'relative -m-1 transition-[height] duration-300 ease-out motion-reduce:transition-none',
                overflows && '[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]',
              )}
              style={{ height: height ?? DRAWING_HEIGHT }}
            >
              {!drawn && <ViewSketch />}
              {live && (
                <ViewFrame
                  ref={frame}
                  html={html}
                  title={name}
                  className={cn('transition-opacity duration-200 ease-out motion-reduce:transition-none', drawn ? 'opacity-100' : 'opacity-0')}
                />
              )}
            </div>
          </div>
        )}
        <figcaption
          className={cn(
            'flex min-h-10 items-center gap-2 px-4 py-2 text-sm/5 text-kumo-subtle',
            error === undefined && !stopped && 'border-t border-kumo-line',
          )}
        >
          <AppWindowIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 truncate text-kumo-default">{name}</span>
          <span className="shrink-0">{error !== undefined ? 'Empty' : stopped ? 'Stopped' : drawn ? 'Live' : 'Drawing…'}</span>
          {error === undefined && (
            <button
              type="button"
              aria-label={stopped ? `Run ${name} again` : `Stop ${name}`}
              onClick={() => setStopped(!stopped)}
              className={cn(
                'ms-auto shrink-0 cursor-pointer rounded-full px-2 py-0.5 font-medium text-kumo-subtle transition-[color,opacity] duration-150 hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring',
                // Out of the way while it runs, until the card is pointed at; a touch screen has nothing to point with.
                !stopped && 'pointer-fine:opacity-0 pointer-fine:group-hover/view:opacity-100 pointer-fine:group-focus-within/view:opacity-100',
              )}
            >
              {stopped ? 'Run again' : 'Stop'}
            </button>
          )}
        </figcaption>
      </figure>
      {problem !== undefined && <p className="max-w-[min(100%,36rem)] px-4 text-sm/5 text-kumo-danger">{problem}</p>}
    </div>
  )
}

/**
 * One load of a view's page. It starts in the theme of the moment it mounts, so a view that runs
 * again, or comes back into sight, after the theme changed starts in the new one; the theme it is
 * sent keeps it current after that.
 */
const ViewFrame = ({ ref, html, title, className }: { ref: Ref<HTMLIFrameElement>; html: string; title: string; className?: string }) => {
  const [page] = useState(() => inlineViewPage(html, readViewTheme()))
  return <iframe ref={ref} srcDoc={page} title={title} sandbox="allow-scripts" className={cn('absolute inset-0 block size-full border-0', className)} />
}

/** While a view is first drawn: the lines of one, sketched in, which come only if it is slow to. */
const ViewSketch = () => (
  <div aria-hidden="true" className="view-sketch absolute inset-1 flex flex-col gap-3">
    <span className="h-3.5 w-2/5 rounded-full" />
    <span className="h-2.5 w-3/5 rounded-full" />
    <span className="flex-1 rounded-xl" />
  </div>
)
