// What every agent-written page the Workshop runs in an opaque-origin srcDoc frame shares: a gadget
// UI (GadgetUI) or a `<gadget-ui>` block in a chat answer (GadgetUiBlockCard).

// The frame imports Cap'n Web to talk to the Workshop. It has no dependencies, so we embed the
// whole module, imported here as a string.
import CAPNWEB_BUNDLE from 'capnweb?raw'

// btoa() below requires this to stay ASCII; capnweb's build enforces ASCII-only dist bundles
// since 0.11.1.
const CAPNWEB_BUNDLE_ANNOTATED = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`

/**
 * Cap'n Web as a data: URL, for an `import` statement in the frame's code. The frame is fully
 * sandboxed, so it can load nothing else.
 */
export const CAPNWEB_MODULE_URL =
  `data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_BUNDLE_ANNOTATED)}`

/**
 * The frame document's `<head>` tags: the viewport and the CSP. The CSP allows no network access
 * and no nested frames; scripts, styles, images and media may only be inline or data: URLs.
 */
export const SANDBOX_HEAD = `<meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">`
