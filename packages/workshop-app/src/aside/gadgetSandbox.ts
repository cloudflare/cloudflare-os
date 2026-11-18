// A gadget's UI runs in a page of its own, in a frame sandboxed with no origin, that can load
// nothing and reach nothing but the app, over a port it posts. Ported from workshop-frontend's
// `GadgetUI` and `sandboxDocument`, which explain more; the bundle is turned into modules by the
// shared `prepareUiPage`, which an export builds its page from too.
import { RpcTarget } from 'capnweb'
import type { ConsoleLogEvent, GadgetHost, UiBundle } from '@gadgets/workshop-shared/api'
import { prepareUiPage, uiModuleKey } from '@gadgets/workshop-shared/ui-page'
import { CAPNWEB_MODULE_URL, SANDBOX_HEAD } from '@/components/sandboxPage'

/** What the gadget's page posts with the port it is to be connected through. */
export const HANDSHAKE_MESSAGE = 'handshake'

const MISSING_MAIN = "client.js's default export has no main() function. Start the UI with `export default { main(gadget) { ... } }`."

// The runtime, a module placed before the gadget's own, so that what it sets up is there first.
// It connects to the app, whose root (`GadgetFrameRoot`) has the gadget's server side and the
// app as its host. A UI of modules is started by `main(gadget, host)` on client.js's default
// export, and the two stay in the runtime's scope; a legacy client.js gets them as globals. It
// passes on console calls, uncaught errors and Escape, and blocks popups.
const runtimeUrl = (callsMain: boolean) => `data:text/javascript;charset=utf-8,${encodeURIComponent(String.raw`import { RpcTarget, RpcStub, newMessagePortRpcSession } from "${CAPNWEB_MODULE_URL}";

let root, gadget, host;
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("${HANDSHAKE_MESSAGE}", "*", [port2]);
  root = newMessagePortRpcSession(port1);
  gadget = root.gadget;
  host = root.host;
}

let notify = call => { call.then(() => {}, () => {}); };
${callsMain ? '' : `
globalThis.gadget = gadget;
globalThis.RpcTarget = RpcTarget;
globalThis.RpcStub = RpcStub;
`}
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

const blockedOpen = () => {
  console.error('window.open() is disabled in Gadget UIs. Use a link with target="_blank" instead.');
  return null;
};
window.open = blockedOpen;
globalThis.open = blockedOpen;
try {
  Window.prototype.open = blockedOpen;
} catch {}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') notify(root.escape());
}, true);

window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a[href][target]');
  if (!anchor || anchor.target.toLowerCase() !== '_blank') return;
  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  anchor.setAttribute('rel', Array.from(rel).join(' '));
}, true);

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
import(${JSON.stringify(uiModuleKey('client.js'))}).then(entry => {
  let main = entry.default?.main;
  if (typeof main !== 'function') {
    reportError([${JSON.stringify(MISSING_MAIN)}]);
    return;
  }
  return main.call(entry.default, gadget, host);
}, () => {});
` : ''}
//# sourceURL=gadget-runtime.js`)}`
const LEGACY_RUNTIME_URL = runtimeUrl(false)
const MAIN_RUNTIME_URL = runtimeUrl(true)

/** A gadget's UI as a page for its frame, and each of its modules' paths, to name where a log came from. */
export type GadgetPage = { html: string; pathsByUrl: ReadonlyMap<string, string> }

/** The page a gadget's UI runs in, inside a frame with scripts and nothing else allowed. */
export const gadgetPage = (bundle: UiBundle): GadgetPage => {
  const page = prepareUiPage(bundle, CAPNWEB_MODULE_URL)
  return {
    html: `<!DOCTYPE html>
<html>
<head>
  ${SANDBOX_HEAD}
  <script type="importmap">${page.importMap}</script>
</head>
<body>
  <script type="module" src="${page.callsMain ? MAIN_RUNTIME_URL : LEGACY_RUNTIME_URL}"></script>
  <script type="module" src="${page.entryUrl}"></script>
</body>
</html>`,
    pathsByUrl: page.pathsByUrl,
  }
}

/** Where in the page a console call or an uncaught error happened, as the browser said. */
export type ConsoleLocation = { url?: string; line?: number; column?: number }

/** What the page's runtime tells the app, apart from what the gadget's own code calls. */
export type FrameEvents = {
  reportConsole(level: ConsoleLogEvent['level'], message: string[], at?: ConsoleLocation): void
  escape(): void
}

/** The app, as a gadget's page sees it (`GadgetHost`). */
export class WorkshopGadgetHost extends RpcTarget implements GadgetHost {
  constructor(private readonly opensAgentChat: (chatToken: string) => Promise<void>) {
    super()
  }

  async openAgentChat(chatToken: string): Promise<void> {
    // The page is not trusted, and nothing checks what it sends here.
    if (typeof chatToken !== 'string') throw new TypeError('chatToken must be a string.')
    await this.opensAgentChat(chatToken)
  }
}

/**
 * What the page's one connection to the app reaches: the gadget's server side and the app, through
 * the same session, so that what one passes the other never goes through the page; and what the
 * runtime reports, which the gadget's code is not handed.
 */
export class GadgetFrameRoot extends RpcTarget {
  constructor(
    private readonly server: unknown,
    private readonly appHost: GadgetHost,
    private readonly events: FrameEvents,
  ) {
    super()
  }

  get gadget() {
    return this.server
  }

  get host() {
    return this.appHost
  }

  reportConsole(level: unknown, message: unknown, at?: unknown) {
    // Checked, as the page could send anything.
    if (!['debug', 'info', 'log', 'warn', 'error'].includes(level as string) || !Array.isArray(message)) return
    const where = at && typeof at === 'object' ? (at as ConsoleLocation) : undefined
    this.events.reportConsole(level as ConsoleLogEvent['level'], message.map(String), where)
  }

  escape() {
    this.events.escape()
  }
}

/**
 * Where a log came from, as a module's path and line: a module of the gadget's is named by its
 * path, and anything else that is a data: URL, which can be long, by its start.
 */
export const logLocation = (at: ConsoleLocation | undefined, pathsByUrl: ReadonlyMap<string, string>) => {
  if (!at?.url) return undefined
  const path = pathsByUrl.get(at.url) ?? (at.url.startsWith('data:') ? `${at.url.slice(0, 40)}…` : at.url)
  return at.line ? `${path}:${at.line}:${at.column}` : path
}
