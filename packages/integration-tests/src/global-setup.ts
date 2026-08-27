import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { pnpmCommand } from "../../../scripts/pnpm-command.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATED_ENTRY = join(PACKAGE_DIR, "../workshop-backend/.wrangler/validate/src/server.ts");

function rebuildWorkshopForWatch(): void {
  const [command, args] = pnpmCommand(["run", "test:prebuild"]);
  execFileSync(command, args, { cwd: PACKAGE_DIR, stdio: "inherit" });
}

/** Share one validated Worker build across isolated test-file processes. */
export default function setup(project: TestProject): () => void {
  if (!existsSync(VALIDATED_ENTRY)) {
    throw new Error("The integration-test Workshop build did not produce its validated entrypoint");
  }
  process.env.WORKSHOP_INTEGRATION_PREBUILT = "1";
  // Vite+ owns the initial build. A watch process stays alive, so later reruns invoke that task here.
  project.onTestsRerun(rebuildWorkshopForWatch);
  return () => { delete process.env.WORKSHOP_INTEGRATION_PREBUILT; };
}
