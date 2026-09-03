#!/usr/bin/env node
// Run a command under two watchdogs -- an idle timer on its output and a total wall-clock cap --
// and kill its whole process tree when either fires.
//
//     node ../../scripts/with-timeout.ts --idle <secs> --max <secs> -- <command> [args...]
//
// It exists because nothing else in the test stack bounds a wedged run. Vite+ has no task timeout
// (`vp run --help` offers only concurrency flags, and `timeout` appears nowhere in its docs), and
// vitest's `testTimeout`/`hookTimeout` are enforced *inside* the test worker, so they die with it;
// the one process-level watchdog, `teardownTimeout`, is armed after the run resolves and therefore
// never arms when the run is what hangs. Underneath that,
// `@cloudflare/vitest-pool-workers` imports Miniflare without passing `onWorkerdCrashRestart`, so a
// workerd that dies mid-run leaves the pool awaiting a reply that will never arrive. The result is
// an unbounded local hang, and in CI an anonymous job-level kill that names no culprit.
//
// Silence is the primary detector rather than wall-clock: a healthy `vitest run` prints a line per
// completed test file, and a wedged one goes quiet. The total cap is the backstop for a command
// that stays chatty while looping forever.
//
// Exit codes: 124 when a threshold fired (GNU `timeout`'s, and distinct from any vitest code), the
// child's own code otherwise, or `128 + signal` when the child or this wrapper was signalled.

import { execFile, spawn } from "node:child_process";
import { constants } from "node:os";
import { resolveBinEntry } from "./bin-entry.ts";
import { collectTree, killProcessTreeEscalating } from "./kill-process-tree.ts";

/** Exit status for a threshold firing, matching GNU `timeout`. */
const TIMED_OUT_EXIT_CODE = 124;

/** How long a signalled tree gets to exit on its own before the SIGKILL. */
const KILL_GRACE_MS = 5_000;

const USAGE = "usage: with-timeout.ts --idle <secs> --max <secs> -- <command> [args...]";

type Options = {
  idleMs: number;
  maxMs: number;
  argv: string[];
};

// Both thresholds are required rather than defaulted: the numbers are policy, and a caller that
// forgot one should not silently get a different bound than it asked for. Fractional seconds are
// accepted so the tests can drive this with sub-second thresholds.
function parseArgs(args: string[]): Options {
  let idleMs: number | undefined;
  let maxMs: number | undefined;
  let index = 0;
  for (; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--") {
      index++;
      break;
    }
    const value = args[++index];
    if (flag === "--idle") idleMs = parseSeconds(flag, value);
    else if (flag === "--max") maxMs = parseSeconds(flag, value);
    else fail(`unknown option ${flag}\n${USAGE}`);
  }
  const argv = args.slice(index);
  if (idleMs === undefined || maxMs === undefined) fail(`--idle and --max are both required\n${USAGE}`);
  if (argv.length === 0) fail(`no command given\n${USAGE}`);
  return { idleMs, maxMs, argv };
}

function parseSeconds(flag: string, value: string | undefined): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) fail(`${flag} needs a positive number of seconds`);
  return seconds * 1000;
}

function fail(message: string): never {
  process.stderr.write(`with-timeout: ${message}\n`);
  process.exit(2);
}

/**
 * The command to spawn, resolved the way `run-dev-server.ts` resolves the binaries it launches:
 * `node` goes to this process's own executable, a workspace bin is reached as `node <entry>` so no
 * shell is needed for the `.bin` shim, and anything else is spawned as written for PATH to resolve.
 */
function resolveCommand(argv: string[]): [string, string[]] {
  const [bin, ...rest] = argv;
  if (bin === "node") return [process.execPath, rest];
  const entry = resolveBinEntry(process.cwd(), bin);
  return entry ? [process.execPath, [entry, ...rest]] : [bin, rest];
}

/**
 * The surviving process tree under `pid`, as `ps` prints it. Empty on Windows, where the tree is
 * killed by `taskkill /T` rather than by walking it.
 *
 * The distinction this buys, without having to reproduce the hang: "vitest alive, zero workerd
 * children" -- the documented crash wedge -- versus "workerd alive but not answering".
 */
async function describeTree(pid: number): Promise<string> {
  if (process.platform === "win32") return "";
  // Walked before anything is signalled: killing the parent reparents its descendants, after which
  // the child listers find nothing (see the note in kill-process-tree.ts). The escalating kill
  // walks again afterwards, and that second walk -- not this one -- is what drives its SIGKILL.
  const pids = await collectTree(pid);
  const listing = await new Promise<string>(resolve => {
    execFile("ps", ["-o", "pid=,command=", "-p", pids.join(",")], (_error, stdout) => {
      resolve(stdout.trimEnd());
    });
  });
  const detail = listing || `  (ps reported nothing for ${pids.join(", ")})`;
  return `  surviving processes (${pids.length}):\n${detail}\n`;
}

/**
 * Resolves once everything written to stdout and stderr has drained. `process.exit()` truncates a
 * pending write when the stream is a pipe, which is exactly what it is under `vp run`.
 */
async function flushOutput(): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map(
      stream => new Promise<void>(resolve => { stream.write("", () => resolve()); })));
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

const { idleMs, maxMs, argv } = parseArgs(process.argv.slice(2));
const [command, commandArgs] = resolveCommand(argv);
const startedAt = Date.now();

// A reader that goes away must not take the watchdog down with it: an unhandled EPIPE on our own
// stdio is an uncaught exception, and this process would exit 1 with the wedged tree still running.
// There is nowhere to report a failure to write to stderr anyway.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

const child = spawn(command, commandArgs, { stdio: ["inherit", "pipe", "pipe"] });

// Set as soon as a threshold or a signal takes over, so the child's own `close` -- which follows
// the kill -- does not report an exit status over the one already chosen.
let terminating = false;
let idleTimer: NodeJS.Timeout | undefined;
let maxTimer: NodeJS.Timeout | undefined;

function clearTimers(): void {
  clearTimeout(idleTimer);
  clearTimeout(maxTimer);
}

function armIdleTimer(): void {
  clearTimeout(idleTimer);
  if (terminating) return;
  idleTimer = setTimeout(() => { void onThreshold("no output", idleMs); }, idleMs);
}

// Straight through to this process's own streams, resetting the idle timer on every chunk. vp
// captures a task's output rather than handing over the TTY -- it has to, to render its per-task
// tree and replay a cache hit -- so interposing this pipe costs nothing the run was not paying.
//
// `pipe` rather than a write per chunk so a slow reader applies backpressure to the child instead
// of accumulating in here; the `data` listener beside it is only the idle reset. `end: false`
// because this process's own stdio must outlive the child -- the diagnostic is written after it.
function forward(source: NodeJS.ReadableStream, sink: NodeJS.WritableStream): void {
  source.on("data", () => armIdleTimer());
  source.pipe(sink, { end: false });
}

async function onThreshold(reason: string, thresholdMs: number): Promise<void> {
  if (terminating || child.pid === undefined) return;
  terminating = true;
  clearTimers();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(
      `\nwith-timeout: ${reason} for ${thresholdMs / 1000}s -- killing the process tree\n` +
      `  command: ${argv.join(" ")}\n` +
      `  cwd: ${process.cwd()}\n` +
      `  elapsed: ${elapsed}s\n` +
      await describeTree(child.pid));
  await killProcessTreeEscalating(child.pid, { graceMs: KILL_GRACE_MS });
  await flushOutput();
  process.exit(TIMED_OUT_EXIT_CODE);
}

// A second signal gives up the rest of the grace period and escalates now. Bounding the Ctrl-C path
// matters as much as bounding the run: the reported hang ended with the contributor interrupting
// it, and a tree that ignores the interrupt is what left vp escalating to SIGKILL on its own.
const force = new AbortController();
let signalled = false;

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  if (signalled) {
    force.abort();
    return;
  }
  signalled = true;
  terminating = true;
  clearTimers();
  if (child.pid !== undefined) {
    await killProcessTreeEscalating(
        child.pid, { graceMs: KILL_GRACE_MS, forceSignal: force.signal });
  }
  await flushOutput();
  process.exit(exitCodeForSignal(signal));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void onSignal(signal); });
}

child.on("error", error => {
  process.stderr.write(`with-timeout: could not start ${argv.join(" ")}: ${error.message}\n`);
  process.exit(127);
});

// `close` rather than `exit`: it fires once the piped stdio has been drained too, so nothing the
// child printed on its way out is dropped.
child.on("close", (code, signal) => {
  if (terminating) return;
  clearTimers();
  void flushOutput().then(() => {
    process.exit(signal ? exitCodeForSignal(signal) : code ?? 1);
  });
});

if (child.stdout) forward(child.stdout, process.stdout);
if (child.stderr) forward(child.stderr, process.stderr);
armIdleTimer();
maxTimer = setTimeout(() => { void onThreshold("still running", maxMs); }, maxMs);
