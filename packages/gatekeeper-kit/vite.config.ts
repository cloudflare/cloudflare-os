// Vite+ per-package settings. Two vitest projects -- pure logic in Node, Workers-API modules in
// workerd -- kept as separate commands so one can replay from the task cache while the other reruns.
import vitestTaskViteConfig from "../../scripts/vitest-task-vite-config.js";

export default vitestTaskViteConfig(["vitest run", "vitest run -c vitest.worker.config.ts"]);
