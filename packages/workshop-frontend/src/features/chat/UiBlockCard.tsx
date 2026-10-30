import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { Banner, Text } from '@cloudflare/kumo'
import { PaperPlaneRightIcon } from '@phosphor-icons/react'
import { newMessagePortRpcSession, type RpcStub } from 'capnweb'
import type { InlineHtmlSegment } from '@gadgets/workshop-shared/inline-html-blocks'
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

export type UiBlockCardProps = {
  /** The block: closed, or still open while its answer streams, with its HTML so far. */
  block: Exclude<InlineHtmlSegment, { kind: 'text' }>
  /** Sends a message as the viewer, as the composer does. Reports its own failures, then throws. */
  onSendMessage: (message: string) => Promise<void>
  /** Why the viewer cannot send now, e.g. the chat waits on an approval. */
  sendBlockedReason?: string
  /** Runs after the view's height may have changed: its frame reported a new height, or its chip came or went. */
  onHeightChange: () => void
  /** The chat's scrolling message list. It clips the view before the window does. */
  scrollRoot: RefObject<HTMLElement | null>
}

/** A message the view asked to send, waiting on the viewer's Send, and whether that Send is running. */
type Chip = { message: string; sending: boolean }

const clampHeight = (height: number) =>
  Math.min(Math.max(height, MIN_HEIGHT), Math.min(MAX_HEIGHT, window.innerHeight - 120))

/**
 * A live view in the chat, drawn in place in a sandboxed frame: an `<inline-html>` block of an
 * agent answer, or a view from `embedView`.
 */
export const UiBlockCard = ({
  block, onSendMessage, sendBlockedReason, onHeightChange, scrollRoot,
}: UiBlockCardProps) => {
  const { resolvedThemeMode } = useTheme()
  const cardRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // The current frame load: its frame, and how much of the block it has.
  const loadRef = useRef<{ frame: RpcStub<UiBlockFrame>; written: number; closed: boolean } | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  // The viewer stopped the view: its frame is gone until they run it again.
  const [stopped, setStopped] = useState(false)
  const [height, setHeight] = useState(MIN_HEIGHT)
  // A block the parser refused never runs.
  const refused = block.kind === 'block' ? block.error : undefined
  // The latest uncaught error in the block's own code. The view keeps running.
  const [codeError, setCodeError] = useState<string | null>(null)
  const [chip, setChip] = useState<Chip | null>(null)

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

  const live = nearViewport && refused === undefined && !stopped

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
    const teardown = () => {
      loadRef.current?.frame[Symbol.dispose]()
      loadRef.current = null
      // A request needs the frame that made it, and an error the document that threw it.
      setChip(null)
      setCodeError(null)
    }

    // Each load of the frame's document, its first or one its own code started, handshakes once,
    // and gets the block from the start in a session of its own.
    const handleMessage = (event: MessageEvent) => {
      // Only our own frame, still at its opaque origin ("null" is the string the browser reports).
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== 'null') return
      const port = event.ports[0]
      if (event.data !== 'handshake' || !port) return
      teardown()
      const frame = newMessagePortRpcSession<UiBlockFrame>(port, new UiBlockHostImpl({
        onMessageRequest: message => setChip({ message, sending: false }),
        onResize: reported => setHeight(clampHeight(reported)),
        onError: setCodeError,
      }))
      loadRef.current = { frame, written: 0, closed: false }
      frame.write(createUiBlockDocumentStart(readUiBlockTheme())).catch(() => {})
      writeBlock()
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      teardown()
    }
  }, [live])

  useEffect(() => {
    // ThemeProvider applies a mode to the document before it publishes it.
    loadRef.current?.frame.setTheme(readUiBlockTheme()).catch(() => {})
  }, [resolvedThemeMode])

  useLayoutEffect(() => onHeightChange(), [height, chip, onHeightChange])

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

  const title = block.title ?? 'View'
  return (
    <div ref={cardRef} className="group/view my-3">
      {refused !== undefined ? (
        <Banner variant="error" title="This view stopped" description={refused} />
      ) : !stopped && (
        // The frame reaches past the answer's column by the body's padding, so the view's content
        // lines up with the prose around it.
        <div className="-mx-1 -my-1" style={{ height }}>
          {live && <ViewFrame ref={iframeRef} title={title} />}
        </div>
      )}
      {refused === undefined && codeError !== null && (
        <div className="mt-1">
          <Text size="sm" variant="error">{codeError}</Text>
        </div>
      )}
      {refused === undefined && (
        // Workshop chrome the frame cannot draw: where the view ends.
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-kumo-inactive">
          <span>{stopped ? 'View stopped' : block.kind === 'open' ? 'Drawing…' : 'Live view'}</span>
          <button
            type="button"
            aria-label={stopped ? `Run ${title} again` : `Stop ${title}`}
            onClick={() => setStopped(!stopped)}
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
