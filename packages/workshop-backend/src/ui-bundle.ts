// The wasm builds compile at runtime, which Workers forbid, so this is an asm.js (`/js`) build,
// whose `parse` needs no `init()`. `minimal` lexes JavaScript only, where the full build also
// accepts TypeScript, and reports the flat records read below.
import { parse, type ExportSpecifier, type ImportSpecifier } from "es-module-lexer/minimal/js";
import type { UiBundle } from "@gadgets/workshop-shared/api";
import { uiModuleKey } from "@gadgets/workshop-shared/ui-page";

// A path with one of these can't be written safely into a quoted specifier, or V8 ignores the
// `sourceURL` naming it (whitespace).
const UNSAFE_PATH = /["'`\\\s\p{Cc}]/u;

/**
 * Collects the UI modules `client.js` reaches through relative static imports, rewriting each such
 * specifier to the module's `uiModuleKey`. Anyone who can use the gadget receives the bundle, so
 * nothing `client.js` doesn't reach is included. A pure function of the gadget's file tree.
 *
 * A `client.js` with a default export is started by calling its `main()`, and is sent as
 * `modules`; one with no default export is a legacy UI, sent as `jsCode`. A legacy UI may import
 * only `data:` URLs: a module that imports another can't rely on legacy globals.
 *
 * Returns null when there's no `client.js`, and throws on the first import that breaks the UI
 * import rules.
 */
export function buildUiBundle(files: ReadonlyMap<string, string>): UiBundle | null {
  if (!files.has("client.js")) return null;
  let shipped = new Map<string, string>();
  // Iterating a Set visits values added during the loop, so this is also the walk's queue.
  let reached = new Set(["client.js"]);
  let exportsDefault = false;
  // Where client.js first imports something other than a data: URL, for the error if it has no
  // default export.
  let firstModuleImport: string | undefined;
  for (let path of reached) {
    let code = files.get(path)!;
    let lineAt = linesIn(code);
    let messageAt = (offset: number, problem: string) => `${path}:${lineAt(offset)}: ${problem}`;

    let imports: readonly ImportSpecifier[] = [];
    let exports: readonly ExportSpecifier[] = [];
    try {
      [imports, exports] = parse(code);
    } catch {
      // Shipped as written, so the browser reports the real SyntaxError at the right place.
    }
    if (path === "client.js") exportsDefault = exports.some(({n}) => n === "default");

    let rewritten = "";
    let copied = 0;
    let replace = (s: number, e: number, text: string) => {
      rewritten += code.slice(copied, s) + text;
      copied = e;
    };
    // `s`/`e` cover a static import's specifier, without its quotes.
    for (let {n: spec, s, e, d} of imports) {
      let fail = (problem: string) => new Error(messageAt(s, problem));
      if (d === -2) continue;  // import.meta
      // Refused even with a literal specifier, which could be followed, so that whether and how
      // import() is supported stays open.
      if (d >= 0) {
        throw fail(`import() isn't supported in UI code. Import the module statically instead, ` +
            `like \`import { list } from "./ui/list.js";\`.`);
      }
      // Only an import() can lack a specifier: one the lexer can't unescape fails the parse.
      if (spec === undefined) continue;
      let quoted = JSON.stringify(spec);
      if (spec.startsWith(uiModuleKey(""))) {
        throw fail(`${quoted} can't be imported: import the gadget's own files by relative path, ` +
            `like "./ui/list.js".`);
      }
      if (spec.startsWith("data:")) continue;
      if (path === "client.js") firstModuleImport ??= messageAt(s, quoted);
      // The page's import map resolves it to the Cap'n Web the page's RPC session uses.
      if (spec === "capnweb") continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        throw fail(`${quoted} can't be imported: UI code can import only the gadget's own .js ` +
            `files, by relative path like "./ui/list.js", "capnweb", and data: URLs.`);
      }

      let resolved = resolve(path, spec);
      if (resolved === null) throw fail(`${quoted} points outside the gadget's files.`);
      if (UNSAFE_PATH.test(resolved)) {
        throw fail(`${quoted} resolves to ${JSON.stringify(resolved)}; an imported path can't ` +
            `contain quotes, backslashes, whitespace or control characters.`);
      }
      if (!resolved.endsWith(".js")) {
        throw fail(`${quoted} resolves to ${resolved}, which can't be imported: only .js files ` +
            `can.`);
      }
      if (resolved === "server.js") {
        throw fail(`${quoted} resolves to server.js, which runs only on the server and can't be ` +
            `imported by UI code.`);
      }
      if (!files.has(resolved)) {
        throw fail(`${quoted} resolves to ${resolved}, which doesn't exist.`);
      }
      replace(s, e, uiModuleKey(resolved));
      reached.add(resolved);
    }
    shipped.set(path, rewritten + code.slice(copied));
  }

  if (exportsDefault) return {modules: [...shipped].map(([path, code]) => ({path, code}))};
  if (firstModuleImport !== undefined) {
    throw new Error(`${firstModuleImport} is imported, so client.js must start the UI from a ` +
        `main function: \`export default { main(gadget) { ... } }\`, and import RpcTarget and ` +
        `RpcStub from "capnweb". The gadget, RpcTarget and RpcStub globals exist only for a ` +
        `legacy client.js, which has no default export and imports only data: URLs.`);
  }
  return {jsCode: shipped.get("client.js")!};
}

// Resolves a `./` or `../` specifier against the importing file's directory, or returns null if
// it leaves the gadget root. Not `new URL()`, which clamps `..` at the root and percent-encodes.
function resolve(importer: string, spec: string): string | null {
  let segments = importer.split("/").slice(0, -1);
  for (let segment of spec.split("/")) {
    if (segment === "..") {
      if (segments.pop() === undefined) return null;
    } else if (segment !== ".") {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

// Offsets must not decrease, as the lexer reports imports in source order.
function linesIn(code: string): (offset: number) => number {
  let line = 1;
  let next = code.indexOf("\n");
  return offset => {
    while (next >= 0 && next < offset) {
      line++;
      next = code.indexOf("\n", next + 1);
    }
    return line;
  };
}
