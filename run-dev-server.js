#!/usr/bin/env node

// Generates dev-only wrangler.dev.jsonc files for dynamic service bindings,
// then launches `wrangler dev` with all discovered workers.
//
// Flags:
//   --use-workers-ai-binding   Include the Workers AI binding in
//                               workshop-backend (requires Cloudflare login).
//
// Env:
//   VITE_BACKEND_HOST=localhost:9000  Also pass --port 9000 to wrangler dev.

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { getWranglerPortFromBackendHost } from "./scripts/dev-server-config.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(ROOT, "packages");

// Load a root `.dev.vars` file (KEY=VALUE lines) into process.env for local development. Existing
// shell environment values take precedence. This file is gitignored and may hold local secrets.
function loadDevVars() {
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

// ---------------------------------------------------------------------------
// Discover gatekeeper packages.
// ---------------------------------------------------------------------------
function findGatekeepers(parentDir) {
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

// Rebuild each gatekeeper's generated UI (src/generated/*) on source change so edits show up on
// reload; wrangler dev's `watch_dir: src` then re-bundles the worker.
const devWatchers = [];
let stoppingDevWatchers = false;

// Spawn a persistent watcher.
function spawnDevWatcher(label, command, args) {
  const watcher = spawn(command, args, { stdio: "inherit", cwd: ROOT });
  watcher.on("exit", (code, signal) => {
    if (stoppingDevWatchers) return;
    console.error(`${label} exited unexpectedly (code=${code}, signal=${signal}).`);
  });
  devWatchers.push(watcher);
}

for (const gk of gatekeepers) {
  // Configurator UI (compiled by build-gatekeeper-configurator.mjs).
  if (existsSync(join(gk.dir, "src", "configurator"))) {
    const script = join(ROOT, "scripts", "build-gatekeeper-configurator.mjs");
    execFileSync(process.execPath, [script, gk.dir, "--quiet"], { stdio: "inherit", cwd: ROOT });
    spawnDevWatcher(
      `configurator UI watcher for ${gk.name}`,
      process.execPath,
      [script, gk.dir, "--watch", "--quiet"],
    );
  }

  // Single-file app UI (Vite bundle written to src/generated/app.txt by build-app.mjs).
  if (existsSync(join(gk.dir, "build-app.mjs"))) {
    const script = join(gk.dir, "build-app.mjs");
    execFileSync(process.execPath, [script], { stdio: "inherit", cwd: gk.dir });
    spawnDevWatcher(`app UI watcher for ${gk.name}`, process.execPath, [script, "--watch"]);
  }
}

function stopDevWatchers() {
  stoppingDevWatchers = true;
  for (const watcher of devWatchers) watcher.kill();
}

process.on("exit", stopDevWatchers);
process.on("SIGINT", () => {
  stopDevWatchers();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopDevWatchers();
  process.exit(143);
});

// Helper: "gatekeeper-github" -> "GATEKEEPER_GITHUB"
function bindingName(gk) {
  return gk.name.toUpperCase().replaceAll("-", "_");
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
const SHARED_GATEKEEPER_CREDS = {
  "gatekeeper-github": { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  "gatekeeper-google": { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  "gatekeeper-cloudflare": { id: "CLOUDFLARE_OAUTH_CLIENT_ID", secret: "CLOUDFLARE_OAUTH_CLIENT_SECRET" },
  "gatekeeper-supabase": { id: "SUPABASE_CLIENT_ID", secret: "SUPABASE_CLIENT_SECRET" },
  "gatekeeper-notion": { id: "NOTION_CLIENT_ID", secret: "NOTION_CLIENT_SECRET" },
  "gatekeeper-zoominfo": { id: "ZOOMINFO_CLIENT_ID", secret: "ZOOMINFO_CLIENT_SECRET" },
  "gatekeeper-confluence": { id: "CONFLUENCE_CLIENT_ID", secret: "CONFLUENCE_CLIENT_SECRET" },
  "gatekeeper-slack": { id: "SLACK_CLIENT_ID", secret: "SLACK_CLIENT_SECRET" },
};

for (const gk of gatekeepers) {
  const srcPath = join(gk.dir, "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));
  config.build = { ...config.build, cwd: gk.dir };

  const shared = SHARED_GATEKEEPER_CREDS[gk.name];
  if (shared && process.env[shared.id] && process.env[shared.secret]) {
    config.vars = config.vars || {};
    if (config.vars.CLIENT_ID === undefined) config.vars.CLIENT_ID = process.env[shared.id];
    if (config.vars.CLIENT_SECRET === undefined) config.vars.CLIENT_SECRET = process.env[shared.secret];
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
    // Platform AI Gateway — makes the cross-provider model catalog available.
    "CF_AI_GATEWAY", "CF_AI_GATEWAY_PROVIDERS", "CF_AI_GATEWAY_ACCOUNT_ID",
    "CF_AI_GATEWAY_API_TOKEN", "CF_AI_GATEWAY_WAI",
    // Deploy-flow instance marker (simulates a deploy-wizard instance; seeds default Workers AI
    // models for new users — pair with --use-workers-ai-binding).
    "DEPLOY_URL",
  ];
  // OAuth app credentials (GOOGLE_/GITHUB_/CLOUDFLARE_OAUTH_*) are NOT passed to the backend anymore;
  // they are injected into the gatekeeper Workers (see SHARED_GATEKEEPER_CREDS below).
  for (const name of OPTIONAL_FEATURE_VARS) {
    if (process.env[name] !== undefined) config.vars[name] = process.env[name];
  }

  for (const gk of gatekeepers) {
    const binding = {
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

  const backendDir = join(ROOT, "packages", "workshop-backend");
  config.build = { ...config.build, cwd: backendDir };

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
const backendHost = process.env.VITE_BACKEND_HOST;
if (backendHost) {
  let wranglerPort;
  try {
    wranglerPort = getWranglerPortFromBackendHost(backendHost);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (wranglerPort) {
    args.push("--port", wranglerPort);
  } else {
    console.warn(
        "VITE_BACKEND_HOST did not include a port, so run-dev-server.js could not derive " +
        "a Wrangler --port override.");
  }
}
console.log(`\nStarting: wrangler dev ${args.join(" ")}\n`);

try {
  execFileSync("pnpm", ["exec", "wrangler", "dev", ...args],
      { stdio: "inherit", cwd: ROOT });
} catch (e) {
  // wrangler was killed or exited with an error; the output was already shown
  // via stdio: "inherit", so just propagate the exit code.
  process.exit(e.status ?? 1);
}
