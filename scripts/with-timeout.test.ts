import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WITH_TIMEOUT = join(dirname(fileURLToPath(import.meta.url)), "with-timeout.ts");

// Far beyond any wait here, so no case depends on a threshold firing under load (what made the
// suite #359 removed flaky): every case is triggered by a signal the test sends.
const THRESHOLDS = ["--idle", "300", "--max", "600"];

// Well above the expected sub-second waits, and above the watchdog's 5s grace.
const STARTUP_TIMEOUT_MS = 20_000;
const GONE_TIMEOUT_MS = 15_000;

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntilGone(pid: number, timeoutMs = GONE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

/** `promise`, or a rejection naming `what` once `timeoutMs` has passed without it settling. */
async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// `process.stdout.write`, not `console.log`, which colors numbers under FORCE_COLOR (see #359).

/** Spawns an idle grandchild, then reports the back's, its own and the grandchild's pids. */
const SPAWNS_GRANDCHILD = `const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"],
        { stdio: "ignore" });
    process.stdout.write("pids " + process.ppid + " " + process.pid + " " + grandchild.pid + "\\n");
    setInterval(() => {}, 60_000);`;

interface Run {
  /** The process `vp run` would have spawned: the watchdog's front. */
  frontPid: number;
  /** The front's own termination, as the OS reported it. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything written to stdout so far. */
  output: () => string;
  /** The first match of `pattern` in that output, or `null` once the stream ends or time is up. */
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpExecArray | null>;
}

/** Runs the watchdog as a Vite+ task does: its own process, output through a pipe. */
function startWatchdog(command: string[]): Run {
  const front = spawn(process.execPath, [WITH_TIMEOUT, ...THRESHOLDS, "--", ...command], {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const frontPid = front.pid;
  assert.ok(frontPid, "the watchdog was not spawned");

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    front.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // Polled, not read with `for await`: abandoning the iterator would close the back's pipe.
  let text = "";
  let ended = false;
  front.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  front.stdout.on("close", () => { ended = true; });

  const waitForOutput = async (pattern: RegExp, timeoutMs = STARTUP_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(text);
      if (match || ended || Date.now() >= deadline) return match;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  return { frontPid, exit, output: () => text, waitForOutput };
}

/** The back's, the command's and the grandchild's pids, as `SPAWNS_GRANDCHILD` reports them. */
async function treePids(run: Run): Promise<[number, number, number]> {
  const match = await run.waitForOutput(/^pids (\d+) (\d+) (\d+)$/m);
  assert.ok(match,
      `the command never reported its pids; stdout so far: ${JSON.stringify(run.output())}`);
  const [back, command, grandchild] = match.slice(1).map(Number);
  return [back, command, grandchild];
}

// By pid: once the front dies its descendants reparent away, and a leak holds `node --test` open.
function killAll(pids: number[]): void {
  for (const pid of pids) {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

describe("with-timeout", {
  skip: process.platform === "win32" ? "these signal fixtures are POSIX-only" : false,
}, () => {
  // vp's fast-fail SIGKILLs the front; the single-process watchdog left the tree running here.
  it("takes the command's whole tree down when the front is SIGKILLed", async () => {
    const run = startWatchdog(["node", "-e", SPAWNS_GRANDCHILD]);
    const pids = [run.frontPid];
    try {
      const [back, command, grandchild] = await treePids(run);
      pids.push(back, command, grandchild);

      process.kill(run.frontPid, "SIGKILL");
      assert.ok(await waitUntilGone(command), "the command outlived the front's SIGKILL");
      assert.ok(await waitUntilGone(grandchild), "the grandchild outlived the front's SIGKILL");
      assert.ok(await waitUntilGone(back), "the back outlived the tree it tore down");
    } finally {
      killAll(pids);
    }
  });

  // A signal to the front alone still tears the tree down, and is reported as before.
  it("tears the tree down and exits 143 when the front is SIGTERMed", async () => {
    const run = startWatchdog(["node", "-e", SPAWNS_GRANDCHILD]);
    const pids = [run.frontPid];
    try {
      const [back, command, grandchild] = await treePids(run);
      pids.push(back, command, grandchild);

      process.kill(run.frontPid, "SIGTERM");
      assert.ok(await waitUntilGone(command), "the command outlived the front's SIGTERM");
      assert.ok(await waitUntilGone(grandchild), "the grandchild outlived the front's SIGTERM");
      assert.deepEqual(
          await within(run.exit, GONE_TIMEOUT_MS, "the front did not exit after its SIGTERM"),
          { code: 143, signal: null });
      assert.ok(await waitUntilGone(back), "the back outlived the front");
    } finally {
      killAll(pids);
    }
  });

  it("exits with the command's own code, and keeps the lifeline out of the command", async () => {
    const run = startWatchdog(["node", "-e",
      "process.stdout.write('channel ' + process.env.NODE_CHANNEL_FD + ' ' + " +
      "typeof process.send + '\\n'); process.exitCode = 3"]);
    try {
      // Read before the exit status: the front's `exit` can land before the last of the pipe has.
      assert.ok(await run.waitForOutput(/^channel .*$/m),
          "the command never reported its environment; " +
          `stdout so far: ${JSON.stringify(run.output())}`);
      assert.match(run.output(), /^channel undefined undefined$/m);
      assert.deepEqual(
          await within(run.exit, STARTUP_TIMEOUT_MS, "the front did not exit after its command"),
          { code: 3, signal: null });
    } finally {
      killAll([run.frontPid]);
    }
  });
});
