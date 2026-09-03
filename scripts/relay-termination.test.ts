import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELAY = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "relay-termination.ts"));

// Fixture wrappers go under the OS temp directory, never in the workspace: this suite's `input` is
// workspace-wide (see `scripts/vite.config.ts`), so writing in here would be writing its own task
// input. Same discipline as `bin-entry.test.ts`.
const fixtureRoot = mkdtempSync(join(tmpdir(), "relay-termination-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let caseCount = 0;

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

const IDLE = "setTimeout(() => {}, 60_000)";
// Whatever survives the forwarded signal is what the escalation exists for.
const IGNORES_SIGNALS =
    "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); " + IDLE;

interface Wrapper {
  /** The process under test: it spawns `child`, which spawns `grandchild`, then relays. */
  wrapperPid: number;
  childPid: number;
  grandchildPid: number;
  /** The wrapper's own termination, as the OS reported it. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cleanUp: () => void;
}

/**
 * A `vp run`-shaped tree under `relayTermination`: the wrapper spawns a child, which spawns an idle
 * grandchild -- the descendant that a signal delivered only to the wrapper would orphan. Both pids
 * come back over the wrapper's stdout, since that is the only handle a caller has on them.
 *
 * `childBody` is a `node -e` body evaluated in the child; `grandchildBody` in the grandchild.
 */
async function spawnWrapper(
  { grandchildBody = IDLE, childBody = IDLE, graceMs }: {
    grandchildBody?: string;
    childBody?: string;
    graceMs?: number;
  } = {},
): Promise<Wrapper> {
  const dir = join(fixtureRoot, `case-${++caseCount}`);
  mkdirSync(dir, { recursive: true });

  // The child prints its grandchild's pid; the wrapper forwards that line on and adds its own pid,
  // so one stdout stream carries all three.
  const child = join(dir, "child.mjs");
  writeFileSync(child, `
    import { spawn } from "node:child_process";
    const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildBody)}],
        { stdio: "ignore" });
    process.stdout.write("grandchild " + grandchild.pid + "\\n");
    ${childBody}
  `);

  const wrapper = join(dir, "wrapper.mjs");
  writeFileSync(wrapper, `
    import { spawn } from "node:child_process";
    import { relayTermination } from ${JSON.stringify(RELAY.href)};
    const child = spawn(process.execPath, [${JSON.stringify(child)}],
        { stdio: ["ignore", "inherit", "ignore"] });
    process.stdout.write("child " + child.pid + "\\n");
    relayTermination(child${graceMs === undefined ? "" : `, { graceMs: ${graceMs} }`});
  `);

  const proc = spawn(process.execPath, [wrapper], { stdio: ["ignore", "pipe", "inherit"] });
  const wrapperPid = proc.pid;
  assert.ok(wrapperPid, "the wrapper was not spawned");

  let childPid = 0;
  let grandchildPid = 0;
  // Unconditional, and by pid rather than through the wrapper: once the wrapper dies its
  // descendants reparent away from it, so a leak could not be found later. `node --test` stays
  // alive as long as any spawned process does.
  const cleanUp = () => {
    for (const pid of [wrapperPid, childPid, grandchildPid]) {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  };

  // Attached before the pids are read, so an exit that races the handshake still settles it.
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    let output = "";
    for await (const chunk of proc.stdout) {
      output += String(chunk);
      childPid = Number(/^child (\d+)$/m.exec(output)?.[1] ?? 0);
      grandchildPid = Number(/^grandchild (\d+)$/m.exec(output)?.[1] ?? 0);
      if (childPid && grandchildPid) break;
    }
    assert.ok(childPid && grandchildPid, "the wrapper never reported both pids");
  } catch (error) {
    cleanUp();
    throw error;
  }
  return { wrapperPid, childPid, grandchildPid, exit, cleanUp };
}

// Concurrent for the reason `kill-process-tree.test.ts` is: these cases spend their time waiting on
// signalled processes to go away, not doing work. Each addresses its own tree by pid.
describe("relayTermination", { concurrency: true }, () => {
  // The bug this exists for: signalled at the wrapper alone -- `kill`, a process manager, a CI job
  // cancellation -- the old code died on the spot and left the whole tree below it running.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`forwards ${signal} to the whole tree and re-raises it`, async () => {
      const { wrapperPid, childPid, grandchildPid, exit, cleanUp } = await spawnWrapper();
      try {
        process.kill(wrapperPid, signal);
        assert.ok(await waitUntilGone(childPid), "the child outlived the forwarded signal");
        assert.ok(await waitUntilGone(grandchildPid), "the grandchild was orphaned");
        // The parent shell has to see the same termination it would have from the child itself.
        assert.deepEqual(await exit, { code: null, signal });
      } finally {
        cleanUp();
      }
    });
  }

  it("reaches a descendant that ignores the forwarded signal, via the escalation", async () => {
    const { wrapperPid, grandchildPid, exit, cleanUp } =
        await spawnWrapper({ grandchildBody: IGNORES_SIGNALS, graceMs: 250 });
    try {
      process.kill(wrapperPid, "SIGTERM");
      // The wrapper must outlive the tree it is responsible for: by the time it exits, the SIGKILL
      // the stubborn grandchild needed has been delivered.
      assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild survived the escalation");
    } finally {
      cleanUp();
    }
  });

  it("forwards the child's own exit code when nothing signalled us", async () => {
    const { exit, cleanUp } = await spawnWrapper({ childBody: "process.exit(37)" });
    try {
      assert.deepEqual(await exit, { code: 37, signal: null });
    } finally {
      cleanUp();
    }
  });

  it("re-raises the signal that killed the child", async () => {
    const { childPid, exit, cleanUp } = await spawnWrapper();
    try {
      process.kill(childPid, "SIGTERM");
      assert.deepEqual(await exit, { code: null, signal: "SIGTERM" });
    } finally {
      cleanUp();
    }
  });
});
