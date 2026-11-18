import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { AppWindowIcon, PaperPlaneRightIcon, PlayIcon, StopIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { newMessagePortRpcSession, type RpcStub } from 'capnweb'
import { Button } from '@/components/Button'
import { ShimmerText } from '@/components/ShimmerText'
import {
  INLINE_VIEW_HANDSHAKE,
  InlineViewHostImpl,
  inlineViewPageStart,
  inlineViewShell,
  readInlineViewTheme,
  type InlineViewFrame,
} from './inlineViewFrame'

export type InlineViewProps = {
  /** What the agent wrote between the tags. */
  html: string
  /** The text of its `<title>`, which names it. */
  title?: string
  /** Why it must not run, such as that it has nothing in it. */
  error?: string
  /**
   * Sends a message the view suggested, as the viewer's own, once they click Send. Resolves to
   * whether it went: one that did not stays, to try again. Without it the view cannot suggest one.
   */
  onSend?: (message: string) => Promise<boolean>
}

// Its room before it says how tall it is, and the most it takes: a view taller than that scrolls
// within itself.
const MIN_HEIGHT = 40
const MAX_HEIGHT = 720

// The app's theme, which `index.html` keeps on the root as it changes.
const subscribeMode = (onChange: () => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
  return () => observer.disconnect()
}
const readMode = () => document.documentElement.dataset.mode

/** A message the view asked to send, waiting for the viewer, and whether Send is under way. */
type Suggestion = { message: string; sending: boolean }

/**
 * A live view the agent drew in its answer: what it wrote, run in a frame sandboxed with no origin
 * that can load and reach nothing, as tall as what it draws. Under it, quietly, what it is and
 * the way to stop it. What it suggests sending (`agent.send()`) waits under it for the viewer's
 * Send, and goes as though they had written it.
 */
export const InlineView = ({ html, title, error, onSend }: InlineViewProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [stopped, setStopped] = useState(false)
  const [height, setHeight] = useState(MIN_HEIGHT)
  // The latest uncaught error in its code. The view keeps running.
  const [codeError, setCodeError] = useState<string>()
  const [suggestion, setSuggestion] = useState<Suggestion>()
  const mode = useSyncExternalStore(subscribeMode, readMode)
  const frame = useRef<RpcStub<InlineViewFrame>>(undefined)
  const live = error === undefined && !stopped

  useEffect(() => {
    if (!live) return
    // What a load asked for needs the page that asked, and an error the page that threw it.
    const disconnect = () => {
      frame.current?.[Symbol.dispose]()
      frame.current = undefined
      setSuggestion(undefined)
      setCodeError(undefined)
    }
    // Each load of the frame's page, its first or one its own code started, says so once, and is
    // given the view from the start in a session of its own.
    const connect = (event: MessageEvent) => {
      // Only this view's frame, still at its opaque origin, which the browser gives as "null".
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== 'null') return
      const [port] = event.ports
      if (event.data !== INLINE_VIEW_HANDSHAKE || !port) return
      disconnect()
      const session = newMessagePortRpcSession<InlineViewFrame>(port, new InlineViewHostImpl({
        onMessageRequest: (message) => setSuggestion({ message, sending: false }),
        onResize: (reported) => setHeight(Math.min(Math.max(reported, MIN_HEIGHT), MAX_HEIGHT)),
        onError: setCodeError,
      }))
      frame.current = session
      // Each call settled, so that capnweb lets go of it; one fails only once the frame has gone.
      session.write(inlineViewPageStart(readInlineViewTheme())).catch(() => {})
      session.write(html).catch(() => {})
      session.close().catch(() => {})
    }
    window.addEventListener('message', connect)
    return () => {
      window.removeEventListener('message', connect)
      disconnect()
    }
  }, [live, html])
  useEffect(() => {
    frame.current?.setTheme(readInlineViewTheme()).catch(() => {})
  }, [mode])

  const send = async () => {
    if (!suggestion || suggestion.sending || !onSend) return
    const { message } = suggestion
    setSuggestion({ message, sending: true })
    // The view may ask again meanwhile; what it asked for last stays.
    const sent = await onSend(message).catch(() => false)
    setSuggestion((current) => (current?.message !== message ? current : sent ? undefined : { message, sending: false }))
  }

  const name = title ?? 'Live view'
  return (
    <div className="flex flex-col">
      {error !== undefined ? (
        <p className="flex items-center gap-2 px-4 pt-3 text-sm/5 text-kumo-danger">
          <WarningCircleIcon aria-hidden="true" className="size-4 shrink-0" />
          {error}
        </p>
      ) : !stopped && (
        // Inset as far as a message's words are, less the frame's own padding. Its height glides
        // to what the view says, so that the conversation does not jump as it draws.
        <div className="px-4 pt-4 pb-1">
          <div className="-m-1 transition-[height] duration-200 ease-out motion-reduce:transition-none" style={{ height }}>
            <ViewFrame ref={iframeRef} title={name} />
          </div>
        </div>
      )}
      {codeError !== undefined && <p className="px-4 pt-1 text-sm/5 wrap-anywhere text-kumo-danger">{codeError}</p>}
      {/* The app's chrome, which the view cannot draw: what it is, and where it ends. */}
      <div className="flex min-h-9 items-center gap-1.5 ps-4 pe-1.5 text-xs text-kumo-subtle">
        <AppWindowIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{stopped ? `${name} · stopped` : name}</span>
        {error === undefined && (
          <Button
            variant="ghost"
            icon={stopped ? PlayIcon : StopIcon}
            aria-label={stopped ? `Run ${name} again` : `Stop ${name}`}
            title={stopped ? 'Run again' : 'Stop'}
            onClick={() => setStopped(!stopped)}
            className="size-7 text-kumo-subtle hover:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3.5"
          />
        )}
      </div>
      <div aria-live="polite">
        {suggestion && onSend && (
          <SuggestedMessage
            message={suggestion.message}
            sending={suggestion.sending}
            onSend={() => void send()}
            onDismiss={() => setSuggestion(undefined)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * One load of a view's frame. Its shell starts in the theme of the moment it mounts, so one run
 * again after the theme changed starts in the new one; `setTheme` keeps it current after that.
 */
const ViewFrame = ({ ref, title }: { ref: RefObject<HTMLIFrameElement | null>; title: string }) => {
  const [srcDoc] = useState(() => inlineViewShell(readInlineViewTheme()))
  return <iframe ref={ref} srcDoc={srcDoc} title={title} sandbox="allow-scripts" className="block h-full w-full border-0" />
}

type SuggestedMessageProps = { message: string; sending: boolean; onSend: () => void; onDismiss: () => void }

/** What a view asked to send, on a surface of its own under it, until the viewer sends it or puts it away. */
const SuggestedMessage = ({ message, sending, onSend, onDismiss }: SuggestedMessageProps) => (
  // 21px corners less a 5px inset leave 16px, as a tile's in a bubble.
  <div role="group" aria-label="Message to send" className="arrives m-[5px] mt-0 flex flex-col gap-2 rounded-2xl bg-kumo-tint p-3 ps-4">
    <p className="flex items-center gap-1.5 text-xs text-kumo-subtle">
      <PaperPlaneRightIcon aria-hidden="true" className="size-3.5" />
      The view suggests sending
    </p>
    {/* A keyboard user has to be able to scroll a long one to read it all. */}
    <p tabIndex={0} className="max-h-32 overflow-y-auto text-base/5 whitespace-pre-wrap wrap-anywhere text-kumo-default">{message}</p>
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" disabled={sending} onClick={onDismiss}>Dismiss</Button>
      <Button variant="primary" icon={PaperPlaneRightIcon} disabled={sending} onClick={onSend}>Send</Button>
    </div>
  </div>
)

export type InlineViewDraftProps = {
  title?: string
  /** Its block is still being written. */
  drawing?: boolean
}

/**
 * A view in a reply that is still being drafted: what it is called, said calmly, as it is drawn
 * only once the reply is a message. Nothing of what the agent is writing runs or shows yet.
 */
export const InlineViewDraft = ({ title, drawing }: InlineViewDraftProps) => (
  <div className="flex items-center gap-2 rounded-2xl px-3 py-2.5 text-sm/5 text-kumo-subtle ring-1 ring-kumo-line ring-inset">
    <AppWindowIcon aria-hidden="true" className="size-4 shrink-0" />
    <span className="min-w-0 flex-1 truncate">{title ?? 'A live view'}</span>
    <ShimmerText active={drawing} className="shrink-0 text-xs">{drawing ? 'Drawing…' : 'Shown with the reply'}</ShimmerText>
  </div>
)
