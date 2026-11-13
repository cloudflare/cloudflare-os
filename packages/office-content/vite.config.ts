// Vite+ per-package settings. Tasks and scripts cannot share a name, so package.json declares
// neither name.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      // A pure typecheck: the root tsconfig sets `noEmit`, so automatic tracking sees only sources.
      build: { command: "tsc" },
    },
  },
}, ["vitest run"]);
