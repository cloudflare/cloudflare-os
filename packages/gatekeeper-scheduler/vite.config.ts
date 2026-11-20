import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/** Vite+ settings for this package. */
export default defineConfig({
  run: {
    tasks: {
      // Shared by every package whose tests run under vitest; see the module for why the two
      // vitest scratch paths have to be excluded for this to cache at all.
      test: vitestTask(["vitest run"]),
    },
  },
});
