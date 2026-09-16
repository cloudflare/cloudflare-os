// Signal a process and every descendant it has.
//
// Adapted from node-tree-kill v1.2.2 (https://github.com/pkrumins/node-tree-kill), MIT.
// Copyright (c) 2018 Peter Krumins
//
// Inlined rather than depended on, and with three deliberate deviations from upstream: a
// promise-returning API instead of a callback, `execFile` with an argv array for `taskkill` so no
// shell parses an interpolated pid, and a guard on the child-lister producing no pids (see below).
//
// `node:child_process` `kill()` signals one process, which is not enough for anything here that
// spawns through a wrapper: `pnpm exec vp run ...` and `node build-app.mjs --watch` (which itself
// runs `pnpm exec vite build --watch`) both leave the real worker running when only the wrapper is
// signalled.

import { execFile, spawn } from "node:child_process";

// The pids a child-lister prints for one parent. Resolves empty when the parent has no children or
// the lister reports failure -- `pgrep` exits 1 for "no matches", which is not an error here.
function listChildren(command: string, args: string[]): Promise<number[]> {
  return new Promise<number[]>(resolve => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("ascii"); });
    // `error` fires instead of `close` when the lister binary is missing.
    child.on("error", () => resolve([]));
    child.on("close", code => {
      // Upstream (index.js:108) calls `.forEach` straight on the match result, which throws when the
      // lister exits 0 having printed no pids. That throw happens inside this handler, so it would
      // surface as an uncaught exception rather than a rejection a caller could catch.
      if (code !== 0) return resolve([]);
      resolve((output.match(/\d+/g) ?? []).map(pid => parseInt(pid, 10)));
    });
  });
}

function childListerFor(pid: number): [string, string[]] {
  return process.platform === "darwin"
    ? ["pgrep", ["-P", String(pid)]]
    : ["ps", ["-o", "pid=", "--ppid", String(pid)]];
}

/**
 * Every pid in `pid`'s tree, `pid` included, collected breadth-first.
 */
export async function collectTree(pid: number): Promise<number[]> {
  const collected = new Set<number>([pid]);
  let frontier = [pid];
  while (frontier.length > 0) {
    const listed = await Promise.all(
      frontier.map(parent => listChildren(...childListerFor(parent))));
    frontier = listed.flat().filter(child => !collected.has(child));
    for (const child of frontier) collected.add(child);
  }
  return [...collected];
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // Already gone, which is the outcome we wanted.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

// Whether `pid` still exists. Signal 0 delivers nothing and only checks for the process.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Sends `signal` to `pid` and every descendant it has. */
export async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  // Upstream's fix for their #31, tightened: their parseInt guard still let through 0, negatives
  // and partially-numeric strings like "12abc", and a bad pid reaching `process.kill` is far worse
  // than an error, since kill(0) and negative values address entire process groups.
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");

  if (process.platform === "win32") {
    // `/T` kills the tree for us. An argv array rather than upstream's interpolated `exec` string.
    await new Promise<void>(resolve => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
    });
    return;
  }

  // The whole tree is collected *before* anything is signalled, and this ordering is load-bearing:
  // killing the wrapper first reparents its children to pid 1, after which `pgrep -P <wrapper>`
  // returns nothing and the rest of the subtree can no longer be found. That is also why callers
  // must not kill the process themselves before calling this.
  for (const treePid of await collectTree(pid)) signalPid(treePid, signal);
}

/**
 * Sends `initialSignal` (SIGTERM by default) to `pid` and every descendant, then SIGKILLs whatever
 * is still alive after `graceMs`. Resolves once the tree is gone or the escalation has been
 * delivered.
 *
 * For callers that cannot afford to wait on a descendant which ignores the first signal -- one
 * holding an inherited stdout pipe keeps the parent's `close` event from ever firing.
 *
 * `initialSignal` is for the caller relaying a signal it received itself (`relay-termination.ts`):
 * in the Ctrl-C case the child already got SIGINT from the tty's process group, and sending it a
 * SIGTERM instead would cut its own handling of that interrupt short. Named `initialSignal` rather
 * than `signal` to keep it distinct from the `forceSignal` `AbortSignal` beside it. win32 ignores
 * it, since `taskkill /T /F` is an unconditional tree kill with nothing to escalate from.
 *
 * An aborted `forceSignal` gives up the rest of the grace period and escalates now. It exists for
 * the caller who is about to exit and needs the SIGKILL delivered first: this call holds the only
 * usable list of the tree's pids (see the capture below), so abandoning it mid-grace leaks whatever
 * it had left to kill.
 */
export async function killProcessTreeEscalating(
  pid: number,
  { graceMs = 5_000, forceSignal, initialSignal = "SIGTERM" }:
      { graceMs?: number; forceSignal?: AbortSignal; initialSignal?: NodeJS.Signals } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");

  // `taskkill /T /F` is already an unconditional tree kill, so there is nothing to escalate to.
  if (process.platform === "win32") return killProcessTree(pid, "SIGKILL");

  // Collected once, for the reason killProcessTree documents above -- and here the single walk is
  // what makes escalation possible at all. Re-walking after the first signal would find nothing: the
  // wrapper dies first and reparents the very survivors we are escalating against, so the SIGKILL
  // has to go to this captured list rather than to a fresh tree.
  const tree = await collectTree(pid);
  for (const treePid of tree) signalPid(treePid, initialSignal);

  // Polled rather than a flat sleep so the ordinary case -- everything dies to the first signal --
  // does not pay the grace period. A pid could in principle be recycled onto an unrelated process
  // inside the window and be signalled below; the existing walk has the same exposure, and a window
  // this short against pids that were this process's own descendants makes it not worth guarding.
  const deadline = Date.now() + graceMs;
  let survivors = tree.filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    // Checked here rather than in the condition above, where it reads as an unmodified loop
    // variable: what changes is `.aborted`, not the signal.
    if (forceSignal?.aborted) break;
    await new Promise(resolve => setTimeout(resolve, 25));
    survivors = survivors.filter(isAlive);
  }
  for (const treePid of survivors) signalPid(treePid, "SIGKILL");
}
