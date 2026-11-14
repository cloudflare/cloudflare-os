// Cap'n Web has no dependencies, so the whole module is embedded in the gadget's page, to connect
// it to its server side. Ported from workshop-frontend's GadgetUI, which explains the encoding.
import CAPNWEB_BUNDLE from 'capnweb?raw'

/** What the gadget's page posts to say Escape was pressed in it, since a sandboxed frame keeps its keys. */
export const ESCAPE_MESSAGE = 'escape'
/** What the gadget's page posts with the port it is to be connected through. */
export const HANDSHAKE_MESSAGE = 'handshake'

// btoa() requires ASCII; capnweb's build keeps its bundle ASCII-only.
const CAPNWEB_SOURCE = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`

// The frame is sandboxed with no origin, so the library can only arrive as a data: URL, imported
// from the gadget's own module, which is a data: URL too: base64 inside, URL-encoded outside.
const PRELUDE = encodeURIComponent(String.raw`//# sourceURL=client.js
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_SOURCE)}";

let gadget;
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("${HANDSHAKE_MESSAGE}", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
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

`)

/** The page a gadget's UI code runs in, inside a frame with scripts and nothing else allowed. */
export const gadgetPage = (jsCode: string): string => `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
</head>
<body>
  <script type="module" src="data:text/javascript;charset=utf-8,${PRELUDE}${encodeURIComponent(jsCode)}"></script>
</body>
</html>`
