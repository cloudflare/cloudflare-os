// Vite+ per-package settings. `test` runs two vitest projects -- pure logic in Node, Workers-API
// modules in workerd -- kept as separate commands so one can replay from the task cache while the
// other reruns. Tasks and scripts cannot share a name, so package.json declares neither name.
import { vitestTask } from "@gadgets/scripts/vitest-task";

const testTask = vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]);

export default {
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`, so automatic tracking sees only sources.
      build: { command: "tsc" },
      // Uncached: a cache hit restores archived outputs but never deletes files.
      clean: { command: "rm -rf dist", cache: false },
      test: {
        ...testTask,
        // The property suites' seed (@gadgets/scripts/property-runs) decides which cases run, so it
        // is passed and fingerprinted: a different seed is a cache miss, not a replayed result.
        cache: { ...testTask.cache, env: [...testTask.cache.env, "FAST_CHECK_SEED"] },
      },
    },
  },
};
