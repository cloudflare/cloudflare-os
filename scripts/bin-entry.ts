// Locate the JS entry point behind a `node_modules/.bin/<bin>` shim, so a tool can be spawned as
// `node <entry>` rather than reached through `pnpm exec`.
//
// Two reasons callers want that. Speed: `pnpm exec` costs ~0.33s of process startup per call, which
// for most of these builds is longer than the build itself. Portability: the `.bin` shim is a `.cmd`
// file on Windows, which Node cannot spawn without a shell, and the `npm_execpath` fallback in
// pnpm-command.ts is unavailable inside a Vite+ task -- `vp` runs task commands with a filtered
// environment that does not include it.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Absolute path to the JS entry point behind `node_modules/.bin/<bin>`, or null if it cannot be
 * found. Resolved from `pkgDir`'s own node_modules so pnpm's per-package layout is respected.
 */
export function resolveBinEntry(pkgDir: string, bin: string): string | null {
  try {
    const manifestPath = realpathSync(join(pkgDir, "node_modules", bin, "package.json"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
    if (!relative) return null;
    const entry = join(dirname(manifestPath), relative);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}
