// Generates the release manifest: the contract between this repo's CI (which builds worker
// bundles once, byte-identically, per commit) and the deploy service (which PUTs those bundles
// into customer accounts via the Workers script-upload API).
//
// This is the open-source analog of gadgets-internal's generate-wrangler-prod.js: it parses each
// package's wrangler.jsonc and emits binding *templates* — every account-specific value replaced
// by a placeholder the deploy service resolves from instance state:
//
//   $ACCOUNT_ID              the user's account tag
//   $KV_<BINDING>_ID         a KV namespace provisioned at deploy time
//   $R2_<BINDING>_NAME       an R2 bucket provisioned at deploy time
//   $WORKER_NAME(<pkg>)      the instance's chosen name for another worker in this release
//   $SECRET(<name>)          a user-supplied secret, passed through as secret_text
//   $PUBLIC_BASE_URL         the instance's public origin (the router's URL)
//
// The placeholder list is closed: the deploy-side renderer fails on any `$` token it doesn't
// recognize, so this file and the renderer must evolve together (manifestVersion guards that).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";

export const MANIFEST_VERSION = 1;

// wrangler.jsonc keys this generator understands. Anything else fails closed — a new config key
// on a deployable worker needs an explicit decision about how customer instances get it.
const HANDLED_CONFIG_KEYS = new Set([
  "$schema", "name", "main", "build", "compatibility_date", "compatibility_flags", "rules",
  "migrations", "observability", "kv_namespaces", "r2_buckets", "worker_loaders", "services",
  "assets", "vars",
  // Browser Rendering (Gadget PDF exports). Unlike artifacts it is generally available, so it
  // passes through to customer instances as a placeholder-free binding, like the AI binding.
  "browser",
  // gatekeeper-context's Artifacts binding is closed-beta and cannot be provisioned in arbitrary
  // user accounts; it is dropped from customer manifests (the gatekeeper degrades gracefully).
  "artifacts",
]);

const ARTIFACTS_CUT_ALLOWED = new Set(["gatekeeper-context"]);

// Installable gatekeepers that do NOT take third-party OAuth app credentials; everyone else
// defaults to CLIENT_ID/CLIENT_SECRET secret inputs (overridable via deploy-inputs.json).
const NO_DEFAULT_CRED_INPUTS = new Set([
  "gatekeeper-context",       // no third-party service; uses its own storage
  "gatekeeper-homeassistant", // users connect their own Home Assistant URL + token in-app
  "gatekeeper-scheduler",     // auto-provisioned; no third-party OAuth app
  "gatekeeper-mcp",           // MCP OAuth uses dynamic client registration, not a static app
  "gatekeeper-mcp-portal",    // same MCP OAuth chain as gatekeeper-mcp
]);

// Not installable on customer instances: Email Routing needs a zone, which workers.dev-hosted
// instances don't have. The bundle still ships in the release so the entry stays auditable.
const NOT_INSTALLABLE = new Set(["gatekeeper-email"]);

// Ambient gatekeepers the deploy service installs on every fresh core deploy, server-side with
// no user interaction. Members must take no inputs of any kind (enforced below): a preinstall
// has nobody to ask.
const PREINSTALL = new Set(["gatekeeper-context", "gatekeeper-scheduler"]);

// Gatekeepers that may be installed at most once per instance; the deploy service enforces this
// at install time. The giveaway is the account declaring an agent singleton
// (`AccountDescription.singleton` — context's `ContextLibrary`, scheduler's `ScheduleSession`):
// the Workshop auto-provisions those accounts and folds the singleton into every workspace as an
// ambient gatekeeper, so a second install would hand every user a duplicate ambient capsule.
// Independent of PREINSTALL in principle; the two sets coincide today only because every ambient
// gatekeeper we ship is also preinstalled.
const SINGLETON = new Set(["gatekeeper-context", "gatekeeper-scheduler"]);

export const DEFAULT_CRED_INPUTS = [
  {
    name: "CLIENT_ID",
    kind: "secret",
    label: "OAuth client ID",
  },
  {
    name: "CLIENT_SECRET",
    kind: "secret",
    label: "OAuth client secret",
  },
];

// Discover the deployable set: every public package with a wrangler.jsonc.
export function findDeployablePackages(packagesDir) {
  return readdirSync(packagesDir)
      .filter((name) => {
    try {
      return statSync(join(packagesDir, name, "wrangler.jsonc")).isFile();
    } catch {
      return false;
    }
  })
      .toSorted()
      .map((name) => ({ name, dir: join(packagesDir, name) }));
}

export function readWranglerConfig(pkgDir) {
  return parse(readFileSync(join(pkgDir, "wrangler.jsonc"), "utf8"));
}

export function readDeployInputs(pkgDir) {
  const path = join(pkgDir, "deploy-inputs.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function workerKind(pkgName) {
  if (pkgName === "workshop-backend") return "backend";
  if (pkgName === "router") return "router";
  if (pkgName.startsWith("gatekeeper-")) return "gatekeeper";
  throw new Error(`cannot classify deployable package: ${pkgName}`);
}

function shortName(pkgName) {
  return pkgName.slice("gatekeeper-".length);
}

// Builds one worker's manifest entry from its parsed wrangler.jsonc and collected modules.
// `modules` entries are { name, type, sha256, size } (bytes stripped by the caller).
export function buildWorkerEntry({ pkgName, config, mainModule, modules, deployInputs }) {
  const kind = workerKind(pkgName);
  const unknownKeys = Object.keys(config).filter((k) => !HANDLED_CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`${pkgName}/wrangler.jsonc has key(s) this generator doesn't handle: ` +
        unknownKeys.join(", "));
  }
  if (config.artifacts && !ARTIFACTS_CUT_ALLOWED.has(pkgName)) {
    throw new Error(`${pkgName} declares an artifacts binding; only gatekeeper-context's is ` +
        `known (and cut). Decide how customer instances should handle this one.`);
  }

  const bindings = [];
  const vars = {};

  for (const kv of config.kv_namespaces ?? []) {
    bindings.push({
      type: "kv_namespace",
      name: kv.binding,
      namespace_id: `$KV_${kv.binding}_ID`,
    });
  }
  for (const r2 of config.r2_buckets ?? []) {
    bindings.push({
      type: "r2_bucket",
      name: r2.binding,
      bucket_name: `$R2_${r2.binding}_NAME`,
    });
  }
  if (config.browser) {
    // `remote` is dev-only wrangler behavior; the deployed binding is just { type, name }.
    bindings.push({ type: "browser", name: config.browser.binding });
  }
  for (const loader of config.worker_loaders ?? []) {
    bindings.push({ type: "worker_loader", name: loader.binding });
  }
  for (const svc of config.services ?? []) {
    bindings.push({
      type: "service",
      name: svc.binding,
      service: `$WORKER_NAME(${svc.service})`,
      ...(svc.entrypoint ? { entrypoint: svc.entrypoint } : {}),
    });
  }

  let assetsConfig;
  if (config.assets) {
    bindings.push({ type: "assets", name: config.assets.binding ?? "ASSETS" });
    assetsConfig = {
      not_found_handling: config.assets.not_found_handling,
      run_worker_first: config.assets.run_worker_first,
      // Filled by the caller (build-release) with
      // { access: { manifest: { "/path": { hash, size } } } }.
      variants: {},
    };
  }

  Object.assign(vars, config.vars ?? {});

  // Per-kind template vars, mirroring what generate-wrangler-prod.js hand-codes internally
  // (PUBLIC_BASE_URL on the backend; per-gatekeeper BASE_URL under the shared origin).
  let inputs;
  let installable = true;
  let gatekeeperBindingExpansion;
  if (kind === "backend") {
    // Deliberate contract: the manifest carries only $PUBLIC_BASE_URL. The backend's other
    // instance-state vars (ADMINS, DEPLOY_URL, CF_ACCESS_*, CF_AI_GATEWAY*) are injected by
    // the deploy service's backendExtraVars at PUT time, never manifest-templated.
    vars.PUBLIC_BASE_URL = "$PUBLIC_BASE_URL";
    // Every deployed backend gets the Workers AI binding (hardcoded like PUBLIC_BASE_URL, not
    // read from wrangler.jsonc): webFetch's toMarkdown conversion depends on it, and it costs
    // nothing when unused. (Inference does not — Workers AI models are reached over HTTPS like
    // every other provider.) No placeholders — the deploy renderer passes it through.
    bindings.push({ type: "ai", name: "WORKERS_AI" });
    // Installed gatekeepers are called through GATEKEEPER_* service bindings with the
    // GatekeeperVendor entrypoint (same shape run-dev-server.js generates for dev).
    gatekeeperBindingExpansion = {
      entrypoint: "GatekeeperVendor",
      // gatekeeper-context namespaces each workshop's shared data by a sharingDomain carried in
      // binding props; the instance's public origin is the natural stable value.
      propsByPackage: {
        "gatekeeper-context": { sharingDomain: "$PUBLIC_BASE_URL" },
      },
    };
  } else if (kind === "router") {
    // The router routes /gatekeeper/<short>/* by scanning its own GATEKEEPER_* bindings
    // (default entrypoint — it forwards whole HTTP requests, not vendor RPC).
    gatekeeperBindingExpansion = { propsByPackage: {} };
  } else {
    vars.BASE_URL = `$PUBLIC_BASE_URL/gatekeeper/${shortName(pkgName)}`;
    installable = !NOT_INSTALLABLE.has(pkgName);
    if (installable) {
      inputs = deployInputs ??
          (NO_DEFAULT_CRED_INPUTS.has(pkgName) ? [] : DEFAULT_CRED_INPUTS);
    } else {
      inputs = [];
    }
    // Every declared secret input becomes a pass-through secret_text binding.
    for (const input of inputs) {
      if (input.kind === "secret") {
        bindings.push({ type: "secret_text", name: input.name, text: `$SECRET(${input.name})` });
      }
    }
    if (PREINSTALL.has(pkgName) && inputs.length > 0) {
      throw new Error(`${pkgName} is preinstalled but declares input(s); preinstalls run ` +
          `with no user interaction, so this release would be broken`);
    }
  }

  return {
    kind,
    ...(kind === "gatekeeper" ? { shortName: shortName(pkgName) } : {}),
    installable,
    ...(PREINSTALL.has(pkgName) ? { preinstall: true } : {}),
    ...(SINGLETON.has(pkgName) ? { singleton: true } : {}),
    mainModule,
    modules: modules.map(({ name, type, sha256, size }) => ({
      name, type, sha256, size, r2Key: moduleR2Key(sha256),
    })),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    // Full ordered history, verbatim: fresh installs replay it as migration steps, and the
    // final tag is what re-PUTs of an existing worker must present as their current tag.
    migrations: config.migrations ?? [],
    bindings,
    vars,
    observability: config.observability ?? { enabled: false },
    ...(gatekeeperBindingExpansion ? { gatekeeperBindingExpansion } : {}),
    ...(assetsConfig ? { assetsConfig } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

export function moduleR2Key(sha256) {
  return `blobs/modules/${sha256}`;
}

export function assetR2Key(cfHash) {
  return `blobs/assets/${cfHash}`;
}

// Assembles the full manifest.
//  - workers: [{ pkgName, config, mainModule, modules, deployInputs }]
//  - assetVariants: { [variantName]: { manifest, blobs } } from collectAssets() — attached to
//    every worker entry that has an assetsConfig (today: just the router).
export function generateManifest({
  releaseId, commit, createdAt, wranglerVersion, workers, assetVariants,
}) {
  const workerEntries = {};
  for (const w of workers) {
    workerEntries[w.pkgName] = buildWorkerEntry(w);
  }

  const assets = {};
  for (const [variant, { manifest, blobs }] of Object.entries(assetVariants ?? {})) {
    for (const [hash, blob] of blobs) {
      assets[hash] = { size: blob.size, r2Key: assetR2Key(hash) };
    }
    for (const entry of Object.values(workerEntries)) {
      if (entry.assetsConfig) {
        entry.assetsConfig.variants[variant] = { manifest };
      }
    }
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    releaseId,
    commit,
    createdAt,
    wranglerVersion,
    workers: workerEntries,
    assets,
  };
}
