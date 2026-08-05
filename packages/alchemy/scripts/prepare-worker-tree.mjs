// Prepares a capnweb-validate output tree for alchemy's rolldown bundler.
// Two fixes, both in place so every import path stays identical:
//
// 1. `.svg` Text modules → `.svg.txt`. The wrangler configs declare `.svg`
//    as Text; alchemy's bundler hardcodes Text to `.txt/.html/.sql`.
//    (TODO upstream: honor wrangler-style module rules.)
// 2. TC39 class decorators → lowered JS. capnweb-validate emits
//    `@__validateRpcClass(...)` decorators; wrangler's esbuild lowers them
//    but rolldown passes them through, and workerd's parser rejects
//    decorator syntax (`ScriptStartupError: Invalid or unexpected token`).
//    Each `.ts` file is esbuild-transformed (target es2022) in place.
//    (TODO upstream: enable decorator lowering in alchemy's bundler.)
//
// Idempotent: already-lowered files contain no decorators and transform to
// themselves; `.svg.txt` copies are overwritten.
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const root = process.argv[2];
if (!root) {
  console.error("usage: prepare-worker-tree.mjs <dir>");
  process.exit(1);
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });

let files;
try {
  files = walk(root);
} catch {
  process.exit(0); // nothing to prepare
}

for (const file of files) {
  if (file.endsWith(".svg")) {
    copyFileSync(file, `${file}.txt`);
  }
}

for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file) || file.endsWith(".d.ts")) continue;
  const source = readFileSync(file, "utf8");
  const fixed = source.replace(/(from\s+["'][^"']*\.svg)(["'])/g, "$1.txt$2");
  const { code } = await esbuild.transform(fixed, {
    loader: file.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
    target: "es2022",
  });
  writeFileSync(file, code);
}
