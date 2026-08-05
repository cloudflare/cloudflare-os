import type * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";

/** A deployed `Cloudflare.Worker` resource. */
type Worker = Effect.Success<ReturnType<typeof Cloudflare.Worker>>;

/**
 * A configuration value that may be a secret. Deploy tooling passes secrets
 * through opaquely — the `object` arm admits wrapper types like effect's
 * `Redacted`/`Config` or alchemy `Output` references. Plain strings listed
 * in {@link PackagedGatekeeper.secrets} are encrypted at deploy time.
 */
export type SecretInput = string | object;

/**
 * An environment value on the gatekeeper Worker: a plain var, a JSON var,
 * or an opaque wrapper (secret, config reference, output reference).
 */
export type EnvInput = string | number | boolean | readonly string[] | object;

/**
 * Substituted in {@link GatekeeperDeployment.vendorProps} values with the
 * deployment's public origin (e.g. `https://os.acme.com`).
 */
export const PUBLIC_BASE_URL = "{PUBLIC_BASE_URL}";

/** Fields shared by every gatekeeper deployment variant. */
export interface GatekeeperDeploymentBase {
  /**
   * The gatekeeper's short name, e.g. `"confluence"`. Determines the
   * `GATEKEEPER_<NAME>` service-binding name (uppercased, `-` → `_`) both
   * runtimes discover by prefix scan, and the `/gatekeeper/<name>` route on
   * the router.
   */
  name: string;
  /**
   * Properties for the backend's vendor service binding (workerd
   * `ctx.props`). String values containing {@link PUBLIC_BASE_URL} have the
   * placeholder substituted with the deployment's public origin.
   */
  vendorProps?: Record<string, string>;
  /**
   * Deploy this gatekeeper even when the OS configuration doesn't list it
   * (the ambient core: context, scheduler, mcp).
   */
  defaultEnabled?: boolean;
  /**
   * Set `false` to opt a {@link defaultEnabled} gatekeeper out of a
   * deployment (e.g. `Mcp({ enabled: false })`).
   */
  enabled?: boolean;
}

/**
 * A gatekeeper built from a package following the standard layout: a
 * capnweb Worker whose sources are re-emitted by `capnweb-validate build`,
 * with an optional package.json pre-build script.
 *
 * The package's own `wrangler.jsonc` is the source of truth for how the
 * worker deploys — the entry module, compatibility date and flags, Durable
 * Object migrations, KV bindings, and vars are all **derived from it at
 * deploy time**, never copied here. A manifest only adds what wrangler
 * doesn't know: the pre-build script, configuration-driven env/secrets, and
 * OS wiring (vendor props, default enablement).
 */
export interface PackagedGatekeeper extends GatekeeperDeploymentBase {
  /**
   * The npm package containing the Worker's source and its
   * `wrangler.jsonc`. Deploy tooling resolves it to locate sources, derive
   * the deploy config, and run builds.
   */
  package: string;
  /**
   * package.json script run before the standard `capnweb-validate` build
   * (e.g. `"build:configurator"`, `"build:app"`). Today these scripts are
   * absent from wrangler's `build.command`, so the manifest must name them.
   * Omitted → no pre-build.
   */
  prebuild?: string;
  /**
   * Configuration-driven environment for the Worker — merged over the vars
   * derived from `wrangler.jsonc`. The composite adds `BASE_URL`
   * (`<public origin>/gatekeeper/<name>`) itself — do not include it here.
   */
  env?: Record<string, EnvInput>;
  /**
   * Names of {@link env} keys whose values are secrets. Plain-string values
   * under these keys are encrypted (`secret_text`) at deploy time; wrapper
   * values (`Redacted`, config references) are secret regardless.
   */
  secrets?: readonly string[];
}

/**
 * A gatekeeper backed by a Worker the caller declares — the Effect-native
 * path. Any alchemy Worker works: an Effect-native `Cloudflare.Worker`
 * class, a plain `Cloudflare.Worker(id, { main })` declaration, or an
 * already-yielded Worker resource. The Worker owns its own build, bindings,
 * Durable Objects, and env; the composite only wires it into the OS
 * (`GATEKEEPER_<NAME>` service bindings on router + backend, the `BASE_URL`
 * var, vendor `ctx.props`).
 *
 * @example An Effect-native gatekeeper
 * ```typescript
 * class Jira extends Cloudflare.Worker<Jira>()(
 *   "Jira",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // resolve bindings, return { fetch, GatekeeperVendor entrypoint, ... }
 *   }),
 * ) {}
 *
 * gatekeepers: [Gatekeeper({ name: "jira", worker: Jira })]
 * ```
 */
export interface WorkerGatekeeper extends GatekeeperDeploymentBase {
  /**
   * The Worker implementing the gatekeeper contract (a `GatekeeperVendor`
   * entrypoint plus the standard HTTP surface). Accepts a Worker resource
   * or any Effect yielding one — including `Cloudflare.Worker` classes.
   */
  worker: Worker | Effect.Effect<Worker, never, any>;
}

/**
 * Everything the {@link OperatingSystem} composite needs to deploy one
 * gatekeeper as its own Worker and wire it into the OS instance — either a
 * {@link PackagedGatekeeper} (standard capnweb package layout) or a
 * {@link WorkerGatekeeper} (any alchemy Worker).
 */
export type GatekeeperDeployment = PackagedGatekeeper | WorkerGatekeeper;

/** Does this deployment bring its own Worker declaration? */
export const isWorkerGatekeeper = (
  manifest: GatekeeperDeployment,
): manifest is WorkerGatekeeper => "worker" in manifest;

/**
 * Identity constructor for a {@link GatekeeperDeployment} — purely for
 * discoverability and inference at call sites:
 *
 * ```typescript
 * gatekeepers: [Gatekeeper({ name: "jira", worker: Jira })]
 * ```
 */
export const Gatekeeper = <const M extends GatekeeperDeployment>(
  manifest: M,
): M => manifest;
