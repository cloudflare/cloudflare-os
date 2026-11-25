import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeOutputFile = resolve(packageDir, "src/generated/browser-export-runtime.txt");
const capnwebOutputFile = resolve(packageDir, "src/generated/capnweb-module.txt");
const sanitizerOutputFile = resolve(packageDir, "src/generated/html-sanitizer-runtime.txt");
const pageOutputFile = resolve(packageDir, "src/generated/browser-export-page.js");

// The runtime imports Cap'n Web through the export page's import map, which maps "capnweb" to the
// module below, so Gadget code that imports "capnweb" shares the runtime's instance.
const runtimeResult = await build({
  entryPoints: [resolve(packageDir, "browser/browser-export-runtime.ts")],
  bundle: true,
  external: ["capnweb"],
  format: "esm",
  platform: "browser",
  target: "es2025",
  minify: true,
  write: false,
});
const pageResult = await build({
  entryPoints: [resolve(packageDir, "browser/browser-export-page.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2025",
  write: false,
});
const sanitizerResult = await build({
  entryPoints: [resolve(packageDir, "browser/html-sanitizer-runtime.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2025",
  minify: true,
  write: false,
});

// Enforces the rule at the top of browser/browser-export-page.ts. The module is imported from the
// transformed text to read each function as the bundle would hold it.
const keptNames = await transform(pageResult.outputFiles[0].text, { keepNames: true });
const pageFunctions: Record<string, unknown> =
    await import(`data:text/javascript,${encodeURIComponent(keptNames.code)}`);
for (const [name, fn] of Object.entries(pageFunctions)) {
  if (String(fn).includes("__name(")) {
    throw new Error(`browser/browser-export-page.ts: ${name} names a function or class inside ` +
        "itself, which fails in the browser. See the rule at the top of that file.");
  }
}

writeIfChanged(runtimeOutputFile, runtimeResult.outputFiles[0].contents);
// Cap'n Web's browser build, which has no imports of its own. The live iframe embeds the same file.
writeIfChanged(capnwebOutputFile, readFileSync(fileURLToPath(import.meta.resolve("capnweb"))));
writeIfChanged(sanitizerOutputFile, sanitizerResult.outputFiles[0].contents);
writeIfChanged(pageOutputFile, pageResult.outputFiles[0].contents);

function writeIfChanged(outputFile: string, bytes: Uint8Array) {
  const contents = new TextDecoder().decode(bytes);
  if (!existsSync(outputFile) || readFileSync(outputFile, "utf8") !== contents) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, contents);
  }
}
