// Rewrites `.svg` Text-module imports in a built worker tree to `.svg.txt`.
//
// The wrangler configs in this repo declare `.svg` files as Text modules
// (`rules: [{ type: "Text", globs: ["**/*.txt", "**/*.svg"] }]`). Alchemy's
// bundler currently hardcodes Text handling to `.txt`/`.html`/`.sql`, so an
// `.svg` import would fail to resolve. Until alchemy honors wrangler-style
// module rules (TODO upstream: alchemy-run/alchemy — configurable Text rules
// + `.svg` content type), this script copies each `x.svg` to `x.svg.txt` and
// rewrites import specifiers accordingly. Idempotent.
import { readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: fix-text-modules.mjs <dir>");
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
  process.exit(0); // nothing to fix
}

for (const file of files) {
  if (file.endsWith(".svg")) {
    copyFileSync(file, `${file}.txt`);
  }
}
for (const file of files) {
  if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
  const source = readFileSync(file, "utf8");
  const fixed = source.replace(/(from\s+["'][^"']*\.svg)(["'])/g, "$1.txt$2");
  if (fixed !== source) {
    writeFileSync(file, fixed);
  }
}
