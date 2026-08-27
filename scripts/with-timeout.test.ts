import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WITH_TIMEOUT = join(dirname(fileURLToPath(import.meta.url)), "with-timeout.ts");

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/** Resolves with the first match of `pattern` in the run's stdout so far. */
type AwaitStdout = (pattern: RegExp) => Promise<RegExpExecArray>;

// The wrapper under test, run the way a Vite+ task runs it: as its own process, output captured
// through a pipe. `cwd` defaults to a directory with no workspace `node_modules`, so a command that
// is not `node` falls through to PATH rather than resolving a bin entry.
function runWrapper(args: string[], cwd = tmpdir()): Promise<Run> & { awaitStdout: AwaitStdout } {
  const child = spawn(process.execPath, [WITH_TIMEOUT, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const finished = new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  // Polled rather than consumed with `for await`: breaking out of an async iterator destroys the
  // stream, which closes the pipe the wrapper is writing to.
  const awaitStdout: AwaitStdout = async pattern => {
    for (;;) {
      const match = pattern.exec(stdout);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  return Object.assign(finished, { awaitStdout });
}

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

/** A `node -e` body that prints `text` every 50ms for `forMs`, then exits 0. */
function chatty(text: string, forMs: number | "forever"): string {
  const stop = forMs === "forever" ? "" :
    `setTimeout(() => { clearInterval(t); process.exit(0); }, ${forMs});`;
  return `const t = setInterval(() => console.log(${JSON.stringify(text)}), 50); ${stop}`;
}

const IDLE = "setTimeout(() => {}, 60_000)";

describe("with-timeout", () => {
  it("propagates the child's exit code", async () => {
    const zero = await runWrapper(["--idle", "10", "--max", "20", "--", "node", "-e", ""]);
    assert.equal(zero.code, 0);

    const nonZero = await runWrapper(
        ["--idle", "10", "--max", "20", "--", "node", "-e", "process.exit(3)"]);
    assert.equal(nonZero.code, 3);
  });

  it("forwards the child's stdout and stderr", async () => {
    const run = await runWrapper(["--idle", "10", "--max", "20", "--", "node", "-e",
      "console.log('out'); console.error('err')"]);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /out/);
    assert.match(run.stderr, /err/);
  });

  it("resolves `node` to this executable without a bin lookup", async () => {
    // From a cwd with no workspace node_modules, so nothing could have been resolved as a bin.
    const run = await runWrapper(
        ["--idle", "10", "--max", "20", "--", "node", "-p", "process.execPath"]);
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trim(), process.execPath);
  });

  it("lets output reset the idle timer", async () => {
    // Chatty for well over the idle window: each chunk re-arms it, so this must run to completion.
    const run = await runWrapper(
        ["--idle", "0.4", "--max", "30", "--", "node", "-e", chatty("tick", 1_200)]);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /with-timeout:/);
  });

  it("kills a silent child at the idle threshold", async () => {
    const startedAt = Date.now();
    const run = await runWrapper(["--idle", "0.5", "--max", "30", "--", "node", "-e", IDLE]);
    assert.equal(run.code, 124);
    assert.match(run.stderr, /no output for 0\.5s/);
    // The total cap must not be what fired.
    assert.ok(Date.now() - startedAt < 20_000, "the idle threshold did not fire");
  });

  it("kills a chatty but endless child at the total threshold", async () => {
    const run = await runWrapper(
        ["--idle", "30", "--max", "1", "--", "node", "-e", chatty("tick", "forever")]);
    assert.equal(run.code, 124);
    assert.match(run.stderr, /still running for 1s/);
  });

  it("reaps a hung grandchild and reports the surviving tree", async () => {
    // The workerd case: the command itself is a wrapper, and the process that is actually stuck is
    // its child. Same shape as `kill-process-tree.test.ts`'s `spawnWrapper` -- the grandchild's pid
    // comes back over stdout, since that is the only handle a caller would have on it.
    const pending = runWrapper(["--idle", "0.5", "--max", "30", "--", "node", "-e",
      `const { spawn } = require("node:child_process");
       const child = spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });
       console.log(child.pid);
       ${IDLE}`,
    ]);

    const grandchildPid = Number((await pending.awaitStdout(/\d+/))[0]);
    assert.ok(grandchildPid, "the command never reported a grandchild pid");

    try {
      const run = await pending;
      assert.equal(run.code, 124);
      assert.match(run.stderr, /surviving processes \(2\)/);
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild outlived the timeout");
    } finally {
      // By pid: once the wrapper is gone the grandchild reparents away and could not be found.
      if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    }
  });

  it("rejects a missing or malformed threshold", async () => {
    for (const args of [
      ["--max", "10", "--", "node", "-e", ""],
      ["--idle", "10", "--", "node", "-e", ""],
      ["--idle", "nope", "--max", "10", "--", "node", "-e", ""],
      ["--idle", "10", "--max", "10", "--"],
    ]) {
      const run = await runWrapper(args);
      assert.equal(run.code, 2, `expected a usage error for: ${args.join(" ")}`);
    }
  });
});
