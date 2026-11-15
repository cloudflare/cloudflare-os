import { useState, useEffect, useRef } from 'react'
import { Text, Loader, Banner } from '@cloudflare/kumo'
import { Sparkle } from '@phosphor-icons/react'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import {
  GadgetClient,
  ConsoleLogEvent,
  MAX_FOCUS_ANCHOR_LENGTH,
  MAX_FOCUS_CONTEXT_LENGTH,
  MAX_FOCUS_LABEL_LENGTH,
  type GadgetFocus,
  type GadgetHost,
} from '@gadgets/workshop-shared/api'
import { prepareUiPage, uiModuleKey, type UiPage } from '@gadgets/workshop-shared/ui-page'
import { CAPNWEB_MODULE_URL, SANDBOX_HEAD } from './sandboxDocument'

// Unfortunately, we will have to embed the code as a data: URL, because our iframe is totally
// sandboxed. Even more unfortunately, since it's a module which we need to import from, we can't
// use the data URL as a <script> tag's source. Instead, we have to use it in an import statement.
// And, guess what? That import statement is going to appear in the runtime, which is *also* a
// data: URL, so we have a doubly-nested data: URL. We'll use base64 encoding for the inner
// data: and URL encoding for the outer, as this largely avoids double-escaping.
//
// The runtime is a module script placed before the gadget's entry. Module scripts run in document
// order, so what it sets up exists before any gadget module evaluates, even one the entry imports:
// for a legacy UI, its globals. It must stay synchronous: a top-level await would let the entry run
// first. For a UI that `callsMain`, the `gadget` and `host` stubs stay in the runtime's module
// scope, so they reach only the code `main()` hands them to.
const MISSING_MAIN = "client.js's default export has no main() function. Start the UI with " +
  '`export default { main(gadget) { ... } }`.'
const runtimeUrl = (callsMain: boolean) => `data:text/javascript;charset=utf-8,${encodeURIComponent(String.raw`import { RpcTarget, RpcStub, newMessagePortRpcSession } from "${CAPNWEB_MODULE_URL}";

// The main object of the frame's one RPC session with the page (GadgetFrameRoot), and its
// properties: the gadget's server-side Durable Object, and the page's GadgetHost.
let root, gadget, host;
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  root = newMessagePortRpcSession(port1);
  gadget = root.gadget;
  host = root.host;
}

// Settles a call to the page whose result the runtime ignores, so nothing stays held on either
// end. A failed call is dropped, since reporting it would make another call.
let notify = call => { call.then(() => {}, () => {}); };
${callsMain ? '' : `
globalThis.gadget = gadget;
globalThis.RpcTarget = RpcTarget;
globalThis.RpcStub = RpcStub;
`}

// Monkey-patch console to forward logs to the page.
for (let level of ['debug', 'info', 'log', 'warn', 'error']) {
  let original = console[level];
  console[level] = (...args) => {
    original.apply(console, args);
    try {
      let message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); }
        catch { return String(arg); }
      });
      notify(root.reportConsole(level, message));
    } catch {};
  };
}

// Allow user-activated target=_blank links, but block programmatic popups.
const blockedOpen = () => {
  console.error('window.open() is disabled in Gadget UIs. Use a link with target="_blank" instead.');
  return null;
};
window.open = blockedOpen;
globalThis.open = blockedOpen;
try {
  Window.prototype.open = blockedOpen;
} catch {}

// Forward Escape key presses to the page. The sandboxed iframe captures keydown events when it
// has focus, so the page never sees them. The workshop UI uses Escape to exit fullscreen gadget
// mode, so forward it explicitly.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') notify(root.escape());
}, true);

window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const anchor = event.target.closest('a[href][target]');
  if (!anchor || anchor.target.toLowerCase() !== '_blank') {
    return;
  }

  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  anchor.setAttribute('rel', Array.from(rel).join(' '));
}, true);

// Capture unhandled exceptions and promise rejections. The error listener captures because a
// module graph that fails to fetch fires a non-bubbling error only on its <script> element. An
// ErrorEvent's location is sent on its own because a SyntaxError's stack carries none; the parent
// names the file.
let reportError = (message, at) => notify(root.reportConsole('error', message, at));
window.addEventListener('error', (event) => {
  if (event instanceof ErrorEvent) {
    reportError(['Uncaught', event.error?.stack || event.message],
        { url: event.filename, line: event.lineno, column: event.colno });
  } else if (event.target instanceof HTMLScriptElement) {
    reportError(['Failed to load script'], { url: event.target.src });
  }
}, true);
window.addEventListener('unhandledrejection', (event) => {
  let reason = event.reason;
  reportError(['Unhandled promise rejection:', reason?.stack || String(reason)]);
});
${callsMain ? `
// The same module instance the entry's <script> loads. A main() that throws or rejects is reported
// as an unhandled rejection.
import(${JSON.stringify(uiModuleKey('client.js'))}).then(entry => {
  let main = entry.default?.main;
  if (typeof main !== 'function') {
    reportError([${JSON.stringify(MISSING_MAIN)}]);
    return;
  }
  return main.call(entry.default, gadget, host);
}, () => {
  // The entry's <script> element reports a module that fails to load or to evaluate.
});
` : ''}
//# sourceURL=gadget-runtime.js`)}`
const LEGACY_RUNTIME_URL = runtimeUrl(false)
const MAIN_RUNTIME_URL = runtimeUrl(true)

type Navigate = (anchor: string) => boolean | Promise<boolean>

// Why a reported focus is malformed, or undefined if it is well formed.
const focusProblem = (focus: unknown): string | undefined => {
  if (focus === null) return undefined
  if (typeof focus !== 'object' || Array.isArray(focus)) return 'it is not a GadgetFocus object or null'
  const { anchor, label, context } = focus as Record<string, unknown>
  if (typeof anchor !== 'string') return 'its anchor is not a string'
  if (anchor.length > MAX_FOCUS_ANCHOR_LENGTH) {
    return `its anchor is longer than ${MAX_FOCUS_ANCHOR_LENGTH} characters`
  }
  if (typeof label !== 'string') return 'its label is not a string'
  if (label.length > MAX_FOCUS_LABEL_LENGTH) return `its label is longer than ${MAX_FOCUS_LABEL_LENGTH} characters`
  if (context !== undefined && typeof context !== 'string') return 'its context is not a string'
  if (context !== undefined && context.length > MAX_FOCUS_CONTEXT_LENGTH) {
    return `its context is longer than ${MAX_FOCUS_CONTEXT_LENGTH} characters`
  }
  return undefined
}

// What one frame's host passes on to GadgetUI, once its arguments are checked.
type HostEvents = {
  reportFocus(focus: GadgetFocus | null): void
  // `navigate` is disposed when the call returns; keeping it means dup()ing it.
  onNavigate(navigate: RpcStub<Navigate>): Promise<void>
  // Tells the gadget's author (and the agent, which sees the frame's console) why a call was
  // ignored.
  reportProblem(message: string): void
}

// The Workshop as a gadget UI's host: one per frame. Gadget code is untrusted and the frontend has
// no capnweb-validate, so it checks its arguments by hand and drops a call it can't accept.
class WorkshopGadgetHost extends RpcTarget implements GadgetHost {
  readonly #events: HostEvents

  constructor(events: HostEvents) {
    super()
    this.#events = events
  }

  reportFocus(focus: unknown): void {
    const problem = focusProblem(focus)
    if (problem !== undefined) {
      this.#events.reportProblem(`host.reportFocus() ignored a focus because ${problem}.`)
      return
    }
    if (focus === null) {
      this.#events.reportFocus(null)
      return
    }
    // Copied, so that nothing but the three fields reaches the rest of the Workshop.
    const { anchor, label, context } = focus as GadgetFocus
    this.#events.reportFocus(context === undefined ? { anchor, label } : { anchor, label, context })
  }

  async onNavigate(navigate: unknown): Promise<void> {
    // A stub is a callable proxy, whatever it points at.
    if (typeof navigate !== 'function') {
      this.#events.reportProblem('host.onNavigate() ignored a registration that is not a function.')
      return
    }
    await this.#events.onNavigate(navigate as RpcStub<Navigate>)
  }
}

// What GadgetUI knows about the frame currently showing, through its host.
type FrameFocus = {
  // The anchor of the frame's last report, or null.
  lastReported: string | null
  // The anchors the frame has reported that the parent's anchor may yet change to: its last report,
  // and every one since the anchor last changed. The parent's anchor lags the reports (the URL is
  // written after a pause and rendered later still), so a report the frame has since moved on from
  // can still arrive, and is not a navigation.
  unacknowledged: Set<string>
  // Our duplicate of the frame's registered navigate callback.
  navigate: RpcStub<Navigate> | null
}

// Where a console call or uncaught error happened in the frame, as the browser reported it.
type ConsoleLocation = { url?: string; line?: number; column?: number }

// What the frame's runtime reports to the page, apart from anything gadget code calls.
type FrameEvents = {
  reportConsole(level: ConsoleLogEvent['level'], message: string[], at?: ConsoleLocation): void
  escape(): void
}

// The main object of the frame's RPC session. The frame reaches the gadget's server and the host
// through one session, so a capability passed between them never proxies through the frame. Its
// methods are the runtime's, which keeps the root out of gadget code's reach.
class GadgetFrameRoot extends RpcTarget {
  readonly #gadget: RpcTarget
  readonly #host: GadgetHost
  readonly #events: FrameEvents

  constructor(gadget: RpcTarget, host: GadgetHost, events: FrameEvents) {
    super()
    this.#gadget = gadget
    this.#host = host
    this.#events = events
  }

  get gadget() {
    return this.#gadget
  }

  get host() {
    return this.#host
  }

  reportConsole(level: ConsoleLogEvent['level'], message: string[], at?: ConsoleLocation) {
    this.#events.reportConsole(level, message, at)
  }

  escape() {
    this.#events.escape()
  }
}

const createSandboxedHtml = (page: UiPage): string => {
  return `<!DOCTYPE html>
<html>
<head>
  ${SANDBOX_HEAD}
  <script type="importmap">${page.importMap}</script>
</head>
<body>
    <script type="module" src="${page.callsMain ? MAIN_RUNTIME_URL : LEGACY_RUNTIME_URL}"></script>
    <script type="module" src="${page.entryUrl}"></script>
</body>
</html>`.trim()
}

/** The spot in the gadget the user is focused on, kept by the parent across frames. */
export type GadgetUIFocus = {
  /**
   * The spot to send the frame to: on registration, and whenever this changes to something the
   * frame did not itself report.
   */
  anchor: string | undefined
  /** The frame reported a focus. Null also clears an anchor that no longer resolves. */
  onFocusChange: (focus: GadgetFocus | null) => void
  /**
   * What the frame reported no longer stands: the frame was replaced, or is being sent to a spot it
   * did not report. The anchor still does: the frame is sent to it.
   */
  onFocusReset?: () => void
}

interface GadgetUIProps {
  gadget: RpcStub<GadgetClient>
  height: string
  reloadTrigger?: number
  isVisible?: boolean
  chatId?: number
  // Absent: the frame's reports are ignored and it is never navigated.
  focus?: GadgetUIFocus
  onConsoleLog?: (log: ConsoleLogEvent) => void
  // Fires when the user presses Escape while the gadget iframe has focus. Sandboxed iframes
  // capture keydown events, so we forward Escape explicitly from inside the iframe.
  onIframeEscape?: () => void
  // Reports whether the "No gadget UI yet" placeholder is showing: true only once a load has
  // confirmed the gadget has no UI, so a spinner or a not-yet-loaded view never counts.
  onNoUiChange?: (showsNoUi: boolean) => void
}

// How long to wait for a UI bundle before offering a retry instead of a spinner. Not a latency
// budget: the point at which we conclude the reply is never coming.
const UI_BUNDLE_LOAD_TIMEOUT_MS = 20_000
const RECONNECT_TIMEOUT_MS = 5_000

export default function GadgetUI(props: GadgetUIProps) {
  return <GadgetUISession key={props.chatId} {...props} />
}

function GadgetUISession({ gadget, height, reloadTrigger, isVisible = true, chatId, focus, onConsoleLog, onIframeEscape, onNoUiChange }: GadgetUIProps) {
  const [sandboxedHtml, setSandboxedHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // A connection failure is tied to the client it was tried on, so a replacement gets its own try.
  const [error, setError] = useState<{ message: string; stub?: RpcStub<GadgetClient> } | null>(null)
  const errorMessage = error && (error.stub ?? gadget) === gadget ? error.message : null
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isInvalidated, setIsInvalidated] = useState(false)
  const [iframeGeneration, setIframeGeneration] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const prevReloadTriggerRef = useRef(reloadTrigger)
  // Identifies the newest bundle load, so an older one can't write state after being superseded.
  const loadGenerationRef = useRef(0)
  // Bumped by the retry button to ask for a fresh load.
  const [retryNonce, setRetryNonce] = useState(0)
  const connectionGenerationRef = useRef(0)
  const handshakePendingRef = useRef<number | null>(null)
  const gadgetRef = useRef(gadget)
  gadgetRef.current = gadget
  // TODO: Remove `any` when Cap'n Web fixes cyclic type issues (RpcStub<any> triggers deep instantiation)
  const gadgetStubRef = useRef<any>(null)
  const pendingGadgetStubRef = useRef<{
    promise: Promise<any>
    resolve: (stub: any) => void
    reject: (reason: unknown) => void
  } | null>(null)
  const rpcSessionRef = useRef<any>(null)
  // Each module's path by its data: URL, for naming the file in errors the iframe forwards.
  const pathsByUrlRef = useRef(new Map<string, string>())
  // Keep latest callbacks in refs so the message-handler effect never tears down the RPC session.
  const onIframeEscapeRef = useRef(onIframeEscape)
  const onConsoleLogRef = useRef(onConsoleLog)
  onIframeEscapeRef.current = onIframeEscape
  onConsoleLogRef.current = onConsoleLog
  const onNoUiChangeRef = useRef(onNoUiChange)
  onNoUiChangeRef.current = onNoUiChange
  const focusRef = useRef(focus)
  focusRef.current = focus
  // Null between frames, and until the frame's session opens.
  const frameFocusRef = useRef<FrameFocus | null>(null)
  // Bumped by every report, every navigate call and every frame replacement. A navigate that fails
  // clears the anchor only if nothing has bumped it since: by then the user has moved on, or the
  // failure is only the replaced frame's session ending.
  const focusEpochRef = useRef(0)

  const reportFocusProblem = (message: string) => {
    onConsoleLogRef.current?.({ timestamp: new Date(), level: 'error', message: [message] })
  }

  // The frame is gone, or about to be: drop what it told us.
  const endFrameFocus = () => {
    const frame = frameFocusRef.current
    if (!frame) return
    frameFocusRef.current = null
    ++focusEpochRef.current
    frame.navigate?.[Symbol.dispose]()
    focusRef.current?.onFocusReset?.()
  }

  const sendNavigate = async (frame: FrameFocus, navigate: RpcStub<Navigate>, anchor: string) => {
    const epoch = ++focusEpochRef.current
    let resolved: boolean
    try {
      const result: unknown = await navigate(anchor)
      // Anything but false counts as resolved: a UI that forgets to return a result shouldn't lose
      // the user's place.
      resolved = result !== false
      // A gadget that returns an object or a stub by mistake mustn't leave it held for the session.
      if ((typeof result === 'object' && result !== null) || typeof result === 'function') {
        (result as Partial<Disposable>)[Symbol.dispose]?.()
      }
    } catch (caught) {
      resolved = false
      if (epoch === focusEpochRef.current) {
        reportFocusProblem(`host.onNavigate()'s callback failed: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
    if (resolved || epoch !== focusEpochRef.current) return
    frame.lastReported = null
    frame.unacknowledged.clear()
    focusRef.current?.onFocusChange(null)
  }

  const createHost = (frame: FrameFocus) => new WorkshopGadgetHost({
    reportFocus: reported => {
      const current = focusRef.current
      if (frameFocusRef.current !== frame || !current) return
      ++focusEpochRef.current
      frame.lastReported = reported?.anchor ?? null
      if (reported) frame.unacknowledged.add(reported.anchor)
      current.onFocusChange(reported)
    },
    onNavigate: async navigate => {
      if (frameFocusRef.current !== frame || !focusRef.current) return
      frame.navigate?.[Symbol.dispose]()
      const retained = navigate.dup()
      frame.navigate = retained
      const anchor = focusRef.current.anchor
      if (anchor !== undefined) await sendNavigate(frame, retained, anchor)
    },
    reportProblem: reportFocusProblem,
  })

  // A pasted link, say. The frame's own reports come back through the URL, and aren't echoed.
  const anchor = focus?.anchor
  useEffect(() => {
    // Any change of target supersedes a pending navigate, even one that is only the frame's own
    // report coming back.
    ++focusEpochRef.current
    const frame = frameFocusRef.current
    if (!frame) return
    const echo = anchor !== undefined && frame.unacknowledged.has(anchor)
    frame.unacknowledged = new Set(frame.lastReported === null ? [] : [frame.lastReported])
    if (anchor === undefined || !frame.navigate || echo) return
    // What the frame last reported is the spot it is leaving, and it may never report the new one.
    focusRef.current?.onFocusReset?.()
    void sendNavigate(frame, frame.navigate, anchor)
  }, [anchor])

  // A code change invalidates the view without clearing `hasLoaded`, so the previous load's "no UI"
  // result must not keep counting while the replacement load is pending.
  const showsNoUi = hasLoaded && !isInvalidated && !loading && !error && !sandboxedHtml
  useEffect(() => {
    if (!showsNoUi) return
    onNoUiChangeRef.current?.(true)
    return () => onNoUiChangeRef.current?.(false)
  }, [showsNoUi])

  const suspendGadgetCalls = () => {
    if (!pendingGadgetStubRef.current) {
      let resolve!: (stub: any) => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<any>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      void promise.catch(() => {})
      pendingGadgetStubRef.current = { promise, resolve, reject }
    }
    return pendingGadgetStubRef.current
  }

  const installGadgetStub = (stub: any) => {
    gadgetStubRef.current = stub
    stub.onRpcBroken?.(() => {
      if (gadgetStubRef.current === stub) suspendGadgetCalls()
    })
  }

  const resetConnection = (reason: unknown) => {
    endFrameFocus()
    ++connectionGenerationRef.current
    handshakePendingRef.current = null
    pendingGadgetStubRef.current?.reject(reason)
    pendingGadgetStubRef.current = null
    gadgetStubRef.current?.[Symbol.dispose]?.()
    gadgetStubRef.current = null
    rpcSessionRef.current?.[Symbol.dispose]?.()
    rpcSessionRef.current = null
  }

  const reloadIframe = (reason: unknown) => {
    resetConnection(reason)
    setIframeGeneration(generation => generation + 1)
  }

  useEffect(() => {
    if (!rpcSessionRef.current) {
      if (handshakePendingRef.current !== null) {
        reloadIframe(new Error('Gadget changed during RPC handshake.'))
      }
      return
    }

    const generation = ++connectionGenerationRef.current
    const isCurrent = () => generation === connectionGenerationRef.current
    const pendingStub = suspendGadgetCalls()
    const replacementPromise = Promise.resolve().then(() => gadget.connectToGadget(chatId))
    void replacementPromise.then(stub => {
      if (!isCurrent()) stub[Symbol.dispose]?.()
    }, () => {})

    const reconnect = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        // A pipelined client resolves only once the connection is back and the workspace reopened.
        // The budget is for the gadget's own answer, not for the outage before it.
        await gadget
        const replacementStub = await Promise.race([
          replacementPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Timed out reconnecting gadget UI.')), RECONNECT_TIMEOUT_MS)
          }),
        ])
        if (!isCurrent()) return
        const oldStub = gadgetStubRef.current
        installGadgetStub(replacementStub)
        pendingStub.resolve(replacementStub)
        if (pendingGadgetStubRef.current === pendingStub) pendingGadgetStubRef.current = null
        oldStub?.[Symbol.dispose]?.()
      } catch (caught) {
        if (isCurrent()) reloadIframe(caught)
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    }
    void reconnect()
  }, [gadget, chatId])

  // Effect to handle reloadTrigger changes (code changes)
  useEffect(() => {
    // Only react if reloadTrigger has actually changed from the previous value
    if (reloadTrigger !== undefined && reloadTrigger !== prevReloadTriggerRef.current && reloadTrigger > 0) {
      // The frame is replaced (or dropped, if hidden) now, though its session closes only once the
      // next frame connects.
      endFrameFocus()
      // Mark as invalidated but don't reload unless visible
      setIsInvalidated(true)
      // After a failed load the view is still invalidated, so the flag alone wouldn't reload it.
      setRetryNonce(nonce => nonce + 1)
      if (!isVisible) {
        // If not visible, just clear the current state
        setSandboxedHtml(null)
        setHasLoaded(false)
        setError(null)
      }
      // Update the ref to the current value
      prevReloadTriggerRef.current = reloadTrigger
    }
  }, [reloadTrigger, isVisible])

  // Effect to load UI bundle when component becomes visible for the first time or when invalidated
  useEffect(() => {
    // Only load if:
    // 1. Component is visible AND
    // 2. Either never loaded before OR invalidated due to code changes
    if (!isVisible || (hasLoaded && !isInvalidated)) {
      return
    }

    // Superseded loads are ignored by generation rather than by a per-run `cancelled` flag: a run
    // cancelled mid-call would skip its own `setLoading(false)`, leaving the spinner up with
    // nothing to clear it. Comparing generations means the newest run always owns the flag.
    const generation = ++loadGenerationRef.current
    const isCurrent = () => loadGenerationRef.current === generation

    // A dropped RPC never settles -- e.g. the stub was disposed under us by a reconnect -- and there
    // is nothing to catch. Rather than spin indefinitely, stop owning the load and offer a retry: the
    // call is idempotent, and a button is a far better answer than a spinner that never resolves.
    const giveUp = setTimeout(() => {
      if (!isCurrent()) return
      loadGenerationRef.current++      // so a late reply can no longer write state
      setLoading(false)
      setError({ message: 'Timed out loading this view.' })
    }, UI_BUNDLE_LOAD_TIMEOUT_MS)

    const loadUiBundle = async () => {
      try {
        setLoading(true)
        setError(null)

        const bundle = await gadget.getUiBundle(chatId)
        if (!isCurrent()) return
        if (bundle) {
          const page = prepareUiPage(bundle, CAPNWEB_MODULE_URL)
          pathsByUrlRef.current = page.pathsByUrl
          setSandboxedHtml(createSandboxedHtml(page))
        } else {
          setSandboxedHtml(null)
        }
        // A failed load stays unloaded, so a replacement gadget client retries it.
        setHasLoaded(true)
        setIsInvalidated(false)
      } catch (err) {
        if (!isCurrent()) return
        console.error('Failed to load UI bundle:', err)
        // Includes imports that break the rules for UI code, so the agent needs to see it.
        const message = err instanceof Error ? err.message : 'Failed to load UI bundle'
        onConsoleLogRef.current?.({ timestamp: new Date(), level: 'error', message: [message] })
        setError({ message })
      } finally {
        if (isCurrent()) setLoading(false)
        clearTimeout(giveUp)
      }
    }

    loadUiBundle()
    return () => {
      clearTimeout(giveUp)
      // Dependencies can change without starting a replacement load (most importantly when the
      // view becomes hidden). Revoke this run explicitly so its late reply cannot populate state
      // for a different gadget, chat, or visibility lifecycle.
      if (isCurrent()) loadGenerationRef.current++
    }
  // LSP reports an error here, but tsc does not.
  // The LSP error is due to bugs that need to be fixed in Cap'n Web.
  }, [gadget, isVisible, hasLoaded, isInvalidated, chatId, retryNonce])

  // Reads its callbacks through refs, so the handshake effect never tears down the RPC session.
  const frameEvents: FrameEvents = {
    reportConsole: (level, message, at) => {
      let location: string | undefined
      if (at?.url) {
        // Chrome names a module by its sourceURL; other browsers may give its data: URL. One not
        // in the bundle, like the runtime's, can embed hundreds of KB, so it isn't echoed whole.
        const path = pathsByUrlRef.current.get(at.url) ??
          (at.url.startsWith('data:') ? `${at.url.slice(0, 40)}…` : at.url)
        location = at.line ? `${path}:${at.line}:${at.column}` : path
      }
      onConsoleLogRef.current?.({
        timestamp: new Date(),
        level,
        message: location ? [...message, `at ${location}`] : message,
      })
    },
    escape: () => onIframeEscapeRef.current?.(),
  }

  // Effect to handle iframe RPC handshake
  useEffect(() => {
    let cancelled = false

    const handleMessage = async (event: MessageEvent) => {
      // Only handle messages from our iframe. As an extra level of paranoia, also make sure it's
      // from the null origin, just in case somehow the frame managed to browse away (though that
      // should be blocked). Yes, the null origin is identified by the string value "null", not the
      // JS `null`.
      if (event.source !== iframeRef.current?.contentWindow ||
          event.origin !== "null") {
        return
      }

      if (event.data === 'handshake' && event.ports && event.ports[0]) {
        const port = event.ports[0]
        const client = gadgetRef.current
        let gadgetStub: any = null
        resetConnection(new Error('Gadget iframe reloaded.'))
        const generation = connectionGenerationRef.current
        handshakePendingRef.current = generation
        const isCurrent = () => !cancelled &&
          generation === connectionGenerationRef.current &&
          event.source === iframeRef.current?.contentWindow
        try {
          // Open the RPC connection to the gadget's server side
          gadgetStub = await client.connectToGadget(chatId)
          if (!isCurrent()) {
            gadgetStub[Symbol.dispose]?.()
            port.close()
            return
          }
          installGadgetStub(gadgetStub)
          // Redirectable target: swapping gadgetStubRef reconnects top-level calls without reloading.
          const forwardingTarget = new Proxy(new RpcTarget() as any, {
            get: (target, property, receiver) => {
              if (typeof property === 'symbol' || property in target) {
                return Reflect.get(target, property, receiver)
              }
              const pending = pendingGadgetStubRef.current
              return pending
                ? (...args: any[]) => pending.promise.then(stub => stub[property](...args))
                : gadgetStubRef.current[property]
            },
          })
          const frame: FrameFocus = { lastReported: null, unacknowledged: new Set(), navigate: null }
          frameFocusRef.current = frame
          rpcSessionRef.current = newMessagePortRpcSession(
              port, new GadgetFrameRoot(forwardingTarget, createHost(frame), frameEvents))
        } catch (caught) {
          gadgetStub?.[Symbol.dispose]?.()
          port.close()
          if (!isCurrent()) return
          console.error('Failed to establish RPC connection:', caught)
          setError({ message: 'Failed to connect gadget to server', stub: client })
        } finally {
          if (handshakePendingRef.current === generation) handshakePendingRef.current = null
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      cancelled = true
      window.removeEventListener('message', handleMessage)
      resetConnection(new Error('Gadget RPC session was closed.'))
    }
  }, [])

  if (!isVisible && !hasLoaded) {
    // Don't render anything if not visible and never loaded
    return (
      <div
        className="flex items-center justify-center text-kumo-subtle"
        style={{ height }}
      >
        <Text variant="secondary">
          Switch to this tab to load the Gadget UI
        </Text>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <Loader size="lg" />
      </div>
    )
  }

  if (errorMessage) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px'
      }}>
        <Banner
          variant="error"
          title="Error"
          description={errorMessage}
          action={
            <Banner.Action
              onClick={() => {
                setError(null)
                setHasLoaded(false)
                setIsInvalidated(false)
                setRetryNonce(n => n + 1)
              }}
            >
              Try again
            </Banner.Action>
          }
        />
      </div>
    )
  }

  if (!sandboxedHtml) {
    return (
      <div
        className="relative overflow-hidden bg-kumo-base"
        style={{
          height,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          className="themed-accent-glow absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none"
          style={{
            filter: 'blur(18px)',
          }}
        />

        <div className="relative flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <div className="themed-user-bubble-shadow flex h-12 w-12 items-center justify-center rounded-xl border border-kumo-line bg-kumo-elevated text-kumo-subtle">
            <Sparkle size={22} weight="regular" />
          </div>
          <div className="space-y-1">
            <h2 className="text-[20px] leading-7 font-normal tracking-[-0.45px] text-kumo-default">
              No gadget UI yet
            </h2>
            <p className="text-[15px] leading-5 font-normal tracking-[-0.3px] text-kumo-subtle">
              When the gadget builds one, it will appear here.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height, width: '100%' }}>
      <iframe
        key={`${reloadTrigger}:${iframeGeneration}`}
        ref={iframeRef}
        srcDoc={sandboxedHtml}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          border: 'none'
        }}
        sandbox="allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
        title="Gadget UI"
      />
    </div>
  )
}
