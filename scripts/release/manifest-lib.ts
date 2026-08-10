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
import type { AssetManifestEntry, CollectedAssets, CollectedModule } from "./hash-lib.ts";

/** Manifest version the deploy-side renderer must agree with (see header comment). */
export const MANIFEST_VERSION = 1;

/** A `{ binding: "NAME" }`-shaped wrangler binding declaration. */
export interface BindingDecl {
  binding: string;
}

/** A service binding declaration in a wrangler config. */
export interface ServiceBinding {
  /** Binding name the calling worker reads. */
  binding: string;
  /** Name of the worker being called. */
  service: string;
  /** RPC entrypoint on the target, when the caller uses one rather than plain HTTP. */
  entrypoint?: string;
  /** Props handed to the target worker on every call. */
  props?: Record<string, unknown>;
}

/**
 * A worker's custom `build` stanza — the command wrangler runs before bundling. Shared with
 * `run-dev-server.ts`, which rewrites the command for dev.
 */
export interface WranglerBuild {
  /** Shell command wrangler runs. */
  command?: string;
  /** Directory the command runs in. Relative paths in it resolve against this. */
  cwd?: string;
  /** Paths whose changes re-run the command under `wrangler dev`. */
  watch_dir?: string | string[];
}

/**
 * Workers observability settings. Deliberately closed rather than carrying an index signature: a
 * new key in a deployable worker's wrangler.jsonc should surface here, the same way
 * `HANDLED_CONFIG_KEYS` makes an unrecognized top-level key fail the build.
 */
export interface ObservabilityConfig {
  /** Whether observability is on. */
  enabled: boolean;
  /** Fraction of requests sampled. */
  head_sampling_rate?: number;
  /** Nested log settings. */
  logs?: {
    enabled?: boolean;
    invocation_logs?: boolean;
    head_sampling_rate?: number;
  };
}

/**
 * One Durable Object migration step, verbatim from wrangler.jsonc. Only the operations the
 * deployable workers actually use are named; the index signature carries anything else through
 * untouched, since the manifest replays the history rather than interpreting it.
 */
export interface DurableObjectMigration {
  /** Migration tag. The final one is what re-PUTs of an existing worker must present. */
  tag: string;
  /** Classes introduced with SQLite-backed storage. */
  new_sqlite_classes?: string[];
  [key: string]: unknown;
}

/**
 * The subset of a deployable worker's `wrangler.jsonc` this pipeline reads. Shared by the manifest
 * generator, `build-release.ts` and the preview-config generator, so all three agree on the shape.
 * Deliberately partial and loose: `buildWorkerEntry` fails closed on any key not in
 * `HANDLED_CONFIG_KEYS`, which is the real guard against a config shape nobody has decided about.
 */
export interface WranglerConfig {
  /** Worker name as deployed by `wrangler deploy` from this package. */
  name?: string;
  /** Entry module path, relative to the package directory. */
  main?: string;
  /** Workers runtime compatibility date. */
  compatibility_date?: string;
  /** Workers runtime compatibility flags. */
  compatibility_flags?: string[];
  /** Durable Object migration history, ordered. Replayed verbatim by fresh installs. */
  migrations?: DurableObjectMigration[];
  /** Workers observability settings. */
  observability?: ObservabilityConfig;
  /** KV namespace bindings; ids become `$KV_<BINDING>_ID` placeholders. */
  kv_namespaces?: BindingDecl[];
  /** R2 bucket bindings; names become `$R2_<BINDING>_NAME` placeholders. */
  r2_buckets?: BindingDecl[];
  /** Worker Loader bindings (the Gadget sandbox). */
  worker_loaders?: BindingDecl[];
  /** Service bindings; targets become `$WORKER_NAME(<pkg>)` placeholders. */
  services?: ServiceBinding[];
  /** Browser Rendering binding (Gadget PDF exports). */
  browser?: BindingDecl;
  /** Artifacts binding — closed beta, cut from customer manifests. */
  artifacts?: BindingDecl;
  /** Static-asset serving config (the router). */
  assets?: {
    binding?: string;
    directory?: string;
    not_found_handling?: string;
    run_worker_first?: string[];
  };
  /** Plain-text vars, passed through and extended with per-kind template vars. */
  vars?: Record<string, unknown>;
  /** Custom build command wrangler runs before bundling. */
  build?: WranglerBuild;
  /** Module resolution rules for non-JS imports. */
  rules?: unknown[];
  /** Present in the files but ignored. */
  $schema?: string;
}

/** One user-supplied value the deploy wizard collects before installing a gatekeeper. */
export interface DeployInput {
  /** Env var / secret name the worker reads. Screaming snake case. */
  name: string;
  /** How the deploy service supplies it. Secrets become `secret_text` bindings. */
  kind: "secret" | "var" | "workerName";
  /** Wizard field label. */
  label: string;
  /** Optional longer help text shown under the field. */
  help?: string;
  /** Link to the third-party console page where the value is found. */
  consoleUrl?: string;
  /** Ordered setup steps shown alongside the field. */
  setupSteps?: string[];
  /** Redirect URI to show the user, with `$PUBLIC_BASE_URL` still unresolved. */
  redirectUriTemplate?: string;
}

/** A rendered binding in a worker's manifest entry; account-specific values are placeholders. */
export type ManifestBinding = { type: string; name: string } & Record<string, unknown>;

/** Everything the manifest says about one worker in the release. */
export interface WorkerEntry {
  /** Which role this worker plays in a deployment. */
  kind: "backend" | "router" | "gatekeeper";
  /** Gatekeepers only: the path segment the router routes `/gatekeeper/<shortName>/*` on. */
  shortName?: string;
  /** Whether the deploy wizard offers this worker for installation. */
  installable: boolean;
  /** Installed server-side on every fresh core deploy, with no user interaction. */
  preinstall?: true;
  /** Installable at most once per instance. */
  singleton?: true;
  /** Name of the ESM entry module within `modules`. */
  mainModule: string;
  /** Every uploadable module, content-addressed. */
  modules: { name: string; type: string; sha256: string; size: number; r2Key: string }[];
  /** Workers runtime compatibility date. */
  compatibilityDate: string | undefined;
  /** Workers runtime compatibility flags. */
  compatibilityFlags: string[];
  /** Full ordered migration history, verbatim from wrangler.jsonc. */
  migrations: DurableObjectMigration[];
  /** Binding templates for the deploy-side renderer. */
  bindings: ManifestBinding[];
  /** Plain-text vars, including the per-kind templated ones. */
  vars: Record<string, unknown>;
  /** Workers observability settings. */
  observability: ObservabilityConfig;
  /** How the deploy service expands installed gatekeepers into `GATEKEEPER_*` bindings. */
  gatekeeperBindingExpansion?: {
    entrypoint?: string;
    propsByPackage: Record<string, Record<string, unknown>>;
  };
  /** Static-asset serving config, with one manifest per asset variant. */
  assetsConfig?: {
    not_found_handling: string | undefined;
    run_worker_first: string[] | undefined;
    variants: Record<string, { manifest: Record<string, AssetManifestEntry> }>;
  };
  /** Values the deploy wizard collects before installing. Absent for core workers. */
  inputs?: DeployInput[];
}

/** The release manifest: the contract between this repo's CI and the deploy service. */
export interface ReleaseManifest {
  /** Guards the closed placeholder list against renderer drift. */
  manifestVersion: number;
  /** Immutable release id; the R2 prefix everything lands under. */
  releaseId: string;
  /** Full commit SHA the release was built from. */
  commit: string;
  /** ISO-8601 build time. */
  createdAt: string;
  /** Version of the pinned wrangler that produced every bundle. */
  wranglerVersion: string;
  /** Per-package worker entries. */
  workers: Record<string, WorkerEntry>;
  /** Every unique asset blob in the release, keyed by content hash. */
  assets: Record<string, { size: number; r2Key: string }>;
}

/** One worker's build products, as handed to {@link generateManifest}. */
export interface WorkerBuild {
  /** Workspace package directory name, e.g. `gatekeeper-google`. */
  pkgName: string;
  /** The package's parsed wrangler.jsonc. */
  config: WranglerConfig;
  /** Name of the ESM entry module within `modules`. */
  mainModule: string;
  /** Every uploadable module from the dry-run bundle. */
  modules: CollectedModule[];
  /** Contents of the package's `deploy-inputs.json`, if it has one. */
  deployInputs?: DeployInput[];
}

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

/** Default wizard inputs for an installable gatekeeper that fronts a third-party OAuth app. */
export const DEFAULT_CRED_INPUTS: DeployInput[] = [
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

/** Discover the deployable set: every public package with a wrangler.jsonc. */
export function findDeployablePackages(packagesDir: string): { name: string; dir: string }[] {
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

/** Parse one package's wrangler.jsonc. */
export function readWranglerConfig(pkgDir: string): WranglerConfig {
  return parse(readFileSync(join(pkgDir, "wrangler.jsonc"), "utf8")) as WranglerConfig;
}

/** Read a package's `deploy-inputs.json`, or undefined if it declares none. */
export function readDeployInputs(pkgDir: string): DeployInput[] | undefined {
  const path = join(pkgDir, "deploy-inputs.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as DeployInput[];
}

function workerKind(pkgName: string): WorkerEntry["kind"] {
  if (pkgName === "workshop-backend") return "backend";
  if (pkgName === "router") return "router";
  if (pkgName.startsWith("gatekeeper-")) return "gatekeeper";
  throw new Error(`cannot classify deployable package: ${pkgName}`);
}

function shortName(pkgName: string): string {
  return pkgName.slice("gatekeeper-".length);
}

/**
 * Builds one worker's manifest entry from its parsed wrangler.jsonc and collected modules.
 * `modules` entries are { name, type, sha256, size } (bytes stripped by the caller).
 */
export function buildWorkerEntry(
  { pkgName, config, mainModule, modules, deployInputs }: WorkerBuild,
): WorkerEntry {
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

  const bindings: ManifestBinding[] = [];
  const vars: Record<string, unknown> = {};

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

  let assetsConfig: WorkerEntry["assetsConfig"];
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
  let inputs: DeployInput[] | undefined;
  let installable = true;
  let gatekeeperBindingExpansion: WorkerEntry["gatekeeperBindingExpansion"];
  if (kind === "backend") {
    // Deliberate contract: the manifest carries only $PUBLIC_BASE_URL. The backend's other
    // instance-state vars (ADMINS, DEPLOY_URL, CF_ACCESS_*, CF_AI_GATEWAY*) are injected by
    // the deploy service's backendExtraVars at PUT time, never manifest-templated.
    vars.PUBLIC_BASE_URL = "$PUBLIC_BASE_URL";
    // Every deployed backend gets the Workers AI binding (hardcoded like PUBLIC_BASE_URL, not
    // read from wrangler.jsonc): webFetch's toMarkdown conversion depends on it, and it is also
    // the backend's default AI Gateway transport (the deploy service creates the gateway in the
    // user's own account, so the in-account requirement holds; CF_AI_GATEWAY_USE_BINDING=false
    // is the cross-account opt-out) — binding requests are pre-authenticated, so inference and
    // cost-log reads need no CF_AI_GATEWAY_API_TOKEN (google provider excepted).
    // No placeholders — the deploy renderer passes it through.
    bindings.push({ type: "ai", name: "WORKERS_AI" });
    // Installed gatekeepers are called through GATEKEEPER_* service bindings with the
    // GatekeeperVendor entrypoint (same shape run-dev-server.ts generates for dev).
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

/** R2 key a worker module blob is stored under, by content hash. */
export function moduleR2Key(sha256: string): string {
  return `blobs/modules/${sha256}`;
}

/** R2 key a static-asset blob is stored under, by content key. */
export function assetR2Key(cfHash: string): string {
  return `blobs/assets/${cfHash}`;
}

/**
 * Assembles the full manifest.
 *  - workers: [{ pkgName, config, mainModule, modules, deployInputs }]
 *  - assetVariants: { [variantName]: { manifest, blobs } } from collectAssets() — attached to
 *    every worker entry that has an assetsConfig (today: just the router).
 */
export function generateManifest({
  releaseId, commit, createdAt, wranglerVersion, workers, assetVariants,
}: {
  releaseId: string;
  commit: string;
  createdAt: string;
  wranglerVersion: string;
  workers: WorkerBuild[];
  assetVariants?: Record<string, CollectedAssets>;
}): ReleaseManifest {
  const workerEntries: Record<string, WorkerEntry> = {};
  for (const w of workers) {
    workerEntries[w.pkgName] = buildWorkerEntry(w);
  }

  const assets: ReleaseManifest["assets"] = {};
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
