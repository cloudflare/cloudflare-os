// Makes `vendor/pdfium/pdfium-metered.wasm`, the PDFium build the renderer runs, from the
// `lib/pdfium.wasm` of the pdfium-binaries release that `vendor/pdfium/README.md` names: the
// same module with a work counter added to it, which is what bounds a call into PDFium.
//
//   node scripts/meter-pdfium.ts <path to the upstream pdfium.wasm>
//
// The file is refused unless its sha256 is the one pinned here, so that the build can only be
// made from the release whose provenance was verified; the README has the steps that verify it.
// Nothing of the file is run: its bytes are read, and the counter's are put among them. The size
// and sha256 of what was written are printed, and `__tests__/pdfium-vendor.test.ts` holds the
// committed file to them.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { metered } from "./pdfium-meter.ts";

const OUTPUT = new URL("../vendor/pdfium/pdfium-metered.wasm", import.meta.url);
/** The sha256 of `lib/pdfium.wasm` in the release that is vendored. */
const UPSTREAM_SHA256 = "0a7f7ec0a395264fd6f4354ff9caabe2b36f64b7c6d1f492d6ff313d573c7378";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let [upstreamFile, ...rest] = process.argv.slice(2);
if (upstreamFile === undefined || rest.length > 0) {
  console.error("usage: node scripts/meter-pdfium.ts <path to the upstream pdfium.wasm>");
  process.exit(2);
}
let upstream = new Uint8Array(await readFile(upstreamFile));
if (sha256(upstream) !== UPSTREAM_SHA256) {
  console.error(`The file's sha256 is ${sha256(upstream)}, not the pinned ${UPSTREAM_SHA256}: ` +
    "it is not the pdfium.wasm of the vendored release, so no build was made from it.");
  process.exit(1);
}
let build = metered(upstream);
await writeFile(OUTPUT, build);
console.log(`Wrote vendor/pdfium/pdfium-metered.wasm: ${build.byteLength} bytes, sha256 ${sha256(build)}.`);
