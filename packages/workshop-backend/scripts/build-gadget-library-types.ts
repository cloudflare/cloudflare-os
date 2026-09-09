// Emits the TypeScript declarations of every gadget library, one tree per side, into
// `dist/gadget-library-types/<side>/` (see GADGET_LIBRARY_TYPES_DIR for why not `src/generated`).
// `build-gadget-libraries.ts` reads them into the
// generated module so the agent's `describeGadgetLibrary` tool can show a library's interface --
// with its doc comments, which esbuild strips from every bundle whatever the minify settings, and
// which declaration emit keeps.
//
// The programs are the libraries' own `tsconfig.client.json` and `tsconfig.server.json`, so the
// declarations come out of the same type check the package's `build` runs, one per side because
// the two sides compile under different globals. The configs say `noEmit`; the command line
// overrides that here. Each side's tree is cleared first, so a module that was deleted leaves no
// declaration behind to ship.

import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LIBRARY_SIDES } from "../src/gadget-libraries.ts";
import {
  GADGET_LIBRARIES_DIR, GADGET_LIBRARY_TYPES_DIR, librarySideTypesDir,
} from "./gadget-libraries-source.ts";

// The package's own `tsc` (tsgo), not whatever is on PATH: a cached `vp` task runs with a
// stripped environment, and by hand this script runs from any directory.
// Resolved from the package's `package.json` rather than as a subpath import, which its `exports`
// map does not offer.
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

for (const side of LIBRARY_SIDES) {
  const outDir = librarySideTypesDir(side);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  execFileSync(process.execPath, [
    tsc, "--project", join(GADGET_LIBRARIES_DIR, `tsconfig.${side}.json`),
    "--declaration", "--emitDeclarationOnly", "--noEmit", "false", "--outDir", outDir,
  ], { stdio: "inherit" });
}
console.log(`Emitted gadget library declarations for ${LIBRARY_SIDES.join(" and ")} -> ` +
    GADGET_LIBRARY_TYPES_DIR);
