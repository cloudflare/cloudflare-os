// What every page the app runs in a frame sandboxed with no origin shares: a gadget's UI
// (`aside/gadgetSandbox.ts`) and a live view in an answer (`blocks/inlineViewFrame.ts`). Ported
// from workshop-frontend's `sandboxDocument`.
import CAPNWEB_BUNDLE from 'capnweb?raw'

/**
 * Cap'n Web as a data: URL, for the page's own modules to import: the frame can load nothing else.
 * It has no dependencies, so the whole module is embedded. btoa() requires ASCII, which capnweb's
 * build keeps to.
 */
export const CAPNWEB_MODULE_URL = `data:text/javascript;charset=utf-8;base64,${btoa(`//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`)}`

/**
 * The page's viewport and its CSP: no network (but WebRTC, which no CSP directive blocks), no
 * frames; scripts, styles, images and media only inline or as data: URLs.
 */
export const SANDBOX_HEAD = `<meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline' 'wasm-unsafe-eval'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">`
