#!/usr/bin/env node

// Builds an immutable release: every deployable worker bundled exactly as `wrangler deploy`
// would upload it (dry-run + outdir, with the repo's pinned wrangler), plus the Access-mode
// workshop-frontend asset build, plus the release manifest that describes it all.
//
// Output layout (mirrored to R2 by upload-release.ts):
//   <out>/manifest.json                    the release manifest (upload LAST — its presence
//                                          marks the release complete)
//   <out>/modules/<sha256>                 worker module blobs, content-addressed
//   <out>/assets/<cfHash>                  static asset blobs, content-addressed
//
// The builds overlap: the frontend and every worker bundle run concurrently, up to --concurrency
// at a time. Nothing about the output depends on that -- each bundle reads only its own package
// and writes only its own directory, and results are reassembled in package order.
//
// Usage: node scripts/release/build-release.ts --out <dir> [--release-id <id>] [--concurrency <n>]

import {
  execFile, execFileSync, type ChildProcess, type ExecFileOptions,
} from "node:child_process";
import { setMaxListeners } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { killProcessTree, killProcessTreeEscalating } from "../kill-process-tree.ts";
import { mapConcurrent } from "../map-concurrent.ts";
import { vpRunEnv } from "../vp/concurrency.ts";
import {
  collectAssets, collectModules, stableStringify, type CollectedAssets,
} from "./hash-lib.ts";
import {
  generateManifest, readDeployablePackages, readDeployInputs,
  type DeployablePackage, type WorkerBuild,
} from "./manifest-lib.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = join(ROOT, "packages");
const FRONTEND_DIR = join(PACKAGES_DIR, "workshop-frontend");

// Captured rather than inherited (see `run`), so it has to be bounded. Wrangler's dry-run output is
// a few KiB; this is a ceiling on a pathological build, not a budget.
//
// What overflowing it actually does, since the shape is easy to guess wrong: execFile destroys its
// *own* read ends and then signals only the direct child. So it is not a hang -- a descendant still
// holding the write end cannot keep the callback from settling, because nobody is reading that end
// any more. What it can do is orphan descendants, and unlike the abort path that is not fixable
// from here: killing the wrapper reparents them first, so by the time we are told, a tree walk can
// no longer find them (kill-process-tree.ts explains the reparenting). In practice it is
// self-limiting -- whatever produced 32 MiB is still writing, takes EPIPE on the destroyed pipe,
// and takes the wrapper down with it. Left as an accepted limit rather than a `spawn` rewrite.
const MAX_CAPTURED_OUTPUT = 32 * 1024 * 1024;

// How long a shutdown signal waits for the in-flight trees to go down before it stops being polite.
// Comfortably longer than killProcessTreeEscalating's own grace, so the escalation's SIGKILL is what
// normally ends things and this is only the backstop for a tree that survives even that.
const FORCE_KILL_GRACE_MS = 10_000;

// The commands running right now, so a shutdown signal can reach their whole trees. Same reason
// run-dev-server.ts keeps `preflightBuilds`: these are `pnpm exec` wrappers, so the ChildProcess
// handle alone is not enough to stop the work.
const running = new Set<ChildProcess>();

// The escalations those commands' abort handlers started, and the switch that cuts their grace
// period short. A second stop signal has to go through these rather than around them: each
// escalation captured its tree's pids before anything was signalled, and once the first SIGTERM has
// taken the wrapper down and reparented the survivors, that captured list is the only way left to
// reach them (kill-process-tree.ts spells out why a fresh walk finds nothing). Exiting while one is
// still in its grace period abandons exactly the processes the force path exists to kill.
const escalations = new Set<Promise<void>>();
const forceKill = new AbortController();

/** The abort reason when a shutdown signal ended the run, rather than a build failing. */
class CancelledBySignal extends Error {
  signal: NodeJS.Signals;
  exitCode: number;
  constructor(signal: NodeJS.Signals, exitCode: number) {
    super(`cancelled by ${signal}`);
    this.signal = signal;
    this.exitCode = exitCode;
  }
}


function parseArgs(argv: string[]): {
  out: string;
  releaseId: string | undefined;
  concurrency: number;
} {
  let out: string | undefined;
  let releaseId: string | undefined;
  // Each bundle is one mostly CPU-bound esbuild process. Lower it on a runner that cannot afford
  // that many at once; raise it on one whose cores this undercounts.
  let concurrency = availableParallelism();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i]);
    else if (argv[i] === "--release-id") releaseId = argv[++i];
    else if (argv[i] === "--concurrency") {
      concurrency = Number(argv[++i]);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`--concurrency must be a positive integer, got: ${argv[i]}`);
      }
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out) throw new Error("--out <dir> is required");
  return { out, releaseId, concurrency };
}

// Runs a command to completion and prints its output as one block once it finishes.
//
// Captured rather than `stdio: "inherit"`: these run concurrently, and a dozen wrangler logs
// interleaved line by line would be unreadable. A whole block per command carries the same
// information; only the order the blocks appear in is no longer fixed.
function run(
  label: string, command: string, argv: string[], options: ExecFileOptions = {},
): Promise<void> {
  const signal = options.signal;
  // Aborted before we spawn anything: nothing to cancel, and no reason to start a process just to
  // kill it. mapConcurrent makes this check before claiming an item, but an asset-serving bundle
  // sits in `await frontend` after that, so the abort can land in between.
  if (signal?.aborted) return Promise.reject(signal.reason);

  console.log(`running: ${command} ${argv.join(" ")} ${options.cwd ? `(in ${options.cwd})` : ""}`);
  const startedAt = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    // Whether the abort handler below signalled *this* command's tree. Local rather than read off
    // the signal, because "the run was aborted" and "this command was cancelled" are different
    // facts: a command that had already failed on its own merits when the abort arrived deserves to
    // be reported as the failure it is (see the classification below).
    let killedByUs = false;

    // `signal` is deliberately *not* forwarded to execFile, and is cleared so a caller's cannot
    // reach it through the spread. Node's own implementation is wrong for these commands twice
    // over: it kills only the direct child -- here `pnpm`, a wrapper, leaving the `wrangler`/`vp`
    // and esbuild descendants that do the actual work running and writing -- and it settles this
    // promise the moment the signal fires rather than when the child exits, so awaiting it would
    // return while the build is still live. Both are what the abort handler below fixes.
    const child = execFile(command, argv,
        { cwd: ROOT, maxBuffer: MAX_CAPTURED_OUTPUT, ...options, signal: undefined },
        (error, stdout, stderr) => {
      signal?.removeEventListener("abort", onAbort);
      running.delete(child);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      // A command we killed, which died to a signal, was cancelled rather than broken: its output
      // is noise and its "failure" is the root cause's, so reject with that same object -- the
      // caller dedupes failures by identity, which is what keeps a cancelled command out of the
      // summary.
      if (killedByUs && error?.signal) {
        console.log(`cancelled: ${label} (${elapsed}s)`);
        rejectRun(signal!.reason);
        return;
      }
      process.stdout.write(`\n----- ${label} (${elapsed}s) -----\n${stdout}${stderr}`);
      // Just the label and the status: the command's own diagnostics are in the block above, and
      // `error.message` repeats them, so carrying it would print the same failure twice more (a
      // third time when several are collected into an AggregateError).
      if (error) rejectRun(new Error(`${label} failed (exit ${error.signal ?? error.code})`));
      else resolveRun();
    });

    running.add(child);

    // Reaches the descendants execFile's own `signal` would leave behind, and escalates to SIGKILL
    // because `pnpm` -- the direct child here -- ignores SIGTERM while a child of its own is still
    // alive: signalled on its own it sits there with no exit code, and the callback above fires on
    // `close`, so a polite signal alone would leave this promise pending indefinitely.
    // Signalling the whole tree is also what makes `pnpm` itself go down promptly.
    function onAbort() {
      killedByUs = true;
      // Undefined when the spawn itself failed; the callback is already on its way with the error.
      if (child.pid === undefined) return;
      // Deliberately not awaited *by this promise*: a straggler that outlives it is tolerated here
      // (it only writes into its own scratch dir, and the release is already failing), and waiting
      // for one was explicitly not wanted. The destroy/unref is what makes that safe -- the callback
      // fires on `close`, so a descendant the tree snapshot missed still holding the pipe would
      // otherwise keep this promise pending forever. It is still tracked, because a force exit does
      // have to wait for it; see `escalations`.
      const escalation = killProcessTreeEscalating(child.pid, { forceSignal: forceKill.signal })
          .catch(() => {}).then(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      });
      escalations.add(escalation);
      void escalation.then(() => escalations.delete(escalation));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function gitCommit(): string {
  return process.env.CI_COMMIT_SHA
      || execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function defaultReleaseId(commit: string): string {
  // CI: GitLab pipeline IID + short SHA. Local: timestamped dev release, unique per build so
  // every upload stays immutable in R2. "Latest" is decided by the deploy service from upload
  // time, and the commit is in the manifest's `commit` field. Kept short: worker version tags
  // (`gd:<id>:<fp8>`) have a hard 25-char cap downstream.
  //
  // CI_PIPELINE_IID (per-project, monotonic), NOT CI_PIPELINE_ID (instance-global): run numbers
  // are compared by promote-release.ts's supersededBy() guard, so they must form one monotonic
  // sequence from a single publisher.
  const runNumber = process.env.CI_PIPELINE_IID;
  if (runNumber) return `r${runNumber.padStart(6, "0")}-${commit.slice(0, 7)}`;
  return `dev-${Math.floor(Date.now() / 1000).toString(36)}`;
}

function pinnedWranglerVersion(): string {
  const pkg = JSON.parse(
      readFileSync(join(ROOT, "node_modules", "wrangler", "package.json"), "utf8")) as
      { version: string };
  return pkg.version;
}

// Builds the Access-mode frontend (VITE_CF_ACCESS_MODE is a build-time flag,
// workshop-frontend/src/useAuth.ts) — the one asset variant every release carries.
//
// Through vp rather than a package script: `build` is a task, so there is no script to run, and the
// task declares VITE_* as fingerprinted env — a release built at a different flag value is a cache
// miss rather than a stale replay. Based on `vpRunEnv()` so the run gets the machine-aware
// concurrency limit (vp/concurrency.ts); the limit is not a task input, so it never affects the hash.
async function buildFrontend(signal: AbortSignal): Promise<CollectedAssets> {
  const env = { ...vpRunEnv(), VITE_CF_ACCESS_MODE: "true" };
  await run("frontend (access mode)", "pnpm",
      ["exec", "vp", "run", "-F", "@gadgets/workshop-frontend", "build"], { env, signal });
  return collectAssets(join(FRONTEND_DIR, "dist"));
}

// Bundles one package the way `wrangler deploy` would, without uploading. Run from the package dir
// so custom build commands (capnweb-validate) resolve their bins, and into a directory of its own,
// which is what makes these safe to overlap.
async function bundleWorker(pkg: DeployablePackage, bundleDir: string, signal: AbortSignal) {
  const outDir = join(bundleDir, pkg.name);
  await run(pkg.name, "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir],
      { cwd: pkg.dir, signal });
  return collectModules(outDir);
}

// Runs the frontend build and every worker bundle, and owns the scratch directory they bundle into
// for exactly as long as they need it: `collectModules` has read each bundle's bytes into memory by
// the time its task resolves, so nothing downstream reads the directory back.
//
// The frontend build and the worker bundles go all at once. Only a worker that serves static assets
// reads workshop-frontend/dist (the router points its `assets.directory` there), so it alone waits
// for the frontend; the rest start immediately. Read off the config rather than naming the router,
// so a second asset-serving worker would be sequenced too.
//
// `frontend` is awaited by the allSettled as well as inside the task, so a frontend failure is
// observed even when no bundle got as far as awaiting it.
//
// Fail-fast: the first failure anywhere aborts the controller *with itself as the reason*, which
// stops mapConcurrent from claiming more bundles and kills the process trees of the commands
// already running (see `run`). Every task is still awaited -- allSettled, and mapConcurrent waits
// for its in-flight tasks -- so the run reports every real failure rather than whichever one lost
// the race, and it always reaches the cleanup below. What it does not claim is that every
// descendant is dead when a task settles; `run` says why that is tolerated. A cancelled command
// rejects with the abort reason, i.e. the root cause itself, which is what lets the failure summary
// below dedupe down to the real failures by identity.
async function buildAll(packages: DeployablePackage[], concurrency: number): Promise<{
  bundles: ReturnType<typeof collectModules>[];
  assets: CollectedAssets;
}> {
  const controller = new AbortController();
  // One abort listener per running command (`run`), removed as each finishes. The default cap of 10
  // is below the concurrency this defaults to on a large runner, and the warning it emits would be
  // pure noise.
  setMaxListeners(0, controller.signal);
  const failFast = <T>(p: Promise<T>): Promise<T> =>
      p.catch((error: unknown) => { controller.abort(error); throw error; });

  // Termination from outside runs the same cancellation path a build failure does, which is the only
  // way the descendants get stopped and the scratch directory below gets removed. Installing these
  // also disables Node's default exit-on-signal, and that default is the whole problem: a *targeted*
  // signal (CI cancelling a job, an IDE stop button, `kill <pid>`) reaches only this process, so
  // dying on the spot leaves every `pnpm exec wrangler` tree running and skips the `finally`. A
  // terminal Ctrl-C is delivered to the process group and would have taken the descendants with it
  // anyway; nothing else is that kind.
  const bundleDir = mkdtempSync(join(tmpdir(), "gadgets-release-"));
  let stopSignalsReceived = 0;
  let forcing = false;
  const onStopSignal = (signal: NodeJS.Signals) => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    // Impatience, or a tree that outlived even the escalation's SIGKILL. The escalations the first
    // signal started are what actually reach a descendant it has already reparented, so this cuts
    // their grace short and leaves with them rather than exiting out from under them -- bounded by
    // one poll tick, not by the grace period the user just said they were done waiting for. The
    // fresh walk alongside them adds whatever was spawned after they captured their trees.
    if (++stopSignalsReceived > 1) {
      if (forcing) return;
      forcing = true;
      forceKill.abort();
      void Promise.all([...escalations, ...[...running].map((child) =>
          child.pid === undefined ? null : killProcessTree(child.pid, "SIGKILL").catch(() => {}))])
          .then(() => {
            // process.exit() below skips the `finally`, so the scratch directory has to go here
            // too. Ordered after the SIGKILLs, for the same reason the `finally` is ordered after
            // the awaits: nothing may still be writing into what this removes.
            rmSync(bundleDir, { recursive: true, force: true });
            process.exit(exitCode);
          });
      return;
    }
    console.error(`\n${signal} received: cancelling in-flight builds`);
    controller.abort(new CancelledBySignal(signal, exitCode));
    // Unref'd so it is never the reason the process stays alive.
    setTimeout(() => onStopSignal(signal), FORCE_KILL_GRACE_MS).unref();
  };
  const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of stopSignals) process.on(signal, onStopSignal);

  try {
    const frontend = failFast(buildFrontend(controller.signal));
    const [bundlesResult, frontendResult] = await Promise.allSettled([
      mapConcurrent(packages, concurrency, async (pkg) => {
        if (pkg.config.assets) await frontend;
        return failFast(bundleWorker(pkg, bundleDir, controller.signal));
      }, controller.signal),
      frontend,
    ]);
    if (bundlesResult.status === "rejected" || frontendResult.status === "rejected") {
      const failures = new Set([bundlesResult, frontendResult]
          .filter((r) => r.status === "rejected")
          .flatMap((r) => r.reason instanceof AggregateError ? r.reason.errors : [r.reason]));
      if (failures.size === 1) throw [...failures][0];
      throw new AggregateError([...failures], `${failures.size} builds failed`);
    }
    // Everything succeeded -- but the run may still have been told to stop, with the signal landing
    // late enough that every command had already finished and nothing rejected. Without this the
    // manifest gets written and the process exits 0 for a build that was cancelled; and because the
    // handlers above disable Node's default exit-on-signal, the signal is swallowed outright.
    if (controller.signal.aborted) throw controller.signal.reason;
    return { bundles: bundlesResult.value, assets: frontendResult.value };
  } finally {
    // Nothing is spawning any more, so hand the signals back to Node's default. Left installed they
    // would swallow a Ctrl-C during the manifest write, which has nothing to cancel.
    for (const signal of stopSignals) process.off(signal, onStopSignal);
    // On the failure path too, which is why this is a `finally` rather than a line at the end: a
    // failed build used to leave its scratch directory behind in the tmpdir. A straggler may still
    // be writing in here (see `run`'s abort handler); harmless, as the release is already failing
    // and on POSIX its open files survive the unlink.
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commit = gitCommit();
  const releaseId = args.releaseId ?? defaultReleaseId(commit);
  const wranglerVersion = pinnedWranglerVersion();
  console.log(`building release ${releaseId} (commit ${commit}, wrangler ${wranglerVersion}, ` +
      `${args.concurrency} bundles at a time)`);

  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(join(args.out, "modules"), { recursive: true });
  mkdirSync(join(args.out, "assets"), { recursive: true });

  const packages = readDeployablePackages(PACKAGES_DIR);

  // 1. Every bundle, overlapping.
  const { bundles, assets } = await buildAll(packages, args.concurrency);

  // 2. Everything below is ordered by package, so the release bytes do not depend on which build
  //    finished first.
  const assetVariants = { access: assets };
  for (const { blobs } of Object.values(assetVariants)) {
    for (const [hash, blob] of blobs) {
      writeFileSync(join(args.out, "assets", hash), blob.bytes);
    }
  }

  const workers: WorkerBuild[] = packages.map((pkg, i) => {
    const { mainModule, modules } = bundles[i];
    for (const mod of modules) {
      writeFileSync(join(args.out, "modules", mod.sha256), mod.bytes);
    }
    return {
      pkgName: pkg.name,
      config: pkg.config,
      mainModule,
      modules,
      deployInputs: readDeployInputs(pkg.dir),
    };
  });

  // 3. The manifest ties it together. Written last locally too, mirroring the R2 upload order
  //    (manifest presence == release complete).
  const manifest = generateManifest({
    releaseId,
    commit,
    createdAt: new Date().toISOString(),
    wranglerVersion,
    workers,
    assetVariants,
  });
  writeFileSync(join(args.out, "manifest.json"), stableStringify(manifest) + "\n");

  const moduleCount = workers.reduce((n, w) => n + w.modules.length, 0);
  console.log(`\nrelease ${releaseId}: ${workers.length} workers, ${moduleCount} modules, ` +
      `${Object.keys(manifest.assets).length} unique asset blobs -> ${args.out}`);
}

try {
  await main();
} catch (error) {
  // A summary, not a stack: every failed command already printed its own diagnostics as a block,
  // and with the builds overlapping there can be more than one to name.
  const failures = error instanceof AggregateError ? error.errors : [error];
  // Cancelled from outside is not a broken build, and its exit code is the signal's. Checked over
  // the flattened list rather than `error` alone: the dedupe in buildAll collapses the reason every
  // cancelled command rejected with down to one, so the common case arrives bare -- but a real
  // failure racing the signal arrives as an AggregateError holding both.
  const cancelled = failures.find((f) => f instanceof CancelledBySignal);
  if (cancelled) {
    console.error(`\nrelease build ${cancelled.message}`);
    process.exitCode = cancelled.exitCode;
  } else {
    console.error("\nrelease build failed:");
    for (const failure of failures) {
      console.error(`  - ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    process.exitCode = 1;
  }
  // Not process.exit(): every child has been awaited by now, so the event loop drains on its own
  // and piped stdio gets flushed rather than truncated mid-diagnostic.
}
