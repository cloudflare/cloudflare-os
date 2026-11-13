import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the type checks of the Worker and of its tests as one `build` task,
 * and separate Node and workerd test passes, so one can replay from the task cache when only the
 * other's inputs moved.
 */
export default {
  run: {
    tasks: {
      build: { command: ["tsc", "tsc -p tsconfig.test.json"] },
      test: vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
    },
  },
};
