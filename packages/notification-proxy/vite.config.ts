import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

export default defineConfig({
  run: {
    tasks: {
      test: vitestTask("vitest run"),
    },
  },
});
