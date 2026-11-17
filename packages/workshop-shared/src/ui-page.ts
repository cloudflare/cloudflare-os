import type { UiBundle } from "./api";

// Turns a UI bundle into what a page needs to load it: a `data:` URL per module and an import map
// resolving each module's key. Both the Workshop's iframe and browser-mode export build their
// pages from this, so encoding and escaping can't drift apart.

/**
 * The import-map key a Gadget UI module loads under. The backend rewrites each relative import to
 * one. Gadget code never names keys, so how they are formed can change without breaking a gadget.
 */
export function uiModuleKey(path: string): string {
  return `gadget:${path}`;
}

/** A UI bundle prepared for a page, from `prepareUiPage`. */
export type UiPage = {
  /** The `data:` URL of `client.js`, which the page loads as its entry module. */
  entryUrl: string;

  /**
   * Whether the page starts the UI by calling `main(gadget)` on `client.js`'s default export,
   * rather than running a legacy `client.js` with the `gadget`, `RpcTarget` and `RpcStub` globals.
   */
  callsMain: boolean;

  /** The JSON body of the page's `<script type="importmap">`, safe to inline in HTML. */
  importMap: string;

  /** Each module's path by its `data:` URL, for naming a file a browser reports by URL. */
  pathsByUrl: Map<string, string>;
};

/**
 * Encodes each module of `bundle` as a `data:` URL and maps its key to it. The entry is mapped too,
 * so a module that imports `client.js` shares the instance the page loads. "capnweb" maps to
 * `capnwebUrl`, which must be the URL the page's own RPC session imports Cap'n Web from: a module
 * instance of its own would have its own `RpcTarget`, which the session wouldn't recognize.
 */
export function prepareUiPage(bundle: UiBundle, capnwebUrl: string): UiPage {
  let imports: Record<string, string> = {capnweb: capnwebUrl};
  let pathsByUrl = new Map<string, string>();
  let modules = "modules" in bundle ? bundle.modules : [{path: "client.js", code: bundle.jsCode}];
  for (let {path, code} of modules) {
    let url = moduleUrl(path, code);
    imports[uiModuleKey(path)] = url;
    pathsByUrl.set(url, path);
  }
  return {
    entryUrl: imports[uiModuleKey("client.js")]!,
    callsMain: "modules" in bundle,
    // JSON doesn't escape `<`, so a path containing `</script>` would end the element early.
    importMap: JSON.stringify({imports}).replaceAll("<", "\\u003c"),
    pathsByUrl,
  };
}

// The trailing `sourceURL` names the file in errors and stack traces, and keeps byte-identical
// files apart: the browser shares one module instance between equal URLs. It must be the last
// line, or a SyntaxError's reported location is off by one.
function moduleUrl(path: string, code: string): string {
  let bytes = new TextEncoder().encode(`${code}\n//# sourceURL=${path}`);
  let binary = "";
  // Chunked, since spreading a whole module's bytes into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:text/javascript;base64,${btoa(binary)}`;
}
