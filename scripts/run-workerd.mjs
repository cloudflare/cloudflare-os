#!/usr/bin/env node

// Runs FieldOS on standalone workerd, with no Cloudflare account: bundles every worker with
// `wrangler deploy --dry-run`, emits a workerd `config.capnp` wiring the bundles together, and
// (unless --build-only) spawns `workerd serve` on it.
//
// Usage: node scripts/run-workerd.mjs [--out .workerd] [--port 8080] [--allow public,private]
//                                      [--build-only]

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectModules } from "./release/hash-lib.mjs";
import { findDeployablePackages, readWranglerConfig } from "./release/manifest-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const FRONTEND_DIST = join(PACKAGES_DIR, "workshop-frontend", "dist");

// The only packages this deployment shape includes today: the core two plus the seven
// gatekeepers that are actually maintained (the other ten in packages/ are delete-candidate
// connectors, per the task brief — skip them here rather than reading them out of some registry
// that doesn't exist yet).
const INCLUDED_GATEKEEPERS = new Set([
  "gatekeeper-mcp", "gatekeeper-mcp-portal", "gatekeeper-context", "gatekeeper-scheduler",
  "gatekeeper-homeassistant", "gatekeeper-oidc", "gatekeeper-github",
]);

function parseArgs(argv) {
  const args = { out: join(ROOT, ".workerd"), port: 8080, allow: ["public", "private"], buildOnly: false };
  for (let i = 0; i < argv.length; i++) {
    // Accept both `--flag value` and `--flag=value`.
    let a = argv[i];
    let inlineValue;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq !== -1) {
      inlineValue = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const nextValue = () => (inlineValue !== undefined ? inlineValue : argv[++i]);

    if (a === "--out") args.out = resolve(nextValue());
    else if (a === "--port") args.port = Number.parseInt(nextValue(), 10);
    else if (a === "--allow") {
      const raw = nextValue();
      args.allow = raw === "none" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--build-only") args.buildOnly = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 1. Discover + bundle each worker with `wrangler deploy --dry-run --outdir`.
// ---------------------------------------------------------------------------

const ALL_DEPLOYABLE = findDeployablePackages(PACKAGES_DIR);
const included = ALL_DEPLOYABLE.filter(
    (p) => p.name === "workshop-backend" || p.name === "router" || INCLUDED_GATEKEEPERS.has(p.name));

const bundlesDir = join(args.out, "bundles");
mkdirSync(bundlesDir, { recursive: true });

// A few gatekeepers ship a generated UI module (configurator forms and/or a single-file app)
// that `wrangler deploy`'s own `build.command` does not produce — it's a prerequisite step, the
// same one run-local.mjs/run-dev-server.js run before `wrangler dev`. Without it the dry-run
// bundle either fails (missing src/generated file) or silently ships a stale one left over from
// a previous build.
function prebuildGeneratedUi(pkg) {
  if (existsSync(join(pkg.dir, "src", "configurator"))) {
    execFileSync(
        process.execPath,
        [join(ROOT, "scripts", "build-gatekeeper-configurator.mjs"), pkg.dir, "--quiet"],
        { stdio: "inherit", cwd: ROOT },
    );
  }
  if (existsSync(join(pkg.dir, "build-app.mjs"))) {
    execFileSync(process.execPath, [join(pkg.dir, "build-app.mjs")], { stdio: "inherit", cwd: pkg.dir });
  }
}

const workers = []; // { pkgName, config, mainModule, modules, outDir }
for (const pkg of included) {
  console.log(`\nbundling ${pkg.name}...`);
  prebuildGeneratedUi(pkg);

  const outDir = join(bundlesDir, pkg.name);
  // Custom build commands (capnweb-validate) resolve their bin via `pnpm exec`, which requires
  // cwd to be inside the package so pnpm finds its node_modules/.bin.
  execFileSync(
      "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir],
      { stdio: "inherit", cwd: pkg.dir },
  );

  const config = readWranglerConfig(pkg.dir);
  const { mainModule, modules } = collectModules(outDir);
  workers.push({ pkgName: pkg.name, config, mainModule, modules, outDir });
}

// ---------------------------------------------------------------------------
// 2. uniqueKey persistence: generated once, reused across runs (it names the on-disk DO dir).
// ---------------------------------------------------------------------------

const keysPath = join(args.out, "keys.json");
const keys = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : {};

function uniqueKeyFor(id) {
  if (!keys[id]) keys[id] = crypto.randomUUID();
  return keys[id];
}

// ---------------------------------------------------------------------------
// 3. Emit config.capnp.
// ---------------------------------------------------------------------------

// capnp string literal escaping: backslash and double-quote only (no other escapes needed for
// paths/names/values we emit here).
function capnpString(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serviceName(pkgName) {
  return pkgName; // wrangler.jsonc's `name` field is already a valid capnp identifier-safe string.
}

function bindingNameFor(gatekeeperPkgName) {
  return gatekeeperPkgName.toUpperCase().replaceAll("-", "_");
}

// capnp const names must be camelCase with no underscores (workerd only warns, but the fix is
// one-line, so just emit it clean): "gatekeeper-mcp-portal" -> "gatekeeperMcpPortalWorker";
// "kv-blueprint_content" -> "kvBlueprintContentWorker".
function constName(id, suffix = "Worker") {
  const camel = id.replace(/[-_]([a-z0-9])/gi, (_, c) => c.toUpperCase());
  return camel + suffix;
}

const workerLines = [];
const serviceEntries = []; // top-level `services` list entries (name = ..., worker = .x / disk = ... / network = ...)

// `enable_ctx_exports` is a fatal config error at compatibility date 2026-02-02; strip it if a
// wrangler.jsonc ever grows it rather than fail the whole translation.
function compatibilityFlags(config) {
  return (config.compatibility_flags ?? []).filter((f) => f !== "enable_ctx_exports");
}

// Renders one `durableObjectNamespaces` entry + registers the sibling uniqueKey.
function renderDoNamespace(className, keyId) {
  return `      (className = ${capnpString(className)}, uniqueKey = ${capnpString(uniqueKeyFor(keyId))}, enableSql = true),`;
}

for (const w of workers) {
  const { pkgName, config, mainModule, modules, outDir } = w;
  const svc = serviceName(pkgName);

  // workerd picks the main module by *position* (the first `modules` entry), not by matching it
  // against anything else — verified by reproduction: with the ESM module listed after a `.txt`
  // sibling (collectModules sorts alphabetically, so a lexically-earlier .txt often lands first),
  // workerd fails to boot with "Main module must be an ES module" even though the file it
  // actually meant is a perfectly valid ES module. So the main module goes first, unconditionally.
  const moduleLines = [`      (name = ${capnpString(mainModule)}, esModule = embed ${capnpString(relative(args.out, join(outDir, mainModule)))}),`];
  for (const m of modules) {
    if (m.name === mainModule) continue;
    const embedPath = capnpString(relative(args.out, join(outDir, m.name)));
    if (m.type === "text") moduleLines.push(`      (name = ${capnpString(m.name)}, text = embed ${embedPath}),`);
    else throw new Error(`${pkgName}: don't know how to embed module ${m.name} (type ${m.type})`);
  }

  const doNamespaceLines = [];
  const migrations = config.migrations ?? [];
  const allNewSqliteClasses = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
  for (const className of allNewSqliteClasses) {
    doNamespaceLines.push(renderDoNamespace(className, `${pkgName}/${className}`));
  }

  const bindingLines = [];
  for (const kv of config.kv_namespaces ?? []) {
    bindingLines.push(`      (name = ${capnpString(kv.binding)}, kvNamespace = ${capnpString(`kv-${kv.binding.toLowerCase()}`)}),`);
  }
  for (const r2 of config.r2_buckets ?? []) {
    bindingLines.push(`      (name = ${capnpString(r2.binding)}, r2Bucket = ${capnpString(`r2-${r2.binding.toLowerCase()}`)}),`);
  }
  for (const loader of config.worker_loaders ?? []) {
    bindingLines.push(`      (name = ${capnpString(loader.binding)}, workerLoader = ()),`);
  }
  // `browser` has no capnp equivalent; omit entirely (both call sites guard and degrade cleanly).
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    if (typeof value === "string") bindingLines.push(`      (name = ${capnpString(name)}, text = ${capnpString(value)}),`);
    else bindingLines.push(`      (name = ${capnpString(name)}, json = ${capnpString(JSON.stringify(value))}),`);
  }

  // Service bindings the package declares for itself, e.g. the router's WORKSHOP_BACKEND. These
  // are ordinary worker-to-worker bindings and must be translated verbatim — the gatekeeper
  // bindings below are *injected* at deploy time and so are not listed in any wrangler.jsonc.
  // Missing this is not a loud failure: the router falls through to
  // `env.WORKSHOP_BACKEND.fetch(req)` and every /api request dies with
  // "Cannot read properties of undefined (reading 'fetch')".
  for (const declared of config.services ?? []) {
    const target = serviceName(declared.service);
    bindingLines.push(declared.entrypoint
        ? `      (name = ${capnpString(declared.binding)}, service = (name = ${capnpString(target)}, entrypoint = ${capnpString(declared.entrypoint)})),`
        : `      (name = ${capnpString(declared.binding)}, service = ${capnpString(target)}),`);
  }

  if (pkgName === "workshop-backend") {
    // The backend calls gatekeepers through their GatekeeperVendor entrypoint (vendor RPC), not
    // the default entrypoint the router uses (whole-HTTP-request forwarding) — these two differ.
    for (const gkPkgName of INCLUDED_GATEKEEPERS) {
      bindingLines.push(
          `      (name = ${capnpString(bindingNameFor(gkPkgName))}, service = (name = ${capnpString(serviceName(gkPkgName))}, entrypoint = "GatekeeperVendor")),`);
    }
  } else if (pkgName === "router") {
    // The router forwards whole HTTP requests to each gatekeeper's default entrypoint.
    for (const gkPkgName of INCLUDED_GATEKEEPERS) {
      bindingLines.push(`      (name = ${capnpString(bindingNameFor(gkPkgName))}, service = ${capnpString(serviceName(gkPkgName))}),`);
    }
    // Static assets: bind ASSETS to a worker service running fieldos-runtime's assets.js, itself
    // bound to a `disk` service over the built frontend.
    bindingLines.push(`      (name = "ASSETS", service = "assets"),`);
  }

  workerLines.push(`
const ${constName(pkgName)} :Workerd.Worker = (
  modules = [
${moduleLines.join("\n")}
  ],
  compatibilityDate = ${capnpString(config.compatibility_date)},
  compatibilityFlags = [${compatibilityFlags(config).map(capnpString).join(", ")}],
  globalOutbound = "internet",${doNamespaceLines.length > 0 ? `
  durableObjectNamespaces = [
${doNamespaceLines.join("\n")}
  ],
  durableObjectStorage = (localDisk = "do-disk"),` : ""}${bindingLines.length > 0 ? `
  bindings = [
${bindingLines.join("\n")}
  ],` : ""}
);`);
  serviceEntries.push(`    (name = ${capnpString(svc)}, worker = .${constName(pkgName)}),`);
}

// KV/R2 backing worker services (fieldos-runtime), one pair per binding across all workers.
const kvBindings = new Map(); // "kv-<binding>" -> className/keyId
const r2Bindings = new Map();
for (const w of workers) {
  for (const kv of w.config.kv_namespaces ?? []) {
    kvBindings.set(`kv-${kv.binding.toLowerCase()}`, `${w.pkgName}/${kv.binding}`);
  }
  for (const r2 of w.config.r2_buckets ?? []) {
    r2Bindings.set(`r2-${r2.binding.toLowerCase()}`, `${w.pkgName}/${r2.binding}`);
  }
}

const runtimeSrc = join(PACKAGES_DIR, "fieldos-runtime", "src");
for (const [svcName, keyId] of kvBindings) {
  const c = constName(svcName);
  workerLines.push(`
const ${c} :Workerd.Worker = (
  modules = [ (name = "kv.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "kv.js")))}) ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
${renderDoNamespace("KvStore", `kv/${keyId}`)}
  ],
  durableObjectStorage = (localDisk = "do-disk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "KvStore") ],
);`);
  serviceEntries.push(`    (name = ${capnpString(svcName)}, worker = .${c}),`);
}
for (const [svcName, keyId] of r2Bindings) {
  const c = constName(svcName);
  workerLines.push(`
const ${c} :Workerd.Worker = (
  modules = [ (name = "r2.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "r2.js")))}) ],
  compatibilityDate = "2026-02-02",
  durableObjectNamespaces = [
${renderDoNamespace("R2Store", `r2/${keyId}`)}
  ],
  durableObjectStorage = (localDisk = "do-disk"),
  bindings = [ (name = "STORE", durableObjectNamespace = "R2Store") ],
);`);
  serviceEntries.push(`    (name = ${capnpString(svcName)}, worker = .${c}),`);
}

// Static assets (router only): an assets worker fronting a disk service over the built frontend.
if (included.some((p) => p.name === "router")) {
  workerLines.push(`
const assetsWorker :Workerd.Worker = (
  modules = [ (name = "assets.js", esModule = embed ${capnpString(relative(args.out, join(runtimeSrc, "assets.js")))}) ],
  compatibilityDate = "2026-02-02",
  globalOutbound = "internet",
  bindings = [ (name = "DIST", service = "dist") ],
);`);
  serviceEntries.push(`    (name = "assets", worker = .assetsWorker),`);
  // allowDotfiles stays at its default (false): assets.js's own header comment documents this as
  // load-bearing (verified against traversal probes), not an oversight to "fix".
  serviceEntries.push(`    (name = "dist", disk = (path = ${capnpString(FRONTEND_DIST)}, writable = false)),`);
}

// The DO storage directory. workerd fails at startup with `Directory named "do-disk" not found`
// if this isn't created before boot.
const doDiskPath = join(args.out, "do-disk");
mkdirSync(doDiskPath, { recursive: true });
serviceEntries.push(`    (name = "do-disk", disk = (path = ${capnpString(doDiskPath)}, writable = true)),`);

// Outbound network. NEVER emit `deny = ["public"]` — that's a fatal config error. An empty allow
// list (--allow=none) is expressed as `allow = []`, not a `deny`.
serviceEntries.push(`    (name = "internet", network = (allow = [${args.allow.map(capnpString).join(", ")}])),`);

// The socket below points `service = "router"`, which resolves to the "router" entry the worker
// loop already pushed — no separate alias entry needed (Service has no `service` field of its
// own; a bare-name ServiceDesignator just looks up an existing service by name).
const capnp = `using Workerd = import "/workerd/workerd.capnp";

# Generated by scripts/run-workerd.mjs — do not edit by hand, rerun the script instead.
${workerLines.join("\n")}

const config :Workerd.Config = (
  services = [
${serviceEntries.join("\n")}
  ],
  sockets = [ (name = "http", address = "*:${args.port}", http = (), service = "router") ],
);
`;

mkdirSync(args.out, { recursive: true });
writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
const configPath = join(args.out, "config.capnp");
writeFileSync(configPath, capnp);
console.log(`\nwrote ${configPath}`);

// ---------------------------------------------------------------------------
// 4. Spawn workerd, unless --build-only.
// ---------------------------------------------------------------------------

if (args.buildOnly) {
  console.log("--build-only: not starting workerd.");
  process.exit(0);
}

console.log(`\nstarting: workerd serve config.capnp --experimental (port ${args.port})\n`);
const child = spawn(
    "pnpm", ["exec", "workerd", "serve", "config.capnp", "--experimental"],
    { stdio: "inherit", cwd: args.out },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
