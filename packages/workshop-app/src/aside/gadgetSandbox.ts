// Cap'n Web has no dependencies, so the whole module is embedded in the gadget's page, to connect
// it to its server side. Ported from workshop-frontend's GadgetUI and sandboxDocument, which
// explain the encoding.
import CAPNWEB_BUNDLE from 'capnweb?raw'
import type { UiBundle } from '@gadgets/workshop-shared/api'
import { prepareUiPage, uiModuleKey } from '@gadgets/workshop-shared/ui-page'

/** What the gadget's page posts to say Escape was pressed in it, since a sandboxed frame keeps its keys. */
export const ESCAPE_MESSAGE = 'escape'
/** What the gadget's page posts with the port it is to be connected through. */
export const HANDSHAKE_MESSAGE = 'handshake'

// btoa() requires ASCII; capnweb's build keeps its bundle ASCII-only. The import map resolves the
// UI's own "capnweb" imports to this same URL, so that its `RpcTarget` is the one the page's
// session recognizes.
const CAPNWEB_MODULE_URL = `data:text/javascript;charset=utf-8;base64,${btoa(`//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`)}`

const MISSING_MAIN = "client.js's default export has no main() function. Start the UI with " +
  '`export default { main(gadget) { ... } }`.'

// A module script placed before the UI's entry. Module scripts run in document order, so what it
// sets up is there before any of the UI's modules runs: for a legacy UI, its globals. It stays
// synchronous, as a top-level await would let the entry run first. For a UI with `main()`, the
// `gadget` stub stays in this module's scope, reaching only the code `main()` hands it to.
const runtimeUrl = (callsMain: boolean) => `data:text/javascript;charset=utf-8,${encodeURIComponent(String.raw`import { RpcTarget, RpcStub, newMessagePortRpcSession } from "${CAPNWEB_MODULE_URL}";

let gadget;
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("${HANDSHAKE_MESSAGE}", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
}
${callsMain ? '' : `
globalThis.gadget = gadget;
globalThis.RpcTarget = RpcTarget;
globalThis.RpcStub = RpcStub;
`}
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
  if (event.key === 'Escape') window.parent.postMessage({ type: "${ESCAPE_MESSAGE}" }, '*');
}, true);

window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a[href][target]');
  if (!anchor || anchor.target.toLowerCase() !== '_blank') return;
  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  anchor.setAttribute('rel', Array.from(rel).join(' '));
}, true);
${callsMain ? `
// The UI's GadgetHost. This app cannot yet show the chat of an agent a gadget spawned.
const host = {
  async openAgentChat() {
    throw new Error("Opening an agent's chat from a gadget isn't supported here yet.");
  },
};

// The same module instance the entry's <script> loads, which reports one that fails to load.
import(${JSON.stringify(uiModuleKey('client.js'))}).then(entry => {
  let main = entry.default?.main;
  if (typeof main !== 'function') {
    console.error(${JSON.stringify(MISSING_MAIN)});
    return;
  }
  return main.call(entry.default, gadget, host);
}, () => {});
` : ''}
//# sourceURL=gadget-runtime.js`)}`
const LEGACY_RUNTIME_URL = runtimeUrl(false)
const MAIN_RUNTIME_URL = runtimeUrl(true)

/**
 * The page a gadget's UI runs in, inside a frame with scripts and nothing else allowed: a legacy
 * `client.js` with its globals, or the UI's modules started from `client.js`'s `main()`.
 */
export const gadgetPage = (bundle: UiBundle): string => {
  const page = prepareUiPage(bundle, CAPNWEB_MODULE_URL)
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline' 'wasm-unsafe-eval'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
  <script type="importmap">${page.importMap}</script>
</head>
<body>
  <script type="module" src="${page.callsMain ? MAIN_RUNTIME_URL : LEGACY_RUNTIME_URL}"></script>
  <script type="module" src="${page.entryUrl}"></script>
</body>
</html>`
}
