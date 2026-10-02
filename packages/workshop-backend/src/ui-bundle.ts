// The default build compiles wasm at runtime, which Workers forbid. The `/js` build exports only
// `parse`; its types also declare `init`, which would fail when the module links.
import { parse, type ImportSpecifier } from "es-module-lexer/js";
import type { UiBundle } from "@gadgets/workshop-shared/api";
import { uiModuleKey } from "@gadgets/workshop-shared/ui-page";

// A path with one of these can't be written safely into a quoted specifier, or V8 ignores the
// `sourceURL` naming it (whitespace).
const UNSAFE_PATH = /["'`\\\s\p{Cc}]/u;

/**
 * Collects the UI modules `client.js` reaches through relative static imports and string-literal
 * `import()`, rewriting each such specifier to the module's `uiModuleKey`. Anyone who can use the
 * gadget receives the bundle, so nothing `client.js` doesn't reach is included. A pure function of
 * the gadget's file tree. Returns null when there's no `client.js`, and throws on the first import
 * that breaks the UI import rules, except that a bad `import()` only rejects when it runs.
 */
export function buildUiBundle(files: ReadonlyMap<string, string>): UiBundle | null {
  if (!files.has("client.js")) return null;
  let shipped = new Map<string, string>();
  // Iterating a Set visits values added during the loop, so this is also the walk's queue.
  let reached = new Set(["client.js"]);
  for (let path of reached) {
    let code = files.get(path)!;
    let lineAt = linesIn(code);
    let messageAt = (offset: number, problem: string) => `${path}:${lineAt(offset)}: ${problem}`;

    let imports: readonly ImportSpecifier[] = [];
    try {
      [imports] = parse(code);
    } catch {
      // Shipped as written, so the browser reports the real SyntaxError at the right place.
    }

    let rewritten = "";
    let copied = 0;
    let replace = (s: number, e: number, text: string) => {
      rewritten += code.slice(copied, s) + text;
      copied = e;
    };
    // `s`/`e` cover a static import's specifier without its quotes, and a dynamic one's with them.
    for (let {n: spec, s, e, d} of imports) {
      // import.meta, or an import() with a computed specifier, which can't be followed.
      if (d === -2 || spec === undefined) continue;
      let dynamic = d >= 0;
      let quoted = JSON.stringify(spec);
      if (spec.startsWith(uiModuleKey(""))) {
        throw new Error(messageAt(s, `${quoted} can't be imported: import the gadget's own files ` +
            `by relative path, like "./ui/list.js".`));
      }
      if (spec.startsWith("data:")) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        // A dynamic one is left for the browser to reject when it runs.
        if (dynamic) continue;
        throw new Error(messageAt(s, `${quoted} can't be imported: UI code can import only the ` +
            `gadget's own .js files, by relative path like "./ui/list.js", and data: URLs. ` +
            `gadget, RpcTarget and RpcStub are globals in every UI module; don't import them.`));
      }

      let resolved = resolve(path, spec);
      let problem: string;
      if (resolved === null) {
        problem = `${quoted} points outside the gadget's files.`;
      } else if (UNSAFE_PATH.test(resolved)) {
        throw new Error(messageAt(s, `${quoted} resolves to ${JSON.stringify(resolved)}; an ` +
            `imported path can't contain quotes, backslashes, whitespace or control characters.`));
      } else if (!resolved.endsWith(".js")) {
        problem = `${quoted} resolves to ${resolved}, which can't be imported: only .js files can.`;
      } else if (resolved === "server.js") {
        problem = `${quoted} resolves to server.js, which runs only on the server and can't be ` +
            `imported by UI code.`;
      } else if (!files.has(resolved)) {
        problem = `${quoted} resolves to ${resolved}, which doesn't exist.`;
      } else {
        let key = uiModuleKey(resolved);
        replace(s, e, dynamic ? JSON.stringify(key) : key);
        reached.add(resolved);
        continue;
      }

      if (!dynamic) throw new Error(messageAt(s, problem));
      // The import() may never run, so rather than failing the UI it rejects with the message
      // when it does. No file content ships.
      let thrower = `throw new Error(${JSON.stringify(messageAt(s, problem))});`;
      replace(s, e, JSON.stringify(`data:text/javascript,${encodeURIComponent(thrower)}`));
    }
    shipped.set(path, rewritten + code.slice(copied));
  }

  return shipped.size === 1
    ? {jsCode: shipped.get("client.js")!}
    : {modules: [...shipped].map(([path, code]) => ({path, code}))};
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
