import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { pnpmCommand } from "@gadgets/scripts/pnpm-command";
import { isWorkerInput } from "./worker-inputs.js";

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

  const { vitest } = project;

  // Vite+ owns the initial build. A watch process stays alive, so later reruns invoke that task here.
  project.onTestsRerun(async () => {
    // The rebuild rewrites `.wrangler/validate` in place, and a rerun does not cancel the run it
    // replaces -- it awaits that run, then reports it. Vitest's watcher waits the run out before it
    // ever reaches this handler, but the rerun entry points that skip the watcher (`r` in the
    // terminal, and the UI) call handlers first and only wait inside the run that follows, which
    // would leave the rebuild overwriting files the still-running Workers are booting from. Waiting
    // here rather than at a call site covers all of them, and costs nothing: the rerun is blocked
    // on this same run either way.
    await vitest.waitForTestRunEnd();
    rebuildWorkshopForWatch();
  });

  // Deleting a Worker input has to rerun the suite too, and `forceRerunTriggers` does not cover it:
  // vitest's `onFileDelete` invalidates its module state without ever consulting them (only the
  // change and create paths do). Handing the path to `onFileChange` is the whole of the gap. That is
  // the path that consults them, so the deletion joins whatever rerun the watcher already has
  // queued -- one debounce timer, one `changedTests` set, one wait on the active run, all vitest's.
  // A rename, which fires `unlink` then `add`, therefore collapses into a single rerun no matter how
  // the two events interleave with a run in progress.
  //
  // Prepended because `onFileChange` bails on any path already in `watcher.invalidates`, and
  // vitest's own `unlink` listener -- registered at startup, long before this global setup runs --
  // puts it there.
  const onUnlink = (path: string) => {
    if (isWorkerInput(path)) vitest.watcher.onFileChange(path);
  };
  vitest.vite.watcher.prependListener("unlink", onUnlink);

  return () => {
    vitest.vite.watcher.off("unlink", onUnlink);
    delete process.env.WORKSHOP_INTEGRATION_PREBUILT;
  };
}
