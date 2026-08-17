import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { killProcessTree } from "./kill-process-tree.ts";

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

describe("killProcessTree", () => {
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
});
