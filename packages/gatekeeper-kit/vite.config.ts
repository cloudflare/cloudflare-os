// Vite+ per-package settings. `test` runs two vitest projects -- pure logic in Node, Workers-API
// modules in workerd -- kept as separate commands so one can replay from the task cache while the
// other reruns. Tasks and scripts cannot share a name, so package.json declares neither name.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`, so automatic tracking sees only sources.
      build: { command: "tsc" },
      // Uncached: a cache hit restores archived outputs but never deletes files.
      clean: { command: "rm -rf dist", cache: false },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
