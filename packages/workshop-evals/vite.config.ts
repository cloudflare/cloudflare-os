import vitestTaskViteConfig from "../../scripts/vitest-task-vite-config.js";

/**
 * `evals/chat-views.test.ts` reports once, when the file ends, and its failing cases wait out the
 * view checks' time limits: the file took 105 s with 2 workers on a laptop and 114 s on CI on
 * 2026-11-09.
 */
export default vitestTaskViteConfig({ command: "vitest run --config vitest.config.ts", idleSeconds: 240 });
