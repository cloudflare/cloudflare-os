// The frame of a live view in an answer (an `<inline-html>` block, see plans/live-views.md): the
// page it runs, and the Cap'n Web interfaces between it and the app. Ported from
// workshop-frontend's `uiBlockFrame`. What the agent wrote is reviewed by nobody, so the frame
// has the gadget UI's sandbox and only what `InlineViewHost` offers.
import { RpcTarget } from 'capnweb'
import { CAPNWEB_MODULE_URL, SANDBOX_HEAD } from '@/components/sandboxPage'

/** The app's theme, as a view's frame applies it. */
export type InlineViewTheme = {
  scheme: 'light' | 'dark'
  /** Theme values by custom property name, e.g. `--color-kumo-base` or `--font-sans`. */
  tokens: Record<string, string>
}

/** What a view's frame may call on the app, through the session its handshake opens. */
export interface InlineViewHost {
  /**
   * Asks the viewer to send `message` to the chat as their own. It is shown under the view, and
   * sent only once the viewer clicks Send. A newer request replaces it.
   */
  requestMessage(message: string): void
  /** Reports the height of the view's content, in CSS pixels. */
  resize(height: number): void
  /** Reports an uncaught error in the view's code. */
  reportError(message: string): void
}

/** What the app may call on a view's frame. */
export interface InlineViewFrame {
  /** Applies another theme, as when the system goes dark. */
  setTheme(theme: InlineViewTheme): void
  /**
   * Adds `html` to the end of the view's page, which the browser parses as it arrives. The first
   * call starts the page, so it takes `inlineViewPageStart`.
   */
  write(html: string): void
  /** Ends the page once the block has closed, which runs its module scripts. */
  close(): void
}

/** What a view's frame posts with the port it is to be connected through. */
export const INLINE_VIEW_HANDSHAKE = 'handshake'

// The names a view can use, which the agent's instructions list (workshop-backend's agent.ts).
// The fonts are installed ones the app never downloads, so the frame's CSP does not block them.
const THEME_TOKENS = [
  '--color-kumo-base',
  '--color-kumo-elevated',
  '--color-kumo-line',
  '--text-color-kumo-default',
  '--text-color-kumo-subtle',
  '--color-kumo-brand',
  '--color-kumo-success',
  '--color-kumo-warning',
  '--color-kumo-danger',
  '--font-sans',
  '--font-mono',
] as const

/**
 * The app's theme as it is now, from the root `index.html` keeps it on. A value may be a
 * `light-dark()` pair, which the frame resolves by its own `color-scheme`.
 */
export const readInlineViewTheme = (): InlineViewTheme => {
  const root = document.documentElement
  const style = getComputedStyle(root)
  return {
    scheme: root.dataset.mode === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()])),
  }
}

/** What a view's host does for the block it is drawn in. */
export type InlineViewHostOptions = {
  onMessageRequest: (message: string) => void
  onResize: (height: number) => void
  onError: (message: string) => void
}

/**
 * The app's end of a view's session. The view's code runs in the bootstrap's realm and can reach
 * its port, so what each call passes is checked.
 */
export class InlineViewHostImpl extends RpcTarget implements InlineViewHost {
  readonly #options: InlineViewHostOptions

  constructor(options: InlineViewHostOptions) {
    super()
    this.#options = options
  }

  requestMessage(message: string): void {
    if (typeof message !== 'string' || message.trim() === '') throw new TypeError('agent.send() takes the message to send.')
    this.#options.onMessageRequest(message)
  }

  resize(height: number): void {
    if (typeof height === 'number' && Number.isFinite(height)) this.#options.onResize(height)
  }

  reportError(message: string): void {
    this.#options.onError(String(message))
  }
}

// Runs in the frame's shell before any of the view's code, which arrives later by `write`. The
// first write opens a new page, which keeps this window, its globals, the port and the CSP, and
// drops the shell's nodes and every listener on the document and the window.
const BOOTSTRAP_URL = `data:text/javascript;charset=utf-8,${encodeURIComponent(String.raw`//# sourceURL=inline-view-bootstrap.js
import { RpcTarget, newMessagePortRpcSession } from "${CAPNWEB_MODULE_URL}";

const applyTheme = ({ scheme, tokens }) => {
  const root = document.documentElement.style;
  root.colorScheme = scheme;
  for (const [name, value] of Object.entries(tokens)) root.setProperty(name, value);
};

// Chromium runs a module script inside close(), and puts this before the message of an error the
// script throws at once.
const CLOSE_ERROR = "Failed to execute 'close' on 'Document': ";

// The bootstrap's own calls are settled, so that capnweb lets go of them.
const reportError = message => {
  message = String(message);
  host.reportError(message.startsWith(CLOSE_ERROR) ? message.slice(CLOSE_ERROR.length) : message).catch(() => {});
};
const reportHeight = () => host.resize(Math.ceil(document.body.getBoundingClientRect().height)).catch(() => {});

let started = false;
class Frame extends RpcTarget {
  setTheme(theme) { applyTheme(theme); }
  write(html) {
    const first = !started;
    if (first) {
      started = true;
      document.open();
      window.addEventListener("error", event => reportError(event.error?.message ?? event.message));
      window.addEventListener("unhandledrejection", event => reportError(event.reason?.message ?? event.reason));
    }
    document.write(html);
    if (first) new ResizeObserver(reportHeight).observe(document.body);
  }
  close() { document.close(); }
}

// The shell's load event, if still to come, would fire in the page the first write opens.
if (document.readyState !== "complete") await new Promise(resolve => addEventListener("load", resolve, { once: true }));
const { port1, port2 } = new MessageChannel();
window.parent.postMessage("${INLINE_VIEW_HANDSHAKE}", "*", [port2]);
const host = newMessagePortRpcSession(port1, new Frame());

// send() settles its call here and returns a plain promise, so a handler that ignores it leaves
// nothing held on either end. A refused message still rejects it.
globalThis.agent = Object.freeze({
  send: async message => { await host.requestMessage(message); },
});
`)}`

const themeStyle = ({ scheme, tokens }: InlineViewTheme) =>
  `:root { color-scheme: ${scheme}; ${Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(' ')} }`

// The head of both the shell and the view's page: the sandbox, the theme, and what fits the view
// into the answer. The body's padding keeps a child's margin inside the measured height and focus
// rings inside the frame, which the block widens to match; its own formatting context keeps
// floats in. The text is the app's.
const frameHead = (theme: InlineViewTheme) => `${SANDBOX_HEAD}
  <style>
    ${themeStyle(theme)}
    html, body { margin: 0; height: auto; background: transparent; }
    body {
      display: flow-root; padding: 4px; color: var(--text-color-kumo-default);
      font: 14px/20px var(--font-sans); -webkit-font-smoothing: antialiased;
    }
    button, input, select, textarea { font: inherit; }
    code, kbd, pre, samp { font-family: var(--font-mono); }
  </style>`

/**
 * The page a view's frame loads first: its head and the bootstrap. The view's own page is written
 * over it once the bootstrap's handshake arrives (`InlineViewFrame.write`).
 */
export const inlineViewShell = (theme: InlineViewTheme): string => `<!DOCTYPE html>
<html>
<head>
  ${frameHead(theme)}
  <script type="module" src="${BOOTSTRAP_URL}"></script>
</head>
<body></body>
</html>`

/** The start of a view's page, which the frame's first `write` takes: all but what is in its body. */
export const inlineViewPageStart = (theme: InlineViewTheme): string => `<!DOCTYPE html>
<html>
<head>
  ${frameHead(theme)}
</head>
<body>
`
