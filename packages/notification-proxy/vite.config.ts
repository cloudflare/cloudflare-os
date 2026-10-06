import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

export default defineConfig({
  // Not `.wrangler/validate`, the build's copy of src/.
  test: { include: ["src/*.test.ts"] },
  run: {
    tasks: {
      test: vitestTask("vitest run"),
    },
  },
});
