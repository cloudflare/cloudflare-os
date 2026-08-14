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
function listChildren(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString("ascii"); });
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

function childListerFor(pid) {
  return process.platform === "darwin"
    ? ["pgrep", ["-P", String(pid)]]
    : ["ps", ["-o", "pid=", "--ppid", String(pid)]];
}

// Every pid in `pid`'s tree, `pid` included, collected breadth-first.
async function collectTree(pid) {
  const collected = new Set([pid]);
  let frontier = [pid];
  while (frontier.length > 0) {
    const listed = await Promise.all(
      frontier.map(parent => listChildren(...childListerFor(parent))));
    frontier = listed.flat().filter(child => !collected.has(child));
    for (const child of frontier) collected.add(child);
  }
  return [...collected];
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // Already gone, which is the outcome we wanted.
    if (error.code !== "ESRCH") throw error;
  }
}

/** Sends `signal` to `pid` and every descendant it has. */
export async function killProcessTree(pid, signal = "SIGTERM") {
  // Upstream's fix for their #31, tightened: their parseInt guard still let through 0, negatives
  // and partially-numeric strings like "12abc", and a bad pid reaching `process.kill` is far worse
  // than an error, since kill(0) and negative values address entire process groups.
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");

  if (process.platform === "win32") {
    // `/T` kills the tree for us. An argv array rather than upstream's interpolated `exec` string.
    await new Promise(resolve => {
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
