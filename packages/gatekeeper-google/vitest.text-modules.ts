import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Wrangler ships `*.txt` imports as Text modules, but these pools are driven from inline miniflare
 * settings, where Vite would resolve an agent type `.txt`, a symlink to its `.d.ts`, to that file
 * and send it through the TypeScript pipeline, leaving the import `undefined`, and would run a
 * preview's `.txt`, a symlink to its `.js`, as a module. Resolving by the import path, as wrangler
 * does, keeps Vite from following the link.
 */
export const textModules: Plugin = {
  name: "text-modules",
  enforce: "pre",
  resolveId(source, importer) {
    if (source.endsWith(".txt") && importer !== undefined) {
      // A module already loaded is asked for again by its path from the package's root.
      return source.startsWith("/") && !existsSync(source)
        ? path.join(import.meta.dirname, source)
        : path.resolve(path.dirname(importer), source);
    }
  },
  load(id) {
    if (id.endsWith(".txt")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf-8"))};`;
    }
  },
};
