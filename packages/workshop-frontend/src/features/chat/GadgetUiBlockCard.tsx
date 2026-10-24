import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { Banner, Text } from '@cloudflare/kumo'
import { PaperPlaneRightIcon } from '@phosphor-icons/react'
import { newMessagePortRpcSession, type RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { GadgetUiSegment } from '@gadgets/workshop-shared/gadget-ui-blocks'
import { useTheme } from '../../ThemeContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import {
  createUiBlockDocumentStart,
  createUiBlockShell,
  readUiBlockTheme,
  UiBlockHostImpl,
  type UiBlockFrame,
} from './uiBlockFrame'

const MIN_HEIGHT = 40
const MAX_HEIGHT = 720
// A view reloads when one of its bindings breaks, as a gadget's server does on every code change.
// One that keeps breaking within STABLE_CONNECTION_MS of its handshake waits longer each time.
const STABLE_CONNECTION_MS = 10_000
const MAX_RELOAD_DELAY_MS = 30_000
const reloadDelay = (quickBreaks: number) =>
  quickBreaks === 0 ? 0 : Math.min(1000 * 2 ** (quickBreaks - 1), MAX_RELOAD_DELAY_MS)

export type GadgetUiBlockCardProps = {
  overseer: RpcStub<Overseer>
  chatId: number
  /** The block: closed, or still open while its answer streams, with its HTML so far. */
  block: Exclude<GadgetUiSegment, { kind: 'text' }>
  /** The answer is still streaming: its tool calls have not run yet. */
  streaming: boolean
  /** Sends a message as the viewer, as the composer does. Reports its own failures, then throws. */
  onSendMessage: (message: string) => Promise<void>
  /** Why the viewer cannot send now, e.g. the chat waits on an approval. */
  sendBlockedReason?: string
  /**
   * Runs after the view's height may have changed: its frame reported a new height, its chip came
   * or went, or a binding's name joined the line under it.
   */
  onHeightChange: () => void
  /** The chat's scrolling message list. It clips the view before the window does. */
  scrollRoot: RefObject<HTMLElement | null>
}

/** A message the view asked to send, waiting on the viewer's Send, and whether that Send is running. */
type Chip = { message: string; sending: boolean }

const clampHeight = (height: number) =>
  Math.min(Math.max(height, MIN_HEIGHT), Math.min(MAX_HEIGHT, window.innerHeight - 120))

/** A live `<gadget-ui>` block of an agent answer, drawn in place in a sandboxed frame. */
export const GadgetUiBlockCard = ({
  overseer, chatId, block, streaming, onSendMessage, sendBlockedReason, onHeightChange, scrollRoot,
}: GadgetUiBlockCardProps) => {
  const { resolvedThemeMode } = useTheme()
  const cardRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // The current frame load: its frame, and how much of the block it has.
  const loadRef = useRef<{ frame: RpcStub<UiBlockFrame>; written: number; closed: boolean } | null>(null)
  const quickBreaksRef = useRef(0)
  const [nearViewport, setNearViewport] = useState(false)
  // The viewer stopped the view: its frame and stubs are gone until they run it again.
  const [stopped, setStopped] = useState(false)
  const [height, setHeight] = useState(MIN_HEIGHT)
  // Why the view stopped itself, until the viewer reloads it. A block the parser refused never runs.
  const [stopReason, setStopReason] = useState<string | null>(null)
  const refused = block.kind === 'block' ? block.error : undefined
  const error = refused ?? stopReason
  // The latest uncaught error in the block's own code. The view keeps running.
  const [codeError, setCodeError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [chip, setChip] = useState<Chip | null>(null)
  // Names the view's code opened, in the order it opened them.
  const [names, setNames] = useState<string[]>([])

  // The Overseer connection the current frame load asked for a binding on. Its stubs and lookups
  // die with that connection, so a new one (the Workshop reconnected) needs a new load. A frame
  // that never asked keeps running.
  const [askedOn, setAskedOn] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  if (askedOn !== null && askedOn.stub !== overseer) {
    setAskedOn(null)
    setFrameKey(key => key + 1)
  }

  // A lookup failed while the answer streamed. The answer's tool calls run after its text, so they
  // may add the binding: the view loads again once the answer is stored.
  const [failedWhileStreaming, setFailedWhileStreaming] = useState(false)
  if (failedWhileStreaming && !streaming) {
    setFailedWhileStreaming(false)
    setFrameKey(key => key + 1)
  }

  const openBinding = useEffectEvent(async (name: string) => {
    // Marked before the lookup, so a lookup still in flight when the Workshop reconnects counts.
    setAskedOn(current => current ?? { stub: overseer })
    const askedWhileStreaming = streaming
    try {
      return await overseer.connectToChatBinding(chatId, name)
    } catch (err) {
      if (askedWhileStreaming) setFailedWhileStreaming(true)
      throw err
    }
  })

  // Sends the frame what it lacks of the block: the HTML that arrived since its last write, then
  // the end of its document once the block closes. Each call is settled so that capnweb releases
  // it; one rejects only when its frame has gone.
  const writeBlock = useEffectEvent(() => {
    const load = loadRef.current
    if (!load) return
    if (block.html.length > load.written) {
      load.frame.write(block.html.slice(load.written)).catch(() => {})
      load.written = block.html.length
    }
    if (block.kind === 'block' && !load.closed) {
      load.frame.close().catch(() => {})
      load.closed = true
    }
  })
  useEffect(() => writeBlock(), [block.html, block.kind])

  const live = nearViewport && error === null && !stopped

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    // The margin has to grow the message list's box: a scrolling ancestor clips the card first.
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry?.isIntersecting ?? false),
      { root: scrollRoot.current, rootMargin: '100% 0px' },
    )
    observer.observe(card)
    return () => observer.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    if (!live) return
    let closed = false
    let handshakes = 0
    let reloading = false
    const resources: Disposable[] = []
    const teardown = () => {
      loadRef.current = null
      // A request needs the frame that made it, and an error the document that threw it.
      setChip(null)
      setCodeError(null)
      setAskedOn(null)
      for (const resource of resources.splice(0).toReversed()) resource[Symbol.dispose]()
    }

    const handleMessage = (event: MessageEvent) => {
      // Only our own frame, still at its opaque origin ("null" is the string the browser reports).
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== 'null') return
      const port = event.ports[0]
      if (event.data !== 'handshake' || !port) return
      if (++handshakes > 1) {
        // The document loaded again without the Workshop reloading it: its code navigated.
        port.close()
        teardown()
        setStopReason('This view reloaded itself, so it was stopped.')
        return
      }
      const openedAt = Date.now()
      const host = new UiBlockHostImpl({
        openBinding: name => openBinding(name),
        onBinding: name => setNames(current => current.includes(name) ? current : [...current, name]),
        onBindingBroken: () => {
          // Disposing a stub can report it broken, and the stubs of one load often break together.
          if (closed || reloading) return
          reloading = true
          if (Date.now() - openedAt > STABLE_CONNECTION_MS) quickBreaksRef.current = 0
          const timer = setTimeout(() => setFrameKey(key => key + 1), reloadDelay(quickBreaksRef.current++))
          resources.push({ [Symbol.dispose]: () => clearTimeout(timer) })
        },
        onMessageRequest: message => setChip({ message, sending: false }),
        onResize: reported => setHeight(clampHeight(reported)),
        onError: setCodeError,
      })
      resources.push(host)
      const frame = newMessagePortRpcSession<UiBlockFrame>(port, host)
      resources.push(frame)
      loadRef.current = { frame, written: 0, closed: false }
      frame.write(createUiBlockDocumentStart(readUiBlockTheme())).catch(() => {})
      writeBlock()
    }

    window.addEventListener('message', handleMessage)
    return () => {
      closed = true
      window.removeEventListener('message', handleMessage)
      teardown()
    }
  }, [live, frameKey])

  useEffect(() => {
    // ThemeProvider applies a mode to the document before it publishes it.
    loadRef.current?.frame.setTheme(readUiBlockTheme()).catch(() => {})
  }, [resolvedThemeMode])

  useLayoutEffect(() => onHeightChange(), [height, chip, names, onHeightChange])

  const send = async () => {
    if (!chip || chip.sending || sendBlockedReason !== undefined) return
    const { message } = chip
    setChip({ message, sending: true })
    // The view may ask again while this one is in flight; the newer request stays.
    try {
      await onSendMessage(message)
      setChip(current => current?.message === message ? null : current)
    } catch {
      setChip(current => current?.message === message ? { message, sending: false } : current)
    }
  }

  const reload = () => {
    quickBreaksRef.current = 0
    setStopReason(null)
    setFrameKey(key => key + 1)
  }

  const title = block.title ?? 'View'
  return (
    <div ref={cardRef} className="group/view my-3">
      {error !== null ? (
        <Banner
          variant="error"
          title="This view stopped"
          description={error}
          // A block the parser refused must never run.
          action={refused === undefined ? <Banner.Action onClick={reload}>Reload</Banner.Action> : undefined}
        />
      ) : !stopped && (
        // The frame reaches past the answer's column by the body's padding, so the view's content
        // lines up with the prose around it.
        <div className="-mx-1 -my-1" style={{ height }}>
          {live && <ViewFrame key={frameKey} ref={iframeRef} title={title} />}
        </div>
      )}
      {error === null && codeError !== null && (
        <div className="mt-1">
          <Text size="sm" variant="error">{codeError}</Text>
        </div>
      )}
      {error === null && (
        // Workshop chrome the frame cannot draw: where the view ends, and what it reached.
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-kumo-inactive">
          <span>{stopped ? 'View stopped' : block.kind === 'open' ? 'Drawing…' : 'Live view'}</span>
          {!stopped && names.length > 0 && <span className="font-mono">{names.join(', ')}</span>}
          <button
            type="button"
            aria-label={stopped ? `Run ${title} again` : `Stop ${title}`}
            onClick={() => {
              // Run starts afresh, as Reload does.
              if (stopped) quickBreaksRef.current = 0
              setStopped(!stopped)
            }}
            className={`cursor-pointer rounded px-1 font-medium transition-[color,opacity] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none ${
              stopped ? '' : 'sm:opacity-0 sm:group-hover/view:opacity-100 sm:group-focus-within/view:opacity-100'
            }`}
          >
            {stopped ? 'Run' : 'Stop'}
          </button>
        </div>
      )}
      <div aria-live="polite">
        {chip && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line px-3 py-2" role="group" aria-label="Send to the agent">
            <PaperPlaneRightIcon size={14} className="text-kumo-subtle" aria-hidden />
            <div
              // A keyboard user has to be able to scroll a long message to read it all.
              tabIndex={0}
              role="region"
              aria-label="Message to send"
              className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
            >
              <Text size="sm">{chip.message}</Text>
            </div>
            {sendBlockedReason !== undefined && <Text size="sm" variant="secondary">{sendBlockedReason}</Text>}
            <div className="ml-auto flex gap-2">
              <WorkshopButton onClick={() => setChip(null)}>Dismiss</WorkshopButton>
              <WorkshopButton tone="primary" disabled={chip.sending || sendBlockedReason !== undefined} onClick={send}>
                Send
              </WorkshopButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One load of a view's frame. Its shell starts in the theme of the moment it mounts, so a view that
 * reloads or scrolls back after a theme change starts in the new one. The block's document and
 * `setTheme` keep it current after that.
 */
const ViewFrame = ({ ref, title }: { ref: RefObject<HTMLIFrameElement | null>; title: string }) => {
  const [srcDoc] = useState(() => createUiBlockShell(readUiBlockTheme()))
  return <iframe ref={ref} srcDoc={srcDoc} title={title} sandbox="allow-scripts" className="block h-full w-full border-0" />
}
