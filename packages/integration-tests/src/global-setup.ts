import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { pnpmCommand } from "../../../scripts/pnpm-command.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATED_ENTRIES = [
  join(PACKAGE_DIR, "../workshop-backend/.wrangler/validate/src/server.ts"),
  join(PACKAGE_DIR, "fixtures/gatekeeper-test/.wrangler/validate/src/test-gatekeeper.ts"),
];

function rebuildWorkshopForWatch(): void {
  const [command, args] = pnpmCommand(["run", "test:prebuild"]);
  execFileSync(command, args, { cwd: PACKAGE_DIR, stdio: "inherit" });
}

/** Share validated Worker builds across isolated test-file processes. */
export default function setup(project: TestProject): () => void {
  const missingEntries = VALIDATED_ENTRIES.filter(entry => !existsSync(entry));
  if (missingEntries.length > 0) {
    throw new Error(`Integration-test builds did not produce: ${missingEntries.join(", ")}`);
  }
  process.env.WORKSHOP_INTEGRATION_PREBUILT = "1";
  // Vite+ owns the initial build. A watch process stays alive, so later reruns invoke that task here.
  project.onTestsRerun(rebuildWorkshopForWatch);
  return () => { delete process.env.WORKSHOP_INTEGRATION_PREBUILT; };
}
