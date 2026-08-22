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

import { execFile, execFileSync, type ExecFileOptions } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { mapConcurrent } from "../map-concurrent.ts";
import {
  collectAssets, collectModules, stableStringify, type CollectedAssets,
} from "./hash-lib.ts";
import {
  findDeployablePackages, generateManifest, readDeployInputs, readWranglerConfig,
  type WorkerBuild, type WranglerConfig,
} from "./manifest-lib.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = join(ROOT, "packages");
const FRONTEND_DIR = join(PACKAGES_DIR, "workshop-frontend");

// Captured rather than inherited (see `run`), so it has to be bounded. Wrangler's dry-run output is
// a few KiB; this is a ceiling on a pathological build, not a budget.
const MAX_CAPTURED_OUTPUT = 32 * 1024 * 1024;

/** A deployable package, with its `wrangler.jsonc` read once and carried alongside. */
interface DeployablePackage {
  /** Package directory name, which is also the worker name. */
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** The package's parsed wrangler config. */
  config: WranglerConfig;
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
  console.log(`running: ${command} ${argv.join(" ")} ${options.cwd ? `(in ${options.cwd})` : ""}`);
  const startedAt = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, argv, { cwd: ROOT, maxBuffer: MAX_CAPTURED_OUTPUT, ...options },
        (error, stdout, stderr) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(`\n----- ${label} (${elapsed}s) -----\n${stdout}${stderr}`);
      // Just the label and the status: the command's own diagnostics are in the block above, and
      // `error.message` repeats them, so carrying it would print the same failure twice more (a
      // third time when several are collected into an AggregateError).
      if (error) rejectRun(new Error(`${label} failed (exit ${error.code ?? "signal"})`));
      else resolveRun();
    });
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
// miss rather than a stale replay.
async function buildFrontend(): Promise<CollectedAssets> {
  const env = { ...process.env, VITE_CF_ACCESS_MODE: "true" };
  await run("frontend (access mode)", "pnpm",
      ["exec", "vp", "run", "-F", "@gadgets/workshop-frontend", "build"], { env });
  return collectAssets(join(FRONTEND_DIR, "dist"));
}

// Bundles one package the way `wrangler deploy` would, without uploading. Run from the package dir
// so custom build commands (capnweb-validate) resolve their bins, and into a directory of its own,
// which is what makes these safe to overlap.
async function bundleWorker(pkg: DeployablePackage, bundleDir: string) {
  const outDir = join(bundleDir, pkg.name);
  await run(pkg.name, "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir],
      { cwd: pkg.dir });
  return collectModules(outDir);
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

  const packages: DeployablePackage[] = findDeployablePackages(PACKAGES_DIR)
      .map((pkg) => ({ ...pkg, config: readWranglerConfig(pkg.dir) }));
  const bundleDir = mkdtempSync(join(tmpdir(), "gadgets-release-"));

  // 1. The frontend build and the worker bundles all at once. Only a worker that serves static
  //    assets reads workshop-frontend/dist (the router points its `assets.directory` there), so it
  //    alone waits for the frontend; the rest start immediately. Read off the config rather than
  //    naming the router, so a second asset-serving worker would be sequenced too.
  //
  //    `frontend` is awaited by the Promise.all as well as inside the task, so a frontend failure
  //    is observed even when no bundle got as far as awaiting it.
  const frontend = buildFrontend();
  const [bundles, assets] = await Promise.all([
    mapConcurrent(packages, args.concurrency, async (pkg) => {
      if (pkg.config.assets) await frontend;
      return bundleWorker(pkg, bundleDir);
    }),
    frontend,
  ]);

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

  rmSync(bundleDir, { recursive: true, force: true });
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
  console.error("\nrelease build failed:");
  for (const failure of failures) {
    console.error(`  - ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  process.exit(1);
}
