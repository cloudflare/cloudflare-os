#!/usr/bin/env node

// Generates a `wrangler.staging.jsonc` next to every deployable package's `wrangler.jsonc`,
// describing that worker as it runs in a per-PR **Worker Preview**. The generated files are
// gitignored (.gitignore) — they are build output, regenerated on every `preview.ts`
// invocation.
//
// This is the preview-side counterpart of scripts/release/manifest-lib.ts: same 18 deployable
// packages, same binding topology, but resolved to concrete staging values instead of the
// manifest's `$PLACEHOLDER` templates. Where the deploy service would substitute
// `$PUBLIC_BASE_URL`, a preview substitutes the router preview's workers.dev URL.
//
// Each worker's config has two halves:
//   - the top level, which describes the *baseline* worker (`wrangler deploy`). Worker Previews
//     are branches of a baseline worker, so one must exist before a preview can be created;
//     preview.ts deploys it on demand the first time (see its isMissingWorkerError self-heal).
//   - the `previews` block, which describes the per-preview overrides (`wrangler preview`).
//     This is where resources are declared *binding-only* so Wrangler provisions a fresh KV
//     namespace / R2 bucket per preview, and where service bindings get patched to point at
//     sibling previews rather than the baselines.
//
// Gatekeeper OAuth app credentials (CLIENT_ID/CLIENT_SECRET) are deliberately absent: previews
// exercise routing, auth and the agent, not third-party connector flows.

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findDeployablePackages, readWranglerConfig,
  type BindingDecl, type ObservabilityConfig, type ServiceBinding, type WranglerConfig,
} from "../release/manifest-lib.ts";

/**
 * A service binding in a preview config. `preview_id` is what points a binding at a *sibling*
 * preview rather than at the baseline worker; preview.ts patches it in between deployment tiers.
 */
export interface PreviewService extends ServiceBinding {
  /** The sibling preview to bind to, instead of the baseline worker of the same name. */
  preview_id?: string;
}

/**
 * The `previews` block: the per-preview overrides `wrangler preview` applies on top of the
 * baseline worker. Resource lists here are declared binding-only, which is how Wrangler is told to
 * auto-provision a fresh resource per preview.
 */
export interface PreviewOverrides {
  /** Observability settings; previews turn invocation logs on. */
  observability?: ObservabilityConfig;
  /** Plain-text vars for the preview. */
  vars?: Record<string, unknown>;
  /** Service bindings, each pointed at a sibling preview once its id is known. */
  services?: PreviewService[];
  /** KV namespaces to auto-provision per preview. */
  kv_namespaces?: BindingDecl[];
  /** R2 buckets to auto-provision per preview. */
  r2_buckets?: BindingDecl[];
  /** Worker Loader bindings (the Gadget sandbox). */
  worker_loaders?: BindingDecl[];
  /** Workers AI binding. */
  ai?: BindingDecl;
  /** Browser Rendering binding. */
  browser?: BindingDecl;
  /** Artifacts binding (closed beta). */
  artifacts?: BindingDecl;
  /** Passed through untouched from the committed config. */
  unsafe?: unknown;
}

/**
 * A generated `wrangler.staging.jsonc`: everything a committed wrangler.jsonc carries, plus the
 * keys that exist only for a preview deployment.
 */
export interface StagingConfig extends WranglerConfig {
  /** The Cloudflare account previews deploy to. */
  account_id?: string;
  /** Whether the worker gets a workers.dev hostname. Only the router does. */
  workers_dev?: boolean;
  /** Whether previews of this worker get public URLs. Only the router's do. */
  preview_urls?: boolean;
  /** Zone routes. Always deleted — the preview account has no zone. */
  routes?: unknown[];
  /** D1 bindings. None today; stripped alongside the other resource lists. */
  d1_databases?: BindingDecl[];
  /** Workers AI binding, injected for the backend. */
  ai?: BindingDecl;
  /** Passed through untouched from the committed config. */
  unsafe?: unknown;
  /** The per-preview overrides. */
  previews?: PreviewOverrides;
}

/** A deployable package as the generator sees it: its name and its parsed wrangler.jsonc. */
export interface PackageConfig {
  /** The workspace package directory name, which is also the worker name. */
  name: string;
  /** The parsed wrangler.jsonc. */
  config: WranglerConfig;
}

/** A deployable package on disk, as {@link readPackages} returns it. */
export interface DeployablePackage extends PackageConfig {
  /** Absolute path to the package directory. */
  dir: string;
}

/** The values every `apply*` function derives its config from. */
interface PreviewContext {
  /** The preview's public origin: the router preview's workers.dev URL. */
  baseUrl: string;
  /** Every gatekeeper package name, sorted. */
  gatekeepers: string[];
}

/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The directory holding every deployable package. */
export const PACKAGES_DIR = join(ROOT, "packages");

/** The generated per-package config file name (gitignored — it is build output). */
export const STAGING_CONFIG_NAME = "wrangler.staging.jsonc";

/** R2's limit on a bucket name, which is what bounds a preview name. */
export const R2_MAX_BUCKET_NAME_LENGTH = 63;

/**
 * How long a preview name may be. Wrangler names an auto-provisioned bucket
 * `<worker>-<preview>-<binding lowercased>`, so the longest worker and binding in the workspace
 * are what this has to leave room for — today the backend's `blueprint-content`, with 28 to
 * spare. Not derived from that pair, because the next worker or binding would silently outgrow
 * the arithmetic: assertBucketNamesFit checks the number against the generated configs instead.
 */
export const MAX_PREVIEW_NAME_LENGTH = 28;
const PREVIEW_NAME_HASH_LENGTH = 8;

const GATEKEEPER_PREFIX = "gatekeeper-";

/** True for the packages that are gatekeeper workers (as opposed to the router and backend). */
export function isGatekeeper(pkgName: string): boolean {
  return pkgName.startsWith(GATEKEEPER_PREFIX);
}

/**
 * The vendor id a gatekeeper is reached by: `gatekeeper-mcp-portal` -> `mcp-portal`. Matches
 * manifest-lib.ts's shortName, and hence the `/gatekeeper/<short>` path the router serves.
 */
export function gatekeeperShortName(pkgName: string): string {
  return pkgName.slice(GATEKEEPER_PREFIX.length);
}

/**
 * The service binding name a gatekeeper is bound as: `gatekeeper-mcp-portal` ->
 * `GATEKEEPER_MCP_PORTAL`. Both the router (router/src/index.ts) and the backend
 * (buildGatekeeperVendorMap) discover gatekeepers by scanning for this prefix, so the name is
 * the wiring — nothing references a specific gatekeeper.
 */
export function gatekeeperBindingName(pkgName: string): string {
  return pkgName.toUpperCase().replaceAll("-", "_");
}

/**
 * A worker's preview URL, in Cloudflare's fixed `<preview>-<worker>.<subdomain>.workers.dev`
 * shape. Only the router has one — see {@link routerPreviewUrl}.
 */
export function previewUrlFor(
  pkgName: string,
  previewName: string,
  workersDevHost: string,
): string {
  return `https://${previewName}-${pkgName}.${workersDevHost}`;
}

/**
 * The preview's public origin, and the only hostname an instance exposes. The router serves the
 * frontend and proxies `/api/*` and `/gatekeeper/<short>/*` over service bindings, so no other
 * worker needs to be reachable by name — and preview URLs are public, so giving the backend and
 * the sixteen gatekeepers one would publish a way around the router for no gain. Every other
 * worker's URL config is derived from this one.
 *
 * A preview URL cannot be moved to a zone: Cloudflare only serves them from workers.dev, and the
 * `previews` config block has no route or custom-domain key. A *baseline* can have a custom
 * domain, but that is a different worker from the previews branched off it.
 */
export function routerPreviewUrl(previewName: string, workersDevHost: string): string {
  return previewUrlFor("router", previewName, workersDevHost);
}

/** Slugify an arbitrary ref name into a legal preview name, truncating with a stable hash. */
export function slugifyPreviewName(
  raw: string,
  { reserve = 0 }: { reserve?: number } = {},
): string {
  const budget = MAX_PREVIEW_NAME_LENGTH - reserve;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return "preview";
  if (slug.length <= budget) return slug;

  const hash = createHash("sha256").update(raw).digest("hex").slice(0, PREVIEW_NAME_HASH_LENGTH);
  const prefix = slug.slice(0, budget - PREVIEW_NAME_HASH_LENGTH - 1).replace(/-+$/g, "");
  return `${prefix}-${hash}`;
}

// Local fallback when PREVIEW_NAME is unset: the current branch, else the current revision.
function localRefName(): string {
  for (const argv of [["branch", "--show-current"], ["rev-parse", "--short", "HEAD"]]) {
    try {
      const out = execFileSync("git", argv,
          { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out) return argv[0] === "branch" ? out : `local-${out}`;
    } catch {
      // Not a git checkout, or a detached HEAD with no branch: try the next form.
    }
  }
  return "local-preview";
}

/**
 * The preview name, which is also the first label of its hostname — so CI passes the pull request's
 * number *and* its head branch, and a preview reads as `pr123-my-branch-router.<subdomain>`: still
 * recognizable, but unique per pull request. The number is what makes it unique, since two live
 * branches can slugify to one name (`feature/foo`, `feature-foo` and `Feature_Foo` all do) and would
 * otherwise share a single instance, overwriting each other and deleting each other on close.
 *
 * With no number — a local run — the name is the bare slug, and {@link previewPullRequestNumber}
 * reads none back out of it. The residual is that renaming a branch mid-review orphans the preview
 * deployed under the old name, until the nightly sweep collects it.
 */
export function resolvePreviewName(
  { name = process.env.PREVIEW_NAME, prNumber = process.env.PREVIEW_PR_NUMBER }:
      { name?: string; prNumber?: string } = {},
): string {
  const ref = name || localRefName();
  // Anything that is not a number is treated as absent: on a scheduled run the workflow's
  // interpolation is the empty string, and no other value names a pull request.
  const pr = (prNumber ?? "").trim();
  if (!/^\d+$/.test(pr)) return slugifyPreviewName(ref);
  const prefix = `pr${pr}-`;
  return `${prefix}${slugifyPreviewName(ref, { reserve: prefix.length })}`;
}

export function previewPullRequestNumber(previewName: string): number | undefined {
  const match = /^pr(\d+)-/.exec(previewName);
  return match ? Number(match[1]) : undefined;
}

/**
 * The deployment admins seeded into the preview's ADMINS secret, from comma-separated
 * PREVIEW_ADMINS. These are Cloudflare Access identities — an email each, since that is what
 * {@link resolveAccess} makes the account name — so an entry that is not an email matches nobody.
 */
export function resolveAdmins(
  { list = process.env.PREVIEW_ADMINS }: { list?: string } = {},
): string[] {
  const admins = (list ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) {
    console.warn("PREVIEW_ADMINS is unset: the preview will have no deployment admins, so the " +
        "/admin panel will be unreachable.");
  }
  return admins;
}

/**
 * Strip ids, names and other account-specific config from a resource binding list, leaving only
 * the binding name — which is how Wrangler is told to provision a fresh resource.
 */
function previewResourceBindings(resources: unknown): BindingDecl[] | undefined {
  if (!Array.isArray(resources)) return undefined;
  const bindings = (resources as { binding?: unknown }[])
      .map((resource) => ({ binding: resource.binding }))
      .filter((resource): resource is BindingDecl => typeof resource.binding === "string");
  return bindings.length > 0 ? bindings : undefined;
}

// The resource lists a baseline is given fresh rather than inheriting from the deployment its
// config was written for. All four hold `{ binding }`-shaped entries, which is what lets one loop
// do all of them.
const BASELINE_RESOURCE_KEYS = [
  "kv_namespaces", "r2_buckets", "d1_databases", "worker_loaders",
] as const satisfies readonly (keyof StagingConfig)[];

/**
 * Do the same to the *baseline*, in place.
 *
 * The committed wrangler.jsonc files name resources for the deployment they were written for —
 * `bucket_name: "gadgets-blueprint-content"`, and KV entries carrying only a `preview_id`, which
 * is a local-dev Miniflare name rather than a namespace id. Passing those through would bind the
 * baseline to a bucket named for a different deployment, and would leave the KV bindings with no
 * id at all.
 *
 * A baseline exists here only so previews have something to branch from; nothing should ever
 * read its data. So it gets provisioned resources of its own, exactly as a preview does.
 */
function stripBaselineResources(config: StagingConfig): void {
  for (const key of BASELINE_RESOURCE_KEYS) {
    const stripped = previewResourceBindings(config[key]);
    if (stripped) config[key] = stripped;
  }
}

// Previews are throwaway, so invocation logs are worth their cost here even though production
// leaves them off.
function previewObservability(config: StagingConfig): ObservabilityConfig {
  return {
    ...config.observability,
    enabled: true,
    logs: { ...config.observability?.logs, invocation_logs: true },
  };
}

// How the backend calls gatekeepers: the GatekeeperVendor RPC entrypoint.
function backendGatekeeperServices(gatekeepers: string[], baseUrl: string): PreviewService[] {
  return gatekeepers.map((pkgName) => ({
    binding: gatekeeperBindingName(pkgName),
    service: pkgName,
    entrypoint: "GatekeeperVendor",
    // The Context gatekeeper namespaces each workshop's shared data by a "sharingDomain" carried
    // in its binding props (packages/gatekeeper-context/src/domain.ts). Using the preview's own
    // origin — as manifest-lib.ts does with $PUBLIC_BASE_URL — keeps each preview's collections
    // isolated from every other preview sharing the baseline gatekeeper.
    ...(pkgName === "gatekeeper-context" ? { props: { sharingDomain: baseUrl } } : {}),
  }));
}

// How the router calls gatekeepers: the default entrypoint, since it forwards whole HTTP
// requests rather than making vendor RPC calls.
function routerGatekeeperServices(gatekeepers: string[]): PreviewService[] {
  return gatekeepers.map((pkgName) => ({
    binding: gatekeeperBindingName(pkgName),
    service: pkgName,
  }));
}

function applyGatekeeper(
  pkgName: string,
  config: StagingConfig,
  { baseUrl }: PreviewContext,
): void {
  config.vars = {
    ...config.vars,
    // Every gatekeeper is mounted under the router's origin, exactly as manifest-lib.ts
    // templates it for real instances ($PUBLIC_BASE_URL/gatekeeper/<short>).
    BASE_URL: `${baseUrl}/gatekeeper/${gatekeeperShortName(pkgName)}`,
  };
  config.previews = {
    observability: previewObservability(config),
    vars: { ...config.vars },
    ...(config.unsafe ? { unsafe: config.unsafe } : {}),
    ...(config.artifacts ? { artifacts: config.artifacts } : {}),
    ...(config.ai ? { ai: config.ai } : {}),
    ...(config.browser ? { browser: config.browser } : {}),
  };

  // KV namespaces and R2 buckets are auto-provisioned per preview: each preview gets its own,
  // and `wrangler preview delete` collects them.
  const kvNamespaces = previewResourceBindings(config.kv_namespaces);
  if (kvNamespaces) config.previews.kv_namespaces = kvNamespaces;
  const r2Buckets = previewResourceBindings(config.r2_buckets);
  if (r2Buckets) config.previews.r2_buckets = r2Buckets;
}

function applyBackend(
  config: StagingConfig,
  { baseUrl, gatekeepers }: PreviewContext,
): void {
  // Injected rather than read from wrangler.jsonc, mirroring what manifest-lib.ts hardcodes for
  // every deployed backend (webFetch's toMarkdown conversion depends on it).
  config.ai = { binding: "WORKERS_AI" };
  config.services = backendGatekeeperServices(gatekeepers, baseUrl);
  // The origin is the only value the backend needs that is safe to write down here: ADMINS and the
  // Cloudflare Access pair are uploaded as *secrets* instead, out of band, because Wrangler prints
  // every plain-text var's value in its deploy summary and this workflow's logs are public. See
  // {@link backendSecrets} and preview.ts.
  config.vars = {
    ...config.vars,
    PUBLIC_BASE_URL: baseUrl,
  };
  config.previews = {
    observability: previewObservability(config),
    vars: { ...config.vars },
    ...(config.unsafe ? { unsafe: config.unsafe } : {}),
    // preview.ts patches each entry's preview_id once the gatekeeper previews exist.
    services: backendGatekeeperServices(gatekeepers, baseUrl),
    kv_namespaces: previewResourceBindings(config.kv_namespaces),
    r2_buckets: previewResourceBindings(config.r2_buckets),
    worker_loaders: previewResourceBindings(config.worker_loaders),
    ai: config.ai,
    ...(config.browser ? { browser: config.browser } : {}),
  };
}

function applyRouter(config: StagingConfig, { gatekeepers }: PreviewContext): void {
  // The one worker in the instance with a hostname: it is the origin, and everything else is
  // reached through it. See routerPreviewUrl.
  config.workers_dev = true;
  config.preview_urls = true;
  config.services = [
    { binding: "WORKSHOP_BACKEND", service: "workshop-backend" },
    ...routerGatekeeperServices(gatekeepers),
  ];
  config.previews = {
    observability: previewObservability(config),
    // Patched with preview_ids for the backend and every gatekeeper by preview.ts. Static
    // assets are not a `previews` key — the preview inherits the top-level `assets` stanza.
    services: structuredClone(config.services),
  };
}

/**
 * Build every package's preview config. Pure: `packages` is `[{ name, config }]` with `config`
 * the parsed wrangler.jsonc, and the result is a `Map` from package name to its preview config.
 */
export function buildPreviewConfigs({
  previewName,
  packages,
  accountId,
  workersDevHost,
}: {
  previewName: string;
  packages: readonly PackageConfig[];
  accountId: string;
  workersDevHost: string;
}): Map<string, StagingConfig> {
  if (!accountId || !workersDevHost) {
    throw new Error("buildPreviewConfigs needs both accountId and workersDevHost");
  }
  const baseUrl = routerPreviewUrl(previewName, workersDevHost);
  const gatekeepers = packages.map((pkg) => pkg.name).filter(isGatekeeper).toSorted();
  const context: PreviewContext = { baseUrl, gatekeepers };
  const configs = new Map<string, StagingConfig>();

  for (const pkg of packages) {
    const config: StagingConfig = structuredClone(pkg.config);
    if (config.name !== pkg.name) {
      // Checked before the rename below, not after: every URL and service binding here is
      // derived from the package directory name, so a worker whose own name diverges from it
      // would be silently misconfigured rather than merely renamed.
      throw new Error(`${pkg.name}/wrangler.jsonc declares worker name "${config.name}"; the ` +
          `preview generator requires them to match`);
    }

    // `preview_urls` defaults to `workers_dev` when unset, but both are stated so a preview's
    // reachability never depends on a default changing, or on what the dashboard was last
    // toggled to — a deploy overwrites the dashboard value either way. applyRouter turns them
    // back on for the one worker that needs them.
    Object.assign(config, {
      name: pkg.name,
      account_id: accountId,
      workers_dev: false,
      preview_urls: false,
    });
    // The account has no zone here, and a preview cannot be served from one regardless.
    delete config.routes;
    stripBaselineResources(config);

    if (isGatekeeper(pkg.name)) applyGatekeeper(pkg.name, config, context);
    else if (pkg.name === "workshop-backend") applyBackend(config, context);
    else if (pkg.name === "router") applyRouter(config, context);
    else throw new Error(`cannot build a preview config for package: ${pkg.name}`);

    configs.set(pkg.name, config);
  }

  assertBucketNamesFit(configs);
  return configs;
}

/**
 * Check {@link MAX_PREVIEW_NAME_LENGTH} against the workers and bindings that actually exist, so
 * a new worker with a longer name — or a longer binding on an existing one — fails here, naming
 * the number to lower, rather than at bucket creation halfway through a deploy.
 */
function assertBucketNamesFit(configs: Map<string, StagingConfig>): void {
  for (const [pkgName, config] of configs) {
    for (const { binding } of config.previews?.r2_buckets ?? []) {
      const suffix = binding.toLowerCase().replaceAll("_", "-");
      const length = `${config.name}-`.length + MAX_PREVIEW_NAME_LENGTH + `-${suffix}`.length;
      if (length <= R2_MAX_BUCKET_NAME_LENGTH) continue;
      throw new Error(`${pkgName}'s ${binding} bucket would be ${length} characters for a ` +
          `${MAX_PREVIEW_NAME_LENGTH}-character preview name, over R2's ` +
          `${R2_MAX_BUCKET_NAME_LENGTH}; lower MAX_PREVIEW_NAME_LENGTH to ` +
          `${MAX_PREVIEW_NAME_LENGTH - (length - R2_MAX_BUCKET_NAME_LENGTH)}`);
    }
  }
}

/**
 * The Cloudflare account previews deploy to, and its workers.dev subdomain.
 *
 * Neither has a default: this repository is public, so which account it deploys to is deployment
 * configuration rather than something to hardcode here, and a wrong-but-plausible default would
 * deploy somewhere unintended instead of failing. They are resolved together because every
 * gatekeeper's BASE_URL is derived from the host — setting one without the other would bake one
 * account's hostnames into another account's workers.
 *
 * The environment is read in the parameter defaults rather than the body so that
 * env-passthrough.test.ts, whose discovery is textual, can see both names.
 */
export function resolveTarget({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  workersDevHost = process.env.PREVIEW_WORKERS_DEV_HOST,
}: { accountId?: string; workersDevHost?: string } = {}): {
  accountId: string;
  workersDevHost: string;
} {
  if (!accountId || !workersDevHost) {
    const missing = [
      ...(accountId ? [] : ["CLOUDFLARE_ACCOUNT_ID"]),
      ...(workersDevHost ? [] : ["PREVIEW_WORKERS_DEV_HOST"]),
    ];
    throw new Error(`${missing.join(" and ")} must be set: together they name the Cloudflare ` +
        "account previews deploy to, and this repository deliberately hardcodes no default");
  }
  return { accountId, workersDevHost };
}

/** The Cloudflare Access application that authenticates a preview. */
export interface AccessConfig {
  /** The application's audience tag, matched as the JWT's `aud`. */
  aud: string;
  /** Team domain that issued the JWT, e.g. `https://<team>.cloudflareaccess.com`. */
  iss: string;
}

/**
 * The Cloudflare Access application a preview sits behind.
 *
 * Required, like {@link resolveTarget}'s pair and for the same reasons. A preview is a public
 * workers.dev URL holding real gatekeeper capabilities, and an unset pair does not fail — the
 * backend can verify no assertion (access.ts) and quietly falls back to password signup — so this
 * fails closed rather than deploying an instance whose auth silently differs. The two move together
 * because verifying an assertion needs both, and either one alone verifies nothing.
 *
 * The environment is read in the parameter defaults rather than the body so that
 * env-passthrough.test.js, whose discovery is textual, can see both names.
 */
export function resolveAccess({
  aud = process.env.CF_ACCESS_AUD,
  iss = process.env.CF_ACCESS_ISS,
}: { aud?: string; iss?: string } = {}): AccessConfig {
  if (!aud || !iss) {
    const missing = [
      ...(aud ? [] : ["CF_ACCESS_AUD"]),
      ...(iss ? [] : ["CF_ACCESS_ISS"]),
    ];
    throw new Error(`${missing.join(" and ")} must be set: together they name the Cloudflare ` +
        "Access application that authenticates a preview, and a preview deployed without it " +
        "would fall back to password signup on a public URL");
  }
  return { aud, iss };
}

/**
 * The AI Gateway configuration, or nothing.
 *
 * Optional as a group, unlike {@link resolveAccess}: with CF_AI_GATEWAY unset a preview is BYOK,
 * exactly like a deployment that never configured a gateway, and the agent still works. Set, it
 * routes inference through Cloudflare AI Gateway with server-managed keys — and then the gateway
 * account is required, because `AiGatewayConfig` (ai-gateway.ts) throws without it. That throw
 * would otherwise land in a chat rather than in this deploy.
 *
 * The Run + Read token is not required with it. Every preview backend binds Workers AI (see
 * {@link applyBackend}), and the binding is the gateway transport whenever it is present: those
 * requests are pre-authenticated in-account, so neither inference nor a cost-log read needs a
 * token. Two configurations still do, and each is the deploy-time mirror of a constructor throw:
 * CF_AI_GATEWAY_USE_BINDING=false, which marks the gateway as living in a *different* account and
 * so forces the HTTPS transport, and the google provider, whose pi adapter refuses the binding's
 * fetch.
 *
 * The environment is read in the parameter defaults rather than the body so that
 * env-passthrough.test.js, whose discovery is textual, can see every name.
 */
export function resolveAiGateway({
  gateway = process.env.CF_AI_GATEWAY,
  accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID,
  apiToken = process.env.CF_AI_GATEWAY_API_TOKEN,
  providers = process.env.CF_AI_GATEWAY_PROVIDERS,
  useBinding: rawUseBinding = process.env.CF_AI_GATEWAY_USE_BINDING,
}: {
  gateway?: string;
  accountId?: string;
  apiToken?: string;
  providers?: string;
  useBinding?: string;
} = {}): Record<string, string> {
  // Normalized here rather than in the parameter default, which only runs when the caller omits
  // the value -- an explicitly passed " FALSE " would skip it and fail validation below.
  const useBinding = rawUseBinding?.trim().toLowerCase();
  const rest = { CF_AI_GATEWAY_ACCOUNT_ID: accountId, CF_AI_GATEWAY_API_TOKEN: apiToken,
    CF_AI_GATEWAY_PROVIDERS: providers, CF_AI_GATEWAY_USE_BINDING: useBinding };
  if (!gateway) {
    // Every one of these does nothing without a gateway name, so a set of them without it is a
    // half-finished configuration rather than a deliberate BYOK preview.
    const orphans = Object.entries(rest).filter(([, value]) => value).map(([name]) => name);
    if (orphans.length > 0) {
      console.warn(`CF_AI_GATEWAY is unset, so ${orphans.join(", ")} will be ignored: the preview ` +
          "will ask each user for their own model API keys.");
    }
    return {};
  }
  if (!accountId) {
    throw new Error("CF_AI_GATEWAY_ACCOUNT_ID must be set when CF_AI_GATEWAY is: the backend " +
        "cannot discover its own account, and refuses to start a chat without it");
  }
  if (useBinding !== undefined && useBinding !== "true" && useBinding !== "false") {
    // The backend compares against those two strings and treats anything else as unset, which for
    // an intended "false" is the opposite of what was asked for -- silently, and in a preview
    // nobody is reading the logs of.
    throw new Error(`CF_AI_GATEWAY_USE_BINDING must be "true" or "false", not ` +
        `"${rawUseBinding}": the backend reads any other value as unset.`);
  }
  // The two AiGatewayConfig throws the Workers AI binding does not cover. Raised here so a
  // half-configured preview fails its deploy rather than its first chat.
  if (!apiToken && useBinding === "false") {
    throw new Error("CF_AI_GATEWAY_API_TOKEN must be set when CF_AI_GATEWAY_USE_BINDING is " +
        "false: opting out of the binding leaves the HTTPS transport, which needs a Run + Read " +
        "token. Drop the opt-out unless the gateway is in another account.");
  }
  if (!apiToken && providers?.split(",").some(p => p.trim() === "google")) {
    throw new Error("CF_AI_GATEWAY_API_TOKEN must be set when the google provider is enabled: " +
        "pi's Google adapter refuses a custom fetch, so Google inference cannot ride the Workers " +
        "AI binding.");
  }
  return {
    CF_AI_GATEWAY: gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: accountId,
    // Each of the three is optional on its own: no token rides the binding transport, no providers
    // means the gateway offers no server-keyed model, and no USE_BINDING takes the binding
    // whenever it is bound -- which, for a preview, is always.
    ...(apiToken ? { CF_AI_GATEWAY_API_TOKEN: apiToken } : {}),
    ...(providers ? { CF_AI_GATEWAY_PROVIDERS: providers } : {}),
    ...(useBinding ? { CF_AI_GATEWAY_USE_BINDING: useBinding } : {}),
  };
}

/**
 * The backend's secrets, keyed by the variable name it reads them as.
 *
 * These are deliberately *not* part of any generated config. Wrangler prints the value of every
 * plain-text var in its deploy summary (truncated to about forty characters) and every
 * `unsafe.bindings` entry verbatim in its configuration warning, and the preview workflow's logs
 * are public — so a maintainer's email, the audience tag and the team domain would all end up
 * there. GitHub's secret masking does not save them either: it replaces exact occurrences of a
 * registered secret, and what reaches the log is a reformatted, truncated slice of one. preview.ts
 * uploads these over stdin instead, with `wrangler preview secret bulk`, which prints names and
 * `********`.
 *
 * Setting the Access pair is also what closes the password path — the backend's `login()` and
 * `createAccount()` both throw once CF_ACCESS_AUD is set — so DISABLE_PASSWORD_AUTH is not needed.
 */
export function backendSecrets({
  admins = resolveAdmins(),
  access = resolveAccess(),
  aiGateway = resolveAiGateway(),
}: {
  admins?: string[];
  access?: AccessConfig;
  aiGateway?: Record<string, string>;
} = {}): Record<string, string> {
  return {
    // A secret is always text, so the array goes over as JSON. `#isAdmin()` already accepts that
    // form: ".env doesn't actually let you specify JSON bindings, so we also support a string that
    // parses as JSON array".
    ADMINS: JSON.stringify(admins),
    CF_ACCESS_AUD: access.aud,
    CF_ACCESS_ISS: access.iss,
    // The gateway name and its account are not secret in the way the token is, but they travel the
    // same way rather than as vars: one mechanism, and nothing about the deployment in the log.
    ...aiGateway,
  };
}

/** Read every deployable package's wrangler.jsonc off disk. */
export function readPackages(): DeployablePackage[] {
  return findDeployablePackages(PACKAGES_DIR)
      .map(({ name, dir }) => ({ name, dir, config: readWranglerConfig(dir) }));
}

/** Write one package's generated preview config to its `wrangler.staging.jsonc`. */
export function writePreviewConfig(pkgDir: string, config: StagingConfig): void {
  writeFileSync(join(pkgDir, STAGING_CONFIG_NAME), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Generate and write every package's preview config. Returns what the deploy/delete commands
 * need: the resolved preview name, the origin, and the packages in no particular order.
 */
export function generatePreviewConfigs(options: {
  previewName?: string;
} = {}): {
  previewName: string;
  workersDevHost: string;
  baseUrl: string;
  packages: DeployablePackage[];
} {
  const previewName = options.previewName ?? resolvePreviewName();
  const { accountId, workersDevHost } = resolveTarget();
  const packages = readPackages();
  const configs = buildPreviewConfigs({
    previewName,
    packages,
    accountId,
    workersDevHost,
  });

  for (const pkg of packages) {
    const config = configs.get(pkg.name);
    if (!config) throw new Error(`no preview config was generated for ${pkg.name}`);
    writePreviewConfig(pkg.dir, config);
    console.log(`generated: ${join(pkg.dir, STAGING_CONFIG_NAME)}`);
  }
  console.log(`\nDone. ${packages.length} file(s) generated for preview "${previewName}".`);

  return {
    previewName,
    workersDevHost,
    baseUrl: routerPreviewUrl(previewName, workersDevHost),
    packages,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generatePreviewConfigs();
}
