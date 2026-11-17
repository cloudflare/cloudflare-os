// The page an `<inline-html>` block of an agent's answer runs in (see plans/live-views.md), and
// what passes between it and the app. The block's HTML is agent-written and nobody reviews it, so
// it gets a frame with no origin, a policy that reaches nothing outside the page, and this small
// protocol over a port its page hands over: no API of the app's, only what is listed below.

/** The app's theme, as a view's page applies it. */
export type ViewTheme = {
  scheme: 'light' | 'dark'
  /** Theme values by custom property name, e.g. `--color-kumo-base`. */
  tokens: Record<string, string>
}

/** What a view's page tells the app, over its port. */
export type ViewMessage =
  /** Its content's height, in CSS pixels. */
  | { type: 'height'; height: number }
  /** An uncaught error in its code. The view keeps running. */
  | { type: 'error'; message: string }
  /** `agent.send(message)`: the viewer is asked to send `message` as their own. */
  | { type: 'send'; message: string }

/** What a view's page posts to the app, with its port, as it starts. */
export const VIEW_HANDSHAKE = 'inline-view'

// The values a view may use: those its instructions list (see the agent's "Live views in your
// answers"), and the fonts, which are installed ones the page never has to download.
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
 * The app's theme as it stands. Its tokens are `light-dark()` pairs (theme.css), which the page
 * resolves through its own `color-scheme`.
 */
export const readViewTheme = (): ViewTheme => {
  const root = document.documentElement
  const style = getComputedStyle(root)
  return {
    scheme: root.dataset.mode === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()])),
  }
}

/**
 * Reads what a view's page sent, which its own code could have written: anything else is nothing.
 * A height is a finite number of pixels; a message to send has words in it.
 */
export const readViewMessage = (data: unknown): ViewMessage | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const { type, height, message } = data as Record<string, unknown>
  if (type === 'height' && typeof height === 'number' && Number.isFinite(height) && height >= 0) return { type, height }
  if (type === 'error' && typeof message === 'string') return { type, message: message.slice(0, 500) }
  if (type === 'send' && typeof message === 'string' && message.trim() !== '') return { type, message: message.slice(0, 4000) }
  return undefined
}

// Runs before anything of the block's, classic scripts included: it hands the app its port, reports
// errors and the content's height, follows the theme, and gives the block its one global, `agent`.
const BOOTSTRAP = String.raw`(() => {
  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage("${VIEW_HANDSHAKE}", "*", [port2]);
  const post = message => port1.postMessage(message);
  const root = document.documentElement.style;
  port1.onmessage = ({ data }) => {
    if (data?.type !== "theme") return;
    root.colorScheme = data.scheme;
    for (const [name, value] of Object.entries(data.tokens)) root.setProperty(name, value);
  };
  addEventListener("error", event => post({ type: "error", message: String(event.error?.message ?? event.message) }));
  addEventListener("unhandledrejection", event => post({ type: "error", message: String(event.reason?.message ?? event.reason) }));
  let last = -1;
  const measure = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== last) post({ type: "height", height: (last = height) });
  };
  addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(measure).observe(document.body);
    measure();
  });
  window.open = () => null;
  globalThis.agent = Object.freeze({
    send: async message => {
      if (typeof message !== "string" || message.trim() === "") throw new TypeError("agent.send() takes the message to send.");
      post({ type: "send", message });
    },
  });
})();`

const themeStyle = ({ scheme, tokens }: ViewTheme) =>
  `:root { color-scheme: ${scheme}; ${Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(' ')} }`

/**
 * The whole page of a view: the block's HTML after a head that fits it into the card it sits on.
 * The policy allows no network, no nested frames, and scripts, styles, images and media only
 * inline or as data: URLs.
 */
export const inlineViewPage = (html: string, theme: ViewTheme): string => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline' 'wasm-unsafe-eval'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
<style>
  ${themeStyle(theme)}
  html, body { margin: 0; height: auto; background: transparent; }
  /* The padding keeps a child's margin inside the measured height and focus rings inside the
     frame, which the card widens to match; its own formatting context keeps floats in too. The
     text is the conversation's. */
  body {
    display: flow-root; padding: 4px; color: var(--text-color-kumo-default);
    font: 15px/1.45 var(--font-sans, system-ui, sans-serif); -webkit-font-smoothing: antialiased;
  }
  button, input, select, textarea { font: inherit; }
  code, kbd, pre, samp { font-family: var(--font-mono, ui-monospace, monospace); }
</style>
<script>${BOOTSTRAP}</script>
</head>
<body>
${html}
</body>
</html>`
