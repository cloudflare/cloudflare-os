// Static-asset worker for standalone workerd.
//
// Standalone workerd has no `assets` binding type, so this reproduces what Cloudflare's gives us
// on Workers: content types, SPA fallback and cache policy. It mirrors the `assets` stanza in
// `packages/router/wrangler.jsonc` — in particular `not_found_handling:
// "single-page-application"`.
//
// Upstream (`env.DIST`) is a workerd `disk` service, which the schema itself says is "very
// bare-bones, generally not suitable for serving a web site on its own... you normally would wrap
// this in a Worker that fills in the metadata in the way you want". This is that wrapper.
//
// Path traversal needs no code here: workerd guarantees that "the special links '.' and '..' will
// never be accessible" (workerd.capnp:889), and `allowDotfiles` defaults to false. Verified
// against a real `/etc/passwd` — every traversal shape returns the SPA shell, never file content.
// Keep `allowDotfiles = false` in the disk service; it is doing real work.

/** @typedef {{DIST: Fetcher}} Env */

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/vnd.microsoft.icon",
  wasm: "application/wasm",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

/**
 * Fetch one path from the disk service. Returns null for anything that is not a regular file —
 * a 404, or a directory listing, which must never reach a client because it enumerates the tree.
 *
 * Directories are detected by the *absence* of Content-Length, which workerd documents as a
 * contract: "Files will have a Content-Length header, directories will not" (workerd.capnp:864),
 * and it holds for HEAD too since those are answered from a stat(). Sniffing the JSON body was
 * rejected because a legitimately served `.json` asset is indistinguishable from a listing.
 *
 * @param {Env} env
 * @param {string} path
 * @param {string} method
 */
async function readAsset(env, path, method) {
  const res = await env.DIST.fetch(new URL(path, "http://assets"), { method });
  if (!res.ok) return null;
  if (res.headers.get("content-length") === null) return null;
  return res;
}

/**
 * Re-emit a disk response with the metadata a browser needs. Without an explicit content type the
 * disk service answers `application/octet-stream` for everything, so the browser would download
 * the JS bundle instead of running it and the page would be blank.
 *
 * @param {Response} res
 * @param {string} path
 * @param {string} cacheControl
 */
function serve(res, path, cacheControl) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const headers = new Headers(res.headers);
  headers.set("content-type", TYPES[/** @type {keyof TYPES} */ (ext)] ?? "application/octet-stream");
  headers.set("cache-control", cacheControl);
  return new Response(res.body, { status: 200, headers });
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const method = request.method;
    const path = new URL(request.url).pathname;

    // "/" and any non-file path fall through to index.html; only real files are served directly.
    if (path !== "/") {
      const hit = await readAsset(env, path, method);
      // Vite emits content-hashed names under assets/, so those are safe to pin forever. index.html
      // must stay revalidated or a deployment never reaches an already-open browser.
      if (hit) return serve(hit, path, path.startsWith("/assets/") ? IMMUTABLE : NO_CACHE);
    }

    // SPA fallback: the client router owns this path, so hand it the shell at 200 rather than 404.
    const index = await readAsset(env, "/index.html", method);
    if (!index) return new Response("Not Found", { status: 404 });
    return serve(index, "/index.html", NO_CACHE);
  },
};
