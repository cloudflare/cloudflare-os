import { useState, useEffect, useRef } from 'react'
import { Text, Loader, Banner } from '@cloudflare/kumo'
import { Sparkle } from '@phosphor-icons/react'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { GadgetClient, ConsoleLogEvent } from '@gadgets/workshop-shared/api'

// We want to inject Cap'n Web into the Gadget. Luckily it has no dependencies, so we can just take
// the whole module and embed it. We can import the module using ?raw to get a string of the
// content.
import CAPNWEB_BUNDLE from 'capnweb?raw'

// btoa() below requires this to stay ASCII; capnweb's build enforces ASCII-only dist bundles
// since 0.11.1.
let CAPNWEB_BUNDLE_ANNOTATED = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`

// Unfortunately, we will have to embed the code as a data: URL, because our iframe is totally
// sandboxed. Even more unfortunately, since it's a module which we need to import from, we can't
// use the data URL as a <script> tag's source. Instead, we have to use it in an import statement.
// And, guess what? That import statement is going to appear in code which is *also* embedded in
// a data: URL, so we have a doubly-nested data: URL. We'll use base64 encoding for the inner
// data: and URL encoding for the outer, as this largely avoids double-escaping.
//
// In any case, we'll prefix the gadget code with this prefix which imports the Cap'n Web library
// (from a massive data URL) and sets up the RPC connection to the parent.
let INJECTED_CODE_PREFIX = encodeURIComponent(String.raw`//# sourceURL=client.js
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_BUNDLE_ANNOTATED)}";

let gadget;  // RPC stub to the gadget's server-side Durable Object.
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
}

// Monkey-patch console to forward logs to the parent frame.
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
      window.parent.postMessage({ type: 'console', level, message }, '*');
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

// Forward Escape key presses to the parent frame. The sandboxed iframe captures keydown events
// when it has focus, so the parent never sees them. The workshop UI uses Escape to exit fullscreen
// gadget mode, so forward it explicitly.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.parent.postMessage({ type: 'escape' }, '*');
  }
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

// Capture unhandled exceptions and promise rejections.
window.addEventListener('error', (event) => {
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Uncaught', event.error?.stack || event.message],
  }, '*');
});
window.addEventListener('unhandledrejection', (event) => {
  let reason = event.reason;
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Unhandled promise rejection:', reason?.stack || String(reason)],
  }, '*');
});

`);

const createSandboxedHtml = (jsCode: string): string => {
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
</head>
<body>
    <script type="module" src="data:text/javascript;charset=utf-8,${INJECTED_CODE_PREFIX}${encodeURIComponent(jsCode)}"></script>
</body>
</html>`.trim()
}

interface GadgetUIProps {
  gadget: RpcStub<GadgetClient>
  height: string
  reloadTrigger?: number
  isVisible?: boolean
  chatId?: number
  onConsoleLog?: (log: ConsoleLogEvent) => void
  // Fires when the user presses Escape while the gadget iframe has focus. Sandboxed iframes
  // capture keydown events, so we forward Escape explicitly from inside the iframe.
  onIframeEscape?: () => void
}

// How long to wait for a UI bundle before offering a retry instead of a spinner. Not a latency
// budget: the point at which we conclude the reply is never coming.
const UI_BUNDLE_LOAD_TIMEOUT_MS = 20_000
const RECONNECT_TIMEOUT_MS = 5_000

export default function GadgetUI(props: GadgetUIProps) {
  return <GadgetUISession key={props.chatId} {...props} />
}

function GadgetUISession({ gadget, height, reloadTrigger, isVisible = true, chatId, onConsoleLog, onIframeEscape }: GadgetUIProps) {
  const [sandboxedHtml, setSandboxedHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  // Keep latest callbacks in refs so the message-handler effect never tears down the RPC session.
  const onIframeEscapeRef = useRef(onIframeEscape)
  const onConsoleLogRef = useRef(onConsoleLog)
  onIframeEscapeRef.current = onIframeEscape
  onConsoleLogRef.current = onConsoleLog

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
      // Mark as invalidated but don't reload unless visible
      setIsInvalidated(true)
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
      setError('Timed out loading this view.')
    }, UI_BUNDLE_LOAD_TIMEOUT_MS)

    const loadUiBundle = async () => {
      try {
        setLoading(true)
        setError(null)

        const bundle = await gadget.getUiBundle(chatId)
        if (!isCurrent()) return
        if (bundle) {
          const html = createSandboxedHtml(bundle.jsCode)
          setSandboxedHtml(html)
        } else {
          setSandboxedHtml(null)
        }
        setHasLoaded(true)
        setIsInvalidated(false)
      } catch (err) {
        if (!isCurrent()) return
        console.error('Failed to load UI bundle:', err)
        setError('Failed to load UI bundle')
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
        let gadgetStub: any = null
        resetConnection(new Error('Gadget iframe reloaded.'))
        const generation = connectionGenerationRef.current
        handshakePendingRef.current = generation
        const isCurrent = () => !cancelled &&
          generation === connectionGenerationRef.current &&
          event.source === iframeRef.current?.contentWindow
        try {
          // Open the RPC connection to the gadget's server side
          gadgetStub = await gadgetRef.current.connectToGadget(chatId)
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
          rpcSessionRef.current = newMessagePortRpcSession(port, forwardingTarget)
        } catch (caught) {
          gadgetStub?.[Symbol.dispose]?.()
          port.close()
          if (!isCurrent()) return
          console.error('Failed to establish RPC connection:', caught)
          setError('Failed to connect gadget to server')
        } finally {
          if (handshakePendingRef.current === generation) handshakePendingRef.current = null
        }
      } else if (event.data?.type === 'console' && onConsoleLogRef.current) {
        onConsoleLogRef.current({
          timestamp: new Date(),
          level: event.data.level,
          message: event.data.message,
        })
      } else if (event.data?.type === 'escape') {
        onIframeEscapeRef.current?.()
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

  if (error) {
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
          description={error}
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
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        title="Gadget UI"
      />
    </div>
  )
}
