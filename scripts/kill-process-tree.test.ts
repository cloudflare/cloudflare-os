import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { killProcessTree, killProcessTreeEscalating } from "./kill-process-tree.ts";

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

// Concurrent for the reason `relay-termination.test.ts` is: these cases spend their time waiting on
// signalled processes to go away, not doing work, so in sequence the file costs the sum of those
// waits. Each spawns its own tree and addresses it by pid, so they cannot reach each other.
describe("killProcessTree", { concurrency: true }, () => {
  it("rejects a non-numeric pid rather than signalling a process group", async () => {
    await assert.rejects(
        killProcessTree("not-a-pid" as unknown as number), /pid must be a positive integer/);
  });

  it("rejects pids that would address process groups or only look numeric", async () => {
    // kill(0) signals the caller's own process group and negative pids signal group |pid|;
    // parseInt-style coercion would also accept "12abc" and signal an unrelated pid 12. The guard
    // exists for callers the type system does not check, so each value is cast to reach it.
    const rejected: unknown[] = [0, -123, "12abc", "123", 12.5, undefined];
    for (const pid of rejected) {
      await assert.rejects(killProcessTree(pid as number), /pid must be a positive integer/);
    }
  });

  it("resolves for a pid that is already gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const { pid } = child;
    assert.ok(pid, "the child was not spawned");
    await new Promise(resolve => child.on("exit", resolve));
    await waitUntilGone(pid);

    // ESRCH is the expected outcome here, not a failure.
    await killProcessTree(pid);
  });

  it("reaches a grandchild the wrapper's own death would hide", async () => {
    const { wrapperPid, grandchildPid, cleanUp } = await spawnWrapper(IDLE);
    try {
      await killProcessTree(wrapperPid);
      assert.ok(await waitUntilGone(wrapperPid), "the wrapper outlived the kill");
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild outlived the kill");
    } finally {
      cleanUp();
    }
  });
});

// A process that ignores SIGTERM, as a `node -e` body. Whatever survives the first signal is what
// escalation exists for.
const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000)";
const IDLE = "setTimeout(() => {}, 60_000)";

// A `pnpm exec`-shaped tree: a wrapper whose child does the real work. The grandchild's pid comes
// back over the wrapper's stdout, since that is the only handle a caller would have on it.
async function spawnWrapper(grandchildBody: string): Promise<{
  wrapperPid: number;
  grandchildPid: number;
  cleanUp: () => void;
}> {
  const wrapper = spawn(process.execPath, ["-e",
    `const { spawn } = require("node:child_process");
     const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildBody)}],
         { stdio: "ignore" });
     // The test runner sets FORCE_COLOR for a TTY; writing a number through console.log would add
     // an ANSI color code whose leading "33" could be mistaken for the pid below.
     process.stdout.write(String(child.pid) + "\\n");
     ${IDLE}`,
  ], { stdio: ["ignore", "pipe", "ignore"] });

  const wrapperPid = wrapper.pid;
  assert.ok(wrapperPid, "the wrapper was not spawned");
  let grandchildPid = 0;
  // Unconditional, and by pid rather than through the wrapper: once the wrapper dies its children
  // reparent away from it, so a leaked grandchild could not be found later. `node --test` stays
  // alive as long as any spawned process does.
  const cleanUp = () => {
    for (const pid of [wrapperPid, grandchildPid]) {
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  };

  try {
    let output = "";
    for await (const chunk of wrapper.stdout) {
      output += String(chunk);
      const printed = /^\d+$/.exec(output.trimEnd());
      if (printed) {
        grandchildPid = Number(printed[0]);
        break;
      }
    }
    assert.ok(grandchildPid, "the wrapper never reported a grandchild pid");
  } catch (error) {
    cleanUp();
    throw error;
  }
  return { wrapperPid, grandchildPid, cleanUp };
}

describe("killProcessTreeEscalating", { concurrency: true }, () => {
  it("SIGKILLs a descendant that ignored the SIGTERM", async () => {
    const { wrapperPid, grandchildPid, cleanUp } = await spawnWrapper(IGNORES_SIGTERM);
    try {
      // The regression this guards: the SIGTERM kills the wrapper, which reparents the grandchild
      // to pid 1, so a second `killProcessTree(wrapperPid, "SIGKILL")` walk would find nothing and
      // the grandchild would survive. Escalating over the pids captured by the first walk is what
      // reaches it.
      await killProcessTreeEscalating(wrapperPid, { graceMs: 250 });
      assert.ok(await waitUntilGone(wrapperPid), "the wrapper outlived the escalation");
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild outlived the escalation");
    } finally {
      cleanUp();
    }
  });

  it("reaps a tree that goes down on the SIGTERM without waiting out the grace", async () => {
    const { wrapperPid, grandchildPid, cleanUp } = await spawnWrapper(IDLE);
    try {
      const startedAt = Date.now();
      await killProcessTreeEscalating(wrapperPid, { graceMs: 10_000 });
      // Returning promptly is the point: the grace period is a ceiling on the stubborn case, not a
      // delay every caller pays.
      assert.ok(Date.now() - startedAt < 5_000, "waited out the grace for a tree that was gone");
      assert.ok(await waitUntilGone(wrapperPid), "the wrapper outlived the kill");
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild outlived the kill");
    } finally {
      cleanUp();
    }
  });

  it("escalates immediately when forceSignal aborts, instead of waiting out the grace", async () => {
    const { wrapperPid, grandchildPid, cleanUp } = await spawnWrapper(IGNORES_SIGTERM);
    try {
      // A caller about to call process.exit() cannot wait out a grace this long, and cannot deliver
      // the SIGKILL itself either -- by now the wrapper is dead and the grandchild reparented, so
      // only the pids captured in here can still reach it. Aborting is how it gets that SIGKILL
      // delivered before it goes.
      const force = new AbortController();
      const startedAt = Date.now();
      const escalation = killProcessTreeEscalating(
          wrapperPid, { graceMs: 60_000, forceSignal: force.signal });
      setTimeout(() => force.abort(), 100);
      await escalation;
      assert.ok(Date.now() - startedAt < 5_000, "waited out the grace despite the force signal");
      assert.ok(await waitUntilGone(grandchildPid), "the grandchild outlived the forced escalation");
    } finally {
      cleanUp();
    }
  });

  it("rejects pids that would address process groups", async () => {
    for (const pid of [0, -123, 12.5]) {
      await assert.rejects(
          killProcessTreeEscalating(pid), /pid must be a positive integer/);
    }
  });
});
