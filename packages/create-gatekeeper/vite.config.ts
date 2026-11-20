// Vite+ per-package settings: a typecheck of the command, and its tests. The template is not
// compiled where it lies; the tests generate a package from it, compile that, and run its
// connect flow in workerd. The workerd suite is not typechecked here: it imports the generated
// sources, which exist only while it runs.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, ["vitest run", "vitest run -c vitest.worker.config.ts"]);
