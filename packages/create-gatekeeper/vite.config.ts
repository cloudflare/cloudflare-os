// Vite+ per-package settings: a typecheck of the command, and its tests. The template is not
// compiled where it lies; the tests generate a package from it and compile that.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`.
      build: { command: "tsc" },
    },
  },
}, "vitest run");
