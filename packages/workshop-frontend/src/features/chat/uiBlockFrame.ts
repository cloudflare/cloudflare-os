// The frame of a `<gadget-ui>` block in an agent answer (see plans/live-views.md): the
// document it runs, and the Cap'n Web interfaces between it and the Workshop. The block's HTML is
// agent-written and nobody reviews it, so the frame gets the gadget UI sandbox and only what
// UiBlockHost offers.

import { RpcTarget } from 'capnweb'
import { CAPNWEB_MODULE_URL, SANDBOX_HEAD } from '../../sandboxDocument'

/** The Workshop's theme, as a block's frame applies it. */
export type UiBlockTheme = {
  scheme: 'light' | 'dark'
  /** Theme values by custom property name, e.g. `--color-kumo-base` or `--font-sans`. */
  tokens: Record<string, string>
}

/** What a block's frame may call on the Workshop, through the session its handshake opens. */
export interface UiBlockHost {
  /**
   * Asks the viewer to send `message` to the chat as their own message. The Workshop shows it
   * under the block, and sends it only when the viewer clicks Send. A newer request from the same
   * block replaces it.
   */
  requestMessage(message: string): void

  /** Reports the height of the block's content, in CSS pixels. */
  resize(height: number): void

  /** Reports an uncaught error in the block's code. */
  reportError(message: string): void
}

/** What the Workshop may call on a block's frame. */
export interface UiBlockFrame {
  /** Applies a new theme, e.g. after the viewer switches between light and dark. */
  setTheme(theme: UiBlockTheme): void

  /**
   * Adds `html` to the end of the block's document, which the browser parses as it arrives. The
   * first call starts a new document, so it takes `createUiBlockDocumentStart`.
   */
  write(html: string): void

  /** Ends the block's document once the block closes, so its module scripts run. */
  close(): void
}

// The theme values a block can use. Blocks get these names only; the agent's instructions list the
// colours, and the frame's own style applies the fonts.
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
  // Installed fonts that the Workshop never downloads, so the frame's CSP does not block them.
  '--font-sans',
  '--font-mono',
] as const

/**
 * The Workshop's current theme, as `applyThemeMode` set it on the document root. Some token values
 * contain `light-dark()`, which the frame resolves through its own `color-scheme`.
 */
export function readUiBlockTheme(): UiBlockTheme {
  const root = document.documentElement
  const style = getComputedStyle(root)
  return {
    scheme: root.dataset.mode === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(THEME_TOKENS.map(name => [name, style.getPropertyValue(name).trim()])),
  }
}

/** What a block's host does for its card. */
export type UiBlockHostOptions = {
  onMessageRequest: (message: string) => void
  onResize: (height: number) => void
  onError: (message: string) => void
}

/**
 * The Workshop's end of a block's frame session. Block code runs in the bootstrap's realm and can
 * reach its port, so the host checks what each call passes.
 */
export class UiBlockHostImpl extends RpcTarget implements UiBlockHost {
  readonly #options: UiBlockHostOptions

  constructor(options: UiBlockHostOptions) {
    super()
    this.#options = options
  }

  requestMessage(message: string): void {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new TypeError('agent.send() takes the message to send.')
    }
    this.#options.onMessageRequest(message)
  }

  resize(height: number): void {
    if (Number.isFinite(height)) this.#options.onResize(height)
  }

  reportError(message: string): void {
    this.#options.onError(String(message))
  }
}

// Runs in the frame's shell, before any of the block's code, which arrives later through
// Frame.write.
const BOOTSTRAP_URL = `data:text/javascript;charset=utf-8,${encodeURIComponent(String.raw`//# sourceURL=gadget-ui-bootstrap.js
import { RpcTarget, newMessagePortRpcSession } from "${CAPNWEB_MODULE_URL}";

// TRUSTED_TYPES_CSP allows only these two policies, and the bootstrap takes both names before the
// block's code runs. The block's own document goes through the first. The default one lets code
// clear an element with "" and refuses any other string. Browsers without Trusted Types ignore it.
const blockHtml = globalThis.trustedTypes?.createPolicy("gadget-ui", { createHTML: html => html });
globalThis.trustedTypes?.createPolicy("default", { createHTML: html => html === "" ? html : null });

const applyTheme = ({ scheme, tokens }) => {
  const root = document.documentElement.style;
  root.colorScheme = scheme;
  for (const [name, value] of Object.entries(tokens)) root.setProperty(name, value);
};

// Chromium runs a module script inside close(), and puts this before the message of an error that
// the script throws at once.
const CLOSE_ERROR = "Failed to execute 'close' on 'Document': ";

// The bootstrap's own calls to the host are settled so that capnweb releases them.
const reportError = message => {
  message = String(message);
  host.reportError(message.startsWith(CLOSE_ERROR) ? message.slice(CLOSE_ERROR.length) : message)
      .catch(() => {});
};
const reportHeight = () =>
  host.resize(Math.ceil(document.body.getBoundingClientRect().height)).catch(() => {});

let started = false;
class Frame extends RpcTarget {
  setTheme(theme) { applyTheme(theme); }
  write(html) {
    const first = !started;
    if (first) {
      started = true;
      // The new document keeps this window, its globals, the port and the CSP. It drops the old
      // document's nodes, and every listener on the document and the window.
      document.open();
      window.addEventListener("error", event => reportError(event.error?.message ?? event.message));
      window.addEventListener("unhandledrejection",
          event => reportError(event.reason?.message ?? event.reason));
    }
    document.write(blockHtml?.createHTML(html) ?? html);
    if (first) new ResizeObserver(reportHeight).observe(document.body);
  }
  close() { document.close(); }
}

// The first write opens a new document. The shell's load event, if still to come, would fire in it.
if (document.readyState !== "complete") await new Promise(resolve => addEventListener("load", resolve, { once: true }));
const { port1, port2 } = new MessageChannel();
window.parent.postMessage("handshake", "*", [port2]);
const host = newMessagePortRpcSession(port1, new Frame());

// send() settles its call here and returns a plain promise, so a handler that ignores the result
// leaves nothing held on either end. A refused message still rejects it.
globalThis.agent = Object.freeze({
  send: async message => { await host.requestMessage(message); },
});
`)}`

const themeStyle = ({ scheme, tokens }: UiBlockTheme) =>
  `:root { color-scheme: ${scheme}; ${Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(' ')} }`

// Block code that parses a string as HTML or as an event handler (innerHTML,
// setAttribute("onclick", ...) and the like) throws, so data a view shows cannot run as code in it.
// Views only: gadget UIs use innerHTML.
const TRUSTED_TYPES_CSP = `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'; trusted-types gadget-ui default">`

// The head of the frame's shell and of the block's document: the gadget UI sandbox head, the
// Trusted Types CSP, the theme, and the style that fits the block into the answer.
const frameHead = (theme: UiBlockTheme) => `${SANDBOX_HEAD}
  ${TRUSTED_TYPES_CSP}
  <style>
    ${themeStyle(theme)}
    html, body { margin: 0; height: auto; background: transparent; }
    /* The padding keeps a child's margin inside the measured height and focus rings inside the
       frame, which the view widens to match. Its own formatting context keeps floats inside too.
       The text matches the answer's prose around it. */
    body {
      display: flow-root; padding: 4px; color: var(--text-color-kumo-default);
      font: 14px/1.6 var(--font-sans); letter-spacing: -0.25px;
    }
    button, input, select, textarea { font: inherit; letter-spacing: inherit; }
    code, kbd, pre, samp { font-family: var(--font-mono); }
  </style>`

/**
 * The document a block's frame loads: its head and the bootstrap. The host writes the block's own
 * document over it once the bootstrap's handshake arrives (see `UiBlockFrame.write`).
 */
export function createUiBlockShell(theme: UiBlockTheme): string {
  return `<!DOCTYPE html>
<html>
<head>
  ${frameHead(theme)}
  <script type="module" src="${BOOTSTRAP_URL}"></script>
</head>
<body></body>
</html>`
}

/** The start of a block's document, which the frame's first `write` takes: all but its body. */
export function createUiBlockDocumentStart(theme: UiBlockTheme): string {
  return `<!DOCTYPE html>
<html>
<head>
  ${frameHead(theme)}
</head>
<body>
`
}
