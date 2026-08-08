#!/usr/bin/env node

// Generates dev-only wrangler.dev.jsonc files for dynamic service bindings,
// then launches `wrangler dev` with all discovered workers.
//
// Flags:
//   --use-workers-ai-binding   Include the Workers AI binding in
//                               workshop-backend (requires Cloudflare login).
//   --port PORT                 Listen on PORT instead of 8787. Overrides VITE_BACKEND_HOST.
//
// Env:
//   VITE_BACKEND_HOST=localhost:9000  Also pass --port 9000 to wrangler dev.

import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { constants } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { resolveBinEntry } from "./bin-entry.ts";
import { getDevServerConfig } from "./dev-server-config.ts";
import { killProcessTree } from "./kill-process-tree.ts";
import { pnpmCommand } from "./pnpm-command.ts";
import type { ServiceBinding, WranglerBuild } from "./release/manifest-lib.ts";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS_DIR, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const WORKSHOP_BACKEND_DIR = join(PACKAGES_DIR, "workshop-backend");

/** A gatekeeper package as {@link findGatekeepers} discovers it. */
interface Gatekeeper {
  /** Package directory name, which is also the worker name. */
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
}

// Load a root `.dev.vars` file (KEY=VALUE lines) into process.env for local development. Existing
// shell environment values take precedence. This file is gitignored and may hold local secrets.
function loadDevVars(): void {
  const path = join(ROOT, ".dev.vars");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding single or double quotes.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDevVars();

const useWorkersAi = process.argv.includes("--use-workers-ai-binding");

// In `run-local` mode the backend serves the pre-built frontend bundle as static assets (there is no
// Vite dev server). In normal dev mode we leave assets unconfigured so the frontend is served by
// Vite on :3000 and no `vite build` is required to start the dev server.
const serveFrontendAssets = process.argv.includes("--serve-frontend-assets");

let backendHost: string;
let wranglerPort: string | null;
try {
  ({ backendHost, wranglerPort } = getDevServerConfig(
      process.argv.slice(2), process.env.VITE_BACKEND_HOST));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Discover gatekeeper packages.
// ---------------------------------------------------------------------------
function findGatekeepers(parentDir: string): Gatekeeper[] {
  try {
    return readdirSync(parentDir)
        .filter(name => name.startsWith("gatekeeper-"))
        .filter(name => {
      try {
        return statSync(join(parentDir, name, "wrangler.jsonc")).isFile();
      } catch {
        return false;
      }
    })
        .map(name => ({ name, dir: join(parentDir, name) }));
  } catch {
    return [];
  }
}

const gatekeepers = findGatekeepers(PACKAGES_DIR);

// The Context Library (packages/gatekeeper-context) is discovered by findGatekeepers and bound
// like any other gatekeeper (GATEKEEPER_CONTEXT -> GatekeeperVendor). Its describe() reports
// autoProvisionsAccount, so core auto-provisions one Context account per user. The only extra
// wiring it needs is a sharingDomain in its binding props (see below).
const CONTEXT_GATEKEEPER_NAME = "gatekeeper-context";

// What Wrangler picks for itself when no --port is derived, so also what we poll.
const DEFAULT_WRANGLER_PORT = 8787;

// Watchers rebuild each gatekeeper's generated UI (src/generated/*) on source change; wrangler dev's
// `watch_dir: src` then re-bundles the worker. Deferred ones start once Wrangler is listening.
const devWatchers: ChildProcess[] = [];
const deferredWatchers: (() => void)[] = [];
let stoppingDevWatchers = false;
let wranglerChild: ChildProcess | null = null;

// Resolve once something accepts a TCP connection on `port`, or once `timeoutMs` has elapsed.
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve();
        else setTimeout(attempt, 100).unref();
      });
    };
    attempt();
  });
}

// Spawn a persistent watcher.
function spawnDevWatcher(label: string, command: string, args: string[]): void {
  const watcher = spawn(command, args, { stdio: "inherit", cwd: ROOT });
  watcher.on("exit", (code, signal) => {
    if (stoppingDevWatchers) return;
    console.error(`${label} exited unexpectedly (code=${code}, signal=${signal}).`);
  });
  devWatchers.push(watcher);
}

// No-op once shutdown has begun: reaching the port deadline just as the user hits Ctrl-C must not
// spawn a watcher that nothing is left to kill.
function startDeferredWatchers(): void {
  if (stoppingDevWatchers) return;
  for (const start of deferredWatchers.splice(0)) start();
}

function stopDevWatchers(): void {
  stoppingDevWatchers = true;
  deferredWatchers.length = 0;
  for (const watcher of devWatchers) watcher.kill();
}

process.on("exit", stopDevWatchers);

// Reaches each app watcher's `pnpm exec vite build --watch` grandchild, which a bare kill() on the
// `node build-app.mjs --watch` wrapper leaves holding CPU and file watches after we are gone. Must
// not call stopDevWatchers() first: killing a wrapper reparents its children away from it, and the
// tree walk can no longer find them.
async function stopDevWatchersDeep(): Promise<void> {
  stoppingDevWatchers = true;
  deferredWatchers.length = 0;
  await Promise.all(devWatchers
      .filter(watcher => watcher.exitCode === null && watcher.signalCode === null)
      .map(watcher => watcher.pid ? killProcessTree(watcher.pid).catch(() => {}) : null));
}

// Shutdown is driven by Wrangler's exit. Ctrl-C reaches the whole process group, so Wrangler is
// already tearing down its workerd children and exiting first would orphan them. These handlers
// disable Node's default exit-on-signal, so a wedged Wrangler would otherwise make Ctrl-C
// ineffective and leave this process waiting forever -- a second signal or the grace deadline
// escalates to SIGKILLing Wrangler's whole tree.
const FORCE_KILL_GRACE_MS = 10_000;
let receivedShutdownSignals = 0;
let forcingShutdown = false;
let shutdownExitCode: number | null = null;

async function forceKillWrangler(exitCode: number): Promise<void> {
  if (forcingShutdown) return;
  forcingShutdown = true;
  if (wranglerChild?.exitCode === null && wranglerChild.signalCode === null && wranglerChild.pid) {
    await killProcessTree(wranglerChild.pid, "SIGKILL").catch(() => {});
  }
  process.exit(exitCode);
}

async function onShutdownSignal(signal: NodeJS.Signals, exitCode: number): Promise<void> {
  receivedShutdownSignals++;
  shutdownExitCode ??= exitCode;
  if (receivedShutdownSignals > 1) return forceKillWrangler(exitCode);
  // Awaited before Wrangler is signalled: this process stays alive waiting for Wrangler's exit, so
  // there is time for the process tree walks. Ctrl-C is group-delivered, but a targeted signal
  // (kill <pid>, IDE stop buttons) reaches only this process, so the pre-flight builds have to be
  // torn down here too and a live Wrangler has to be signalled explicitly -- on the Ctrl-C path
  // the forwarded signal lands during Wrangler's own teardown, which tolerates the repeat.
  await stopDevWatchersDeep();
  await stopPreflightBuilds();
  if (wranglerChild?.exitCode === null) {
    wranglerChild.kill(signal);
    setTimeout(() => forceKillWrangler(exitCode), FORCE_KILL_GRACE_MS).unref();
  } else {
    // Nothing left to wait for; without this exit the disabled default would keep us alive.
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => onShutdownSignal("SIGINT", 130));
process.on("SIGTERM", () => onShutdownSignal("SIGTERM", 143));

// The pre-flight builds still running. Kept separate from `devWatchers`, whose `exit` handler runs
// on every shutdown path; these need killing on two paths only: when a sibling build has failed,
// and on a SIGTERM that arrives while they are still running.
const preflightBuilds = new Set<ChildProcess>();
let stoppingPreflightBuilds = false;

// Two of the three builds are `pnpm exec vp run ...`, so this has to reach each one's `vp`/`vite`
// descendants -- a bare kill() would signal only the wrapper and leave them writing. Awaited by
// callers: process.exit() would cut the tree walk short.
async function stopPreflightBuilds(): Promise<void> {
  stoppingPreflightBuilds = true;
  await Promise.all([...preflightBuilds].map(child =>
      child.pid ? killProcessTree(child.pid).catch(() => {}) : null));
}

// Run a one-shot build to completion. A promise rather than execFileSync so the pre-flight builds
// can overlap.
function runBuild(label: string, command: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd });
    preflightBuilds.add(child);
    child.on("error", error => {
      preflightBuilds.delete(child);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      preflightBuilds.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (code=${code}, signal=${signal}).`));
    });
  });
}

// Everything Wrangler needs generated before it bundles: the backend's format blueprint module
// (gitignored, so absent on a clean checkout) and each gatekeeper's UI.
//
// The UI groups go through `vp` rather than a loop over `gatekeepers` so they run in parallel and
// hit the task cache; `vp run` takes one task name, hence two invocations. `vp` selects packages by
// which ones declare the task, matching the directory probes in the watcher loop below -- so a new
// gatekeeper needs its `build:configurator` or `build:app:dev` task (declared in its
// `vite.config.ts`) to be built here. Tasks rather than package.json scripts so
// VITE_FRONTEND_ERROR_REPORTING is passed through and fingerprinted; a cached script would strip
// it, and the watchers below, which inherit the shell, would rewrite the outputs moments later.
//
// `build:app:dev` rather than `build:app`: the app watchers cannot skip their own initial build, so
// this output is rebuilt regardless, and unless the bytes match Wrangler sees `src/generated/app.txt`
// change and restarts the worker. Same build, unminified.
try {
  await Promise.all([
    runBuild(
      "format blueprints",
      process.execPath,
      [join(WORKSHOP_BACKEND_DIR, "scripts", "build-format-blueprints.mjs")],
      WORKSHOP_BACKEND_DIR,
    ),
    runBuild("configurator UIs",
        ...pnpmCommand(["exec", "vp", "run", "-r", "--cache", "build:configurator", "--dev"]), ROOT),
    runBuild("gatekeeper app UIs",
        ...pnpmCommand(["exec", "vp", "run", "-r", "--cache", "build:app:dev"]), ROOT),
  ]);
} catch (err) {
  // The SIGTERM handler killing the builds also lands here, as the rejection of whichever build
  // died first. The handler owns teardown and the exit code (143), so park and let it exit.
  if (stoppingPreflightBuilds) await new Promise(() => {});
  console.error((err as Error).message);
  // The siblings of the build that failed are still running. Left alone they would outlive this
  // process, writing their outputs after startup has reported failure and colliding with an
  // immediate re-run.
  await stopPreflightBuilds();
  process.exit(1);
}

// Watchers start only after those builds finish. Both watch modes run a full build before they
// begin watching, so starting one earlier would put two processes on the same src/generated files.
for (const gk of gatekeepers) {
  // Configurator UI (compiled by build-gatekeeper-configurator.ts). The pre-flight already ran this
  // same build, so each watcher's own initial build is a no-op write -- and it is what keeps the
  // watcher self-contained: it reads the sources itself, immediately before it starts watching them,
  // so an edit made while the watchers are still spawning is either in that build or seen by the
  // watcher. Skipping it would leave that edit sitting unbuilt until the next save, while Wrangler,
  // which sees the same edit through `watch_dir: src`, restarted the worker as if it had landed.
  if (existsSync(join(gk.dir, "src", "configurator"))) {
    spawnDevWatcher(
      `configurator UI watcher for ${gk.name}`,
      process.execPath,
      [join(SCRIPTS_DIR, "build-gatekeeper-configurator.ts"), gk.dir, "--watch", "--quiet"],
    );
  }

  // Single-file app UI (Vite bundle written to src/generated/app.txt by build-app.mjs).
  //
  // Deferred until Wrangler is listening: unlike the configurator watcher, `vite build --watch`
  // cannot skip its initial build, and these are the largest builds in the repo, so running them now
  // takes cores from the worker bundles Wrangler is building concurrently. Nothing needs them sooner
  // -- the pre-flight already wrote the `app.txt` they will produce -- and Vite reads the disk when
  // it finally starts, so an edit made while the server was coming up is still picked up.
  if (existsSync(join(gk.dir, "build-app.mjs"))) {
    deferredWatchers.push(() => spawnDevWatcher(
      `app UI watcher for ${gk.name}`,
      process.execPath,
      [join(gk.dir, "build-app.mjs"), "--watch"],
    ));
  }
}

// Helper: "gatekeeper-github" -> "GATEKEEPER_GITHUB"
function bindingName(gk: Gatekeeper): string {
  return gk.name.toUpperCase().replaceAll("-", "_");
}

// ---------------------------------------------------------------------------
// Speed up wrangler's per-worker `build.command`.
//
// Wrangler runs it twice per worker at startup (cloudflare/workers-sdk#7934) and again on every
// watch_dir event, and reaching the binary through `pnpm exec` costs ~0.33s of process startup each
// time -- for most of these workers longer than the build itself, and all of it on the startup
// critical path.
//
// So for dev only we rewrite the command to spawn the same binaries directly. What runs does not
// change -- same entry point, arguments and cwd -- only how it is reached. Anything that does not
// resolve is left exactly as written, so the committed wrangler.jsonc stays the source of truth and
// an unrecognised command still works, just at the original speed.
// ---------------------------------------------------------------------------

// Whether wrapping `path` in plain double quotes is safe in the shell that runs the rewritten
// command: inside them POSIX shells still expand `$` and backticks and collapse `\\`, cmd still
// expands `%`, and an embedded quote or a trailing backslash would break the quoting itself.
// Unsafe paths keep the committed `pnpm exec` form -- slower, but correct for any path.
function shellSafe(path: string): boolean {
  return !/[$`%"]|\\\\|\\$/.test(path);
}

// `pnpm run <script>` is expanded to the script body (so any `pnpm exec` inside it is rewritten
// too), then each `pnpm exec <bin>` becomes a direct `node <entry>`. Wrangler runs the result
// through a shell, so a body chained with `&&` stays valid.
function withoutPnpmIndirection(pkgDir: string, command: string, depth = 0): string {
  const runScript = /^pnpm run ([\w:.@-]+)$/.exec(command.trim())?.[1];
  if (runScript && depth < 2) {
    try {
      const { scripts } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      const body = scripts?.[runScript];
      if (body) return withoutPnpmIndirection(pkgDir, body, depth + 1);
    } catch {
      // Fall through and return the command untouched.
    }
  }
  return command.replaceAll(/\bpnpm exec ([\w@/.-]+)/g, (original, bin) => {
    const entry = resolveBinEntry(pkgDir, bin);
    return entry && shellSafe(process.execPath) && shellSafe(entry)
        ? `"${process.execPath}" "${entry}"` : original;
  });
}

// Dev build settings for a worker: an explicit cwd (this script starts a multi-config Wrangler from
// the repo root, so the committed relative paths would otherwise resolve against the wrong
// directory) and the de-indirected command.
function devBuildConfig(build: WranglerBuild | undefined, pkgDir: string): WranglerBuild {
  const dev = { ...build, cwd: pkgDir };
  if (typeof dev.command !== "string") return dev;

  dev.command = withoutPnpmIndirection(pkgDir, dev.command);
  return dev;
}

// ---------------------------------------------------------------------------
// Generate wrangler.dev.jsonc (dev-router with gatekeeper service bindings).
// ---------------------------------------------------------------------------
{
  const srcPath = join(ROOT, "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));

  config.services = config.services || [];
  for (const gk of gatekeepers) {
    config.services.push({ binding: bindingName(gk), service: gk.name });
  }

  const outPath = join(ROOT, "wrangler.dev.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Generate gatekeeper wrangler.dev.jsonc files. The checked-in wrangler.jsonc
// already points at the capnweb-validate output; dev needs an explicit cwd
// because this script starts a multi-config Wrangler process from the repo root.
// We also inject OAuth credentials shared with the sign-in flow, so a single
// OAuth app can drive both; gatekeepers without shared creds keep their raw config,
// and any creds already defined in the gatekeeper's own config still win.
// ---------------------------------------------------------------------------

// Maps a gatekeeper name to the shared env vars whose values seed its CLIENT_ID / CLIENT_SECRET.
const SHARED_GATEKEEPER_CREDS: Record<string, { id: string; secret: string }> = {
  "gatekeeper-github": { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  "gatekeeper-google": { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  "gatekeeper-cloudflare": { id: "CLOUDFLARE_OAUTH_CLIENT_ID", secret: "CLOUDFLARE_OAUTH_CLIENT_SECRET" },
  "gatekeeper-supabase": { id: "SUPABASE_CLIENT_ID", secret: "SUPABASE_CLIENT_SECRET" },
  "gatekeeper-notion": { id: "NOTION_CLIENT_ID", secret: "NOTION_CLIENT_SECRET" },
  "gatekeeper-zoominfo": { id: "ZOOMINFO_CLIENT_ID", secret: "ZOOMINFO_CLIENT_SECRET" },
  "gatekeeper-confluence": { id: "CONFLUENCE_CLIENT_ID", secret: "CONFLUENCE_CLIENT_SECRET" },
  "gatekeeper-slack": { id: "SLACK_CLIENT_ID", secret: "SLACK_CLIENT_SECRET" },
  "gatekeeper-linear": { id: "LINEAR_CLIENT_ID", secret: "LINEAR_CLIENT_SECRET" },
  "gatekeeper-spotify": { id: "SPOTIFY_CLIENT_ID", secret: "SPOTIFY_CLIENT_SECRET" },
};

// Deployment-configured vars a gatekeeper reads that its committed `wrangler.jsonc` deliberately
// leaves unset, passed through from the shell or the root `.dev.vars`.
//
// Without this the only way to point the portal connector somewhere for local testing is to edit a
// tracked file, and a URL committed there becomes the default for everyone who deploys this repo.
// `.dev.vars` is gitignored, so it cannot leave the machine. Secrets travel the same way
// `CLIENT_SECRET` already does, via SHARED_GATEKEEPER_CREDS above.
const PASSTHROUGH_GATEKEEPER_VARS: Record<string, string[]> = {
  "gatekeeper-mcp-portal": [
    "MCP_PORTAL_URL", "MCP_PORTAL_NAME", "MCP_PORTAL_AUTH", "MCP_PORTAL_TOKEN",
    "MCP_PORTAL_TRUST_ANNOTATIONS", "MCP_ALLOW_INSECURE",
  ],
  "gatekeeper-mcp": ["MCP_ALLOW_INSECURE"],
};

for (const gk of gatekeepers) {
  const srcPath = join(gk.dir, "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));
  config.build = devBuildConfig(config.build, gk.dir);
  config.vars = config.vars || {};
  config.vars.BASE_URL = `http://${backendHost}/gatekeeper/${gk.name.slice("gatekeeper-".length)}`;

  const shared = SHARED_GATEKEEPER_CREDS[gk.name];
  if (shared && process.env[shared.id] && process.env[shared.secret]) {
    if (config.vars.CLIENT_ID === undefined) config.vars.CLIENT_ID = process.env[shared.id];
    if (config.vars.CLIENT_SECRET === undefined) config.vars.CLIENT_SECRET = process.env[shared.secret];
  }

  // The shell wins over the committed default, so `MCP_ALLOW_INSECURE=true` can override the
  // `"false"` in wrangler.jsonc without editing it.
  for (const name of PASSTHROUGH_GATEKEEPER_VARS[gk.name] ?? []) {
    if (process.env[name] !== undefined) {
      config.vars[name] = process.env[name];
    }
  }

  const outPath = join(gk.dir, "wrangler.dev.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Generate packages/workshop-backend/wrangler.dev.jsonc (with gatekeeper
// service bindings using the GatekeeperVendor entrypoint).
// ---------------------------------------------------------------------------
{
  const srcPath = join(ROOT, "packages", "workshop-backend", "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));

  config.services = config.services || [];

  // For local testing, create an account named "admin" to test admin features.
  config.vars = config.vars || {};
  config.vars.ADMINS = ["admin"];

  // Pass through the optional OAuth sign-in / AI Gateway billing env vars from the shell
  // environment, so you can run e.g.
  //   ENABLE_CLOUDFLARE_LIMITS=true DAILY_LLM_CALL_LIMIT=1 pnpm dev-server
  // without editing any config files.
  const OPTIONAL_FEATURE_VARS = [
    "DISABLE_PASSWORD_AUTH", "AUTH_GATEKEEPERS", "ENABLE_CLOUDFLARE_LIMITS", "PUBLIC_BASE_URL",
    "DAILY_LLM_CALL_LIMIT", "MINIMUM_CLOUDFLARE_BALANCE",
    // Platform AI Gateway — makes the cross-provider model catalog available. CF_AI_GATEWAY
    // always needs CF_AI_GATEWAY_ACCOUNT_ID plus one transport: the WORKERS_AI binding
    // (start with --use-workers-ai-binding; CF_AI_GATEWAY_USE_BINDING=false opts out, e.g.
    // when the gateway lives in a different account than the dev binding) or
    // CF_AI_GATEWAY_API_TOKEN over HTTPS. The google provider can't ride the binding and
    // needs the token even when the binding is present.
    "CF_AI_GATEWAY", "CF_AI_GATEWAY_PROVIDERS", "CF_AI_GATEWAY_ACCOUNT_ID",
    "CF_AI_GATEWAY_API_TOKEN", "CF_AI_GATEWAY_USE_BINDING",
  ];
  // OAuth app credentials (GOOGLE_/GITHUB_/CLOUDFLARE_OAUTH_*) are NOT passed to the backend anymore;
  // they are injected into the gatekeeper Workers (see SHARED_GATEKEEPER_CREDS below).
  for (const name of OPTIONAL_FEATURE_VARS) {
    if (process.env[name] !== undefined) config.vars[name] = process.env[name];
  }

  for (const gk of gatekeepers) {
    const binding: ServiceBinding = {
      binding: bindingName(gk),
      service: gk.name,
      entrypoint: "GatekeeperVendor",
    };
    // The Context gatekeeper namespaces each workshop's data by a "sharingDomain" carried in its
    // binding props (see packages/gatekeeper-context/src/domain.ts). Dev uses a single domain.
    if (gk.name === CONTEXT_GATEKEEPER_NAME) {
      binding.props = { sharingDomain: "dev" };
    }
    config.services.push(binding);
  }

  if (useWorkersAi) {
    config.ai = { binding: "WORKERS_AI" };
  }

  // In run-local mode, serve the pre-built frontend bundle as static assets directly from the
  // backend Worker (mirrors the production layout). The dev-router forwards all non-gatekeeper
  // requests here; `run_worker_first` ensures the Worker handles the API routes while everything
  // else falls back to the single-page app.
  if (serveFrontendAssets) {
    config.assets = {
      directory: "../workshop-frontend/dist",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/blueprint-screenshot/*"],
    };
  }

  config.build = devBuildConfig(config.build, WORKSHOP_BACKEND_DIR);

  const outPath = join(ROOT, "packages", "workshop-backend", "wrangler.dev.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Build the wrangler dev command and exec it.
// ---------------------------------------------------------------------------

const configs = [
  "wrangler.dev.jsonc",
  join("packages", "workshop-backend", "wrangler.dev.jsonc"),
  ...gatekeepers.map(gk => join(gk.dir, "wrangler.dev.jsonc")),
];

const args = configs.flatMap(c => ["-c", c]);
if (wranglerPort) {
  args.push("--port", wranglerPort);
} else {
  console.warn(
      "VITE_BACKEND_HOST did not include a port, so run-dev-server.ts could not derive " +
      "a Wrangler --port override.");
}
console.log(`\nStarting: wrangler dev ${args.join(" ")}\n`);

// Reached directly for the same reason the generated custom builds are; falls back to `pnpm exec` if
// it cannot be resolved.
const wranglerEntry = resolveBinEntry(ROOT, "wrangler");
const [wranglerCommand, wranglerArgv]: [string, string[]] = wranglerEntry
  ? [process.execPath, [wranglerEntry, "dev", ...args]]
  : pnpmCommand(["exec", "wrangler", "dev", ...args]);

// `spawn`, not `execFileSync`, so the deferred watchers can start once the server is up. It stays in
// this process group with the terminal attached, so Ctrl-C reaches it as before.
wranglerChild = spawn(wranglerCommand, wranglerArgv, { stdio: "inherit", cwd: ROOT });

wranglerChild.on("error", err => {
  console.error(`wrangler dev could not be started: ${err.message}`);
  process.exit(1);
});
wranglerChild.on("exit", async (code, signal) => {
  // The crash path: Wrangler died on its own, so nothing has signalled the watchers and this handler
  // is what tears them down.
  await stopDevWatchersDeep();
  // The output was already shown via stdio: "inherit". A signal-initiated shutdown reports the
  // initiating signal's status; only when Wrangler died on its own is its status propagated.
  process.exit(shutdownExitCode ?? (signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1));
});

// Poll the socket rather than parsing stdout for "Ready on", which would mean giving up
// `stdio: "inherit"`. The deadline is a backstop so a server that never comes up does not leave the
// watchers silently unstarted.
await waitForPort(Number(wranglerPort ?? DEFAULT_WRANGLER_PORT), 60_000);
if (wranglerChild.exitCode === null) startDeferredWatchers();
