import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import type { Input, InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Redacted from "effect/Redacted";
import {
  isWorkerGatekeeper,
  PUBLIC_BASE_URL,
  type GatekeeperDeployment,
} from "./Gatekeeper.ts";
import { Context } from "./gatekeepers/context.ts";
import { Mcp } from "./gatekeepers/mcp.ts";
import { Scheduler } from "./gatekeepers/scheduler.ts";
import { ownScript, packageDir } from "./paths.ts";
import { readWranglerConfig } from "./wrangler.ts";

/** The `Cloudflare.AI.Gateway` resource (derived — no deep import). */
type AIGateway = Effect.Success<ReturnType<typeof Cloudflare.AI.Gateway>>;
/** The props accepted by `Cloudflare.AI.Gateway`, passed through verbatim. */
type GatewayProps = Parameters<typeof Cloudflare.AI.Gateway>[1];
/** A deployed `Cloudflare.Worker` resource. */
type Worker = Effect.Success<ReturnType<typeof Cloudflare.Worker>>;
/** A deployed `Cloudflare.KV.Namespace` resource. */
type KvNamespace = Effect.Success<
  ReturnType<typeof Cloudflare.KV.Namespace>
>;
/** A deployed `Cloudflare.R2.Bucket` resource. */
type R2Bucket = Effect.Success<ReturnType<typeof Cloudflare.R2.Bucket>>;
/** The `env` prop shape of `Cloudflare.Worker`. */
type WorkerEnv = Cloudflare.WorkerBindingProps;

/** Compatibility date shared by every worker in the fleet. */
export const COMPATIBILITY_DATE = "2026-02-02";

/** The `GATEKEEPER_<SUFFIX>` binding name both runtimes discover by prefix. */
export const gatekeeperBindingName = (name: string): string =>
  `GATEKEEPER_${name.toUpperCase().replaceAll("-", "_")}`;

/**
 * The gatekeepers deployed even when the `gatekeepers` prop doesn't list
 * them — the ambient core (context library, scheduled tasks, MCP). Opt out
 * by listing the gatekeeper with `enabled: false`, e.g.
 * `Mcp({ enabled: false })`.
 */
const defaultGatekeepers = (): GatekeeperDeployment[] => [
  Context(),
  Scheduler(),
  Mcp(),
];

/** Sign-in configuration. Deliberately env-only — never admin-editable. */
export interface AuthProps {
  /**
   * Vendor ids allowed as sign-in methods (`AUTH_GATEKEEPERS`), e.g.
   * `["cloudflare", "google", "github"]`. Each listed gatekeeper must be
   * deployed with OAuth credentials.
   */
  gatekeepers?: string[];
  /**
   * Turn off username/password auth. Only honored when {@link gatekeepers}
   * is non-empty.
   */
  disablePasswordAuth?: boolean;
  /** Cloudflare Access SSO validation (`CF_ACCESS_AUD` / `CF_ACCESS_ISS`). */
  access?: {
    /** The Access application's audience tag (`CF_ACCESS_AUD`). */
    aud: string;
    /** The Access team's issuer URL (`CF_ACCESS_ISS`). */
    iss: string;
  };
}

/**
 * AI Gateway mode. The presence of this prop is the opt-in: the composite
 * PROVISIONS the gateway, its Run+Read access token, and (when
 * {@link AIProps.providers} is set) a Secrets-Store-backed stored key per
 * provider. Omit the prop entirely for BYOK mode (per-user provider keys).
 */
export interface AIProps {
  /**
   * Gateway configuration ({@link GatewayProps}, passed through verbatim) or
   * an existing `Cloudflare.AI.Gateway` resource from elsewhere in the
   * stack. Omitted → a gateway is provisioned with defaults.
   */
  gateway?: GatewayProps | AIGateway;
  /**
   * Provider credentials, keyed by provider slug (`anthropic`, `openai`,
   * `google`, ...). Each entry is stored in the account Secrets Store and
   * attached to the gateway as its default key for that provider — never
   * bound into any Worker. The keys of this record become
   * `CF_AI_GATEWAY_PROVIDERS` (the model menu the backend offers).
   */
  providers?: Record<string, Redacted.Redacted<string>>;
  /**
   * Workers AI routing: `true` routes Workers AI through the gateway
   * (default), `"direct"` calls the Workers AI REST endpoint directly
   * (`CF_AI_GATEWAY_WAI_DIRECT`), a string names a different gateway id
   * (`CF_AI_GATEWAY_WAI`).
   */
  workersAi?: boolean | "direct" | (string & {});
  /**
   * App-level per-user quotas enforced by the backend's billing flow —
   * distinct from the gateway's own `rateLimiting*`/`spendLimits` props.
   */
  limits?: {
    /** Enable the Cloudflare free-tier/top-up billing flow. */
    enableCloudflareLimits?: boolean;
    /** Max free-tier LLM calls per user per day (`DAILY_LLM_CALL_LIMIT`). */
    dailyLlmCallLimit?: number;
    /** Min connected-account balance in USD (`MINIMUM_CLOUDFLARE_BALANCE`). */
    minimumCloudflareBalance?: number;
  };
}

/**
 * An extra service binding on the backend Worker pointing at a Worker the
 * caller's stack owns (e.g. the starter repo's private error reporter).
 */
export interface BackendServiceBinding {
  /** The binding name on the backend's env (e.g. `ERROR_REPORTER`). */
  binding: string;
  /** The target Worker resource, deployed by the caller's stack. */
  worker: Worker;
  /** Named entrypoint on the target Worker. Omitted → default entrypoint. */
  entrypoint?: string;
  /**
   * Properties exposed to the target via workerd's `ctx.props`. String
   * values containing `{PUBLIC_BASE_URL}` have the placeholder substituted
   * with the deployment's public origin.
   */
  props?: Record<string, string>;
}

/** Caller extensions to the workshop-backend Worker. */
export interface BackendProps {
  /**
   * Extra env for the backend Worker — vars, secrets, resources, bindings —
   * merged over the composite's own entries.
   */
  env?: Record<string, unknown>;
  /** Extra service bindings — see {@link BackendServiceBinding}. */
  services?: BackendServiceBinding[];
}

/** Caller extensions to the frontend build. */
export interface FrontendProps {
  /**
   * Extra build-time environment for the vite build (e.g.
   * `VITE_FRONTEND_ERROR_REPORTING: "true"`), merged over the composite's
   * own entries.
   */
  env?: Record<string, string>;
}

export interface OperatingSystemProps {
  /**
   * The OS's public origin hostname (e.g. `os.acme.com`), attached to the
   * router as a custom domain. Omitted → the router's `workers.dev` URL is
   * the public origin.
   */
  domain?: string;
  /**
   * Identities granted the admin role (`ADMINS`), gating `/admin`
   * (branding, connector policies). The values are usernames in whatever
   * sign-in system the deployment uses: local account usernames under
   * password auth, the OAuth-verified email under gatekeeper sign-in
   * (`auth.gatekeepers`), or the Access-JWT email under Cloudflare Access
   * (`auth.access`).
   */
  admins?: string[];
  /** Sign-in configuration — see {@link AuthProps}. */
  auth?: AuthProps;
  /**
   * Gatekeepers to deploy, as manifests from each gatekeeper package's
   * `deploy` module — e.g. `GitHub({ clientId, clientSecret })` from
   * `@gadgets/github-gatekeeper/deploy`. The ambient core (context,
   * scheduler, mcp) deploys by default; opt out with
   * `Mcp({ enabled: false })`. An entry with the same name as a default
   * replaces it. Custom gatekeepers are any package exporting a
   * `GatekeeperDeployment`.
   */
  gatekeepers?: GatekeeperDeployment[];
  /**
   * AI Gateway mode — see {@link AIProps}. Presence is the opt-in; omit for
   * BYOK (per-user provider keys).
   */
  ai?: AIProps;
  /** Caller extensions to the backend Worker — see {@link BackendProps}. */
  backend?: BackendProps;
  /** Caller extensions to the frontend build — see {@link FrontendProps}. */
  frontend?: FrontendProps;
}

const OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, invocationLogs: false },
};

const TEXT_RULES = [{ globs: ["**/*.txt", "**/*.svg.txt", "**/*.svg"] }];

/** Memo scope shared by every worker build: sources + cross-package deps. */
const SHARED_MEMO_INCLUDE = [
  "src/**",
  "package.json",
  "*.mjs",
  "../backend-utils/src/**",
  "../workshop-shared/src/**",
  "../configurator-ui/src/**",
  "../mcp-shared/src/**",
  "../../scripts/build-gatekeeper-configurator.mjs",
];

/** Wrap plain-string secrets so they deploy as `secret_text`, not vars. */
const asSecret = (value: unknown): unknown =>
  typeof value === "string" ? Redacted.make(value) : value;

/** Substitute `{PUBLIC_BASE_URL}` in a manifest string with the origin. */
const substituteBaseUrl = (
  template: string,
  baseUrl: Input<string>,
): Input<string> => {
  if (!template.includes(PUBLIC_BASE_URL)) return template;
  if (typeof baseUrl === "string") {
    return template.replaceAll(PUBLIC_BASE_URL, baseUrl);
  }
  return Output.map(baseUrl as Output.Output<string>, (url) =>
    template.replaceAll(PUBLIC_BASE_URL, url),
  );
};

const appendPath = (base: Input<string>, path: string): Input<string> =>
  typeof base === "string"
    ? `${base}${path}`
    : Output.map(base as Output.Output<string>, (u) => `${u}${path}`);

const pascal = (name: string): string =>
  name
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * Merge user-supplied gatekeeper manifests over the default-enabled core.
 * A user entry replaces a default with the same name; `enabled: false`
 * entries are dropped.
 */
const resolveGatekeepers = (
  manifests: GatekeeperDeployment[] | undefined,
): GatekeeperDeployment[] => {
  const byName = new Map<string, GatekeeperDeployment>();
  for (const manifest of defaultGatekeepers()) {
    byName.set(manifest.name, manifest);
  }
  for (const manifest of manifests ?? []) {
    byName.set(manifest.name, manifest);
  }
  return [...byName.values()].filter((m) => m.enabled !== false);
};

/** Build + deploy one gatekeeper worker (namespaced `Gatekeepers/<Name>/`). */
const makeGatekeeperWorker = (
  manifest: GatekeeperDeployment,
  sharedDepsHash: Input<string>,
) =>
  Effect.gen(function* () {
    if (isWorkerGatekeeper(manifest)) {
      // The Effect-native path: the caller's Worker declaration owns its
      // build, bindings, DOs, and env — we only wire it into the OS.
      return Effect.isEffect(manifest.worker)
        ? yield* manifest.worker
        : manifest.worker;
    }

    const dir = packageDir(manifest.package);
    // The package's wrangler.jsonc is the source of truth: entry module,
    // compat date/flags, DO migrations, KV bindings, and vars all derive
    // from it, so upstream changes are picked up without touching manifests.
    const wrangler = yield* readWranglerConfig(dir);
    const prepareTree = `node ${JSON.stringify(ownScript("prepare-worker-tree.mjs"))} .wrangler/validate/src`;
    const prebuild = manifest.prebuild ? `pnpm run ${manifest.prebuild} && ` : "";

    const build = yield* Command.Build("Build", {
      command: `${prebuild}pnpm exec capnweb-validate build --out .wrangler/validate && ${prepareTree}`,
      cwd: dir,
      // `&&` chains need a real shell — without it the chain is parsed into
      // argv and `&&` reaches the first program as a literal argument.
      shell: true,
      outdir: ".wrangler/validate",
      // Sequences the shared workspace-dep build (typed-storage's `dist/`)
      // before this one; also folds it into the memo hash.
      env: { SHARED_DEPS_HASH: sharedDepsHash },
      memo: { include: SHARED_MEMO_INCLUDE, lockfile: true },
    });

    const env: Record<string, unknown> = {
      ...wrangler.vars,
      // Sequences the build before the Worker's bundle (the Worker depends
      // on the build through this Output). `main` itself must stay a plain
      // string — the engine's precreate stub needs it before dependencies
      // resolve.
      BUILD_HASH: Output.map(build.hash.output, (hash) => hash ?? ""),
    };
    const secretKeys = new Set(manifest.secrets ?? []);
    for (const [key, value] of Object.entries(manifest.env ?? {})) {
      env[key] = secretKeys.has(key) ? asSecret(value) : value;
    }
    for (const className of wrangler.durableObjects) {
      env[className] = Cloudflare.DurableObject(className);
    }
    for (const binding of wrangler.kvNamespaces) {
      env[binding] = yield* Cloudflare.KV.Namespace(pascal(binding.toLowerCase()));
    }

    // The worker's logical id is the gatekeeper name (not a generic
    // "Worker"): template-form `bind` sids derive from it, so a shared id
    // would collapse every backend→gatekeeper vendor bind into one.
    const worker = yield* Cloudflare.Worker(pascal(manifest.name), {
      // wrangler's `main` already points into the capnweb-validate output;
      // the BUILD_HASH env entry above sequences the build before bundling.
      main: wrangler.main,
      compatibility: {
        date: wrangler.compatibilityDate ?? COMPATIBILITY_DATE,
        flags: wrangler.compatibilityFlags,
      },
      rules: TEXT_RULES,
      observability: OBSERVABILITY,
      env: env as WorkerEnv,
    });

    return worker;
  }).pipe(
    Namespace.push(pascal(manifest.name)),
    Namespace.push("Gatekeepers"),
  );

/**
 * The deployed Cloudflare OS — the public origin plus the Workers, storage,
 * and optional AI Gateway the composite provisioned.
 */
export type OperatingSystem = {
  /** The OS's public origin. */
  url: Worker["url"];
  /** The public router Worker (static assets + custom domain). */
  router: Worker;
  /** The workshop-backend Worker (the kernel). */
  backend: Worker;
  /** Gatekeeper Workers keyed by short name (e.g. `"github"`). */
  gatekeepers: Record<string, Worker>;
  /** Blueprint metadata KV namespace. */
  blueprints: KvNamespace;
  /** Avatar KV namespace. */
  avatars: KvNamespace;
  /** Blueprint content R2 bucket. */
  blueprintContent: R2Bucket;
  /**
   * The AI Gateway, when {@link OperatingSystemProps.ai} opted into gateway
   * mode; otherwise `undefined` (BYOK).
   */
  gateway: AIGateway | undefined;
};

/**
 * Cloudflare OS as a single alchemy resource: provisions the storage (KV,
 * R2), every enabled gatekeeper worker, the workshop backend (browser
 * rendering, dynamic worker loader, Workers AI, Durable Objects), the
 * frontend build, the public router (static assets + custom domain), and —
 * in gateway mode — the AI Gateway with its access token and stored
 * provider keys.
 *
 * @example
 * ```typescript
 * import GitHub from "@gadgets/github-gatekeeper/deploy";
 * import Mcp from "@gadgets/mcp-gatekeeper/deploy";
 *
 * const os = yield* OperatingSystem("OS", {
 *   domain: "os.acme.com",
 *   admins: ["sam"],
 *   auth: { gatekeepers: ["github"], disablePasswordAuth: true },
 *   gatekeepers: [
 *     GitHub({
 *       clientId: Config.string("GITHUB_CLIENT_ID"),
 *       clientSecret: Config.redacted("GITHUB_CLIENT_SECRET"),
 *     }),
 *     Mcp({ enabled: false }), // opt out of a default
 *   ],
 *   ai: { providers: { anthropic: Config.redacted("ANTHROPIC_API_KEY") } },
 * });
 * return { url: os.url };
 * ```
 */
export const OperatingSystem = (
  id: string,
  // `domain`, `auth`, `gatekeepers`, `ai`, `backend`, and `frontend`
  // determine the shape of the resource graph, so they are static; every
  // other prop accepts Inputs.
  props: InputProps<
    OperatingSystemProps,
    "domain" | "auth" | "gatekeepers" | "ai" | "backend" | "frontend"
  > = {},
): Effect.Effect<OperatingSystem, never, Cloudflare.Providers> =>
  Effect.gen(function* () {
    const gatekeeperSet = resolveGatekeepers(props.gatekeepers);

    // ── Storage ────────────────────────────────────────────────────────
    const blueprints = yield* Cloudflare.KV.Namespace("Blueprints");
    const avatars = yield* Cloudflare.KV.Namespace("Avatars");
    const blueprintContent = yield* Cloudflare.R2.Bucket("BlueprintContent");

    // ── Frontend build (served by the router as static assets) ─────────
    const frontendDir = packageDir("@gadgets/workshop-frontend");
    const frontend = yield* Command.Build("Frontend", {
      command: "pnpm run build",
      cwd: frontendDir,
      outdir: "dist",
      env: { VITE_CF_ACCESS_MODE: "true", ...props.frontend?.env },
      memo: {
        include: [
          "src/**",
          "public/**",
          "index.html",
          "package.json",
          "vite.config.ts",
          "tsconfig*.json",
          "../workshop-shared/src/**",
          "../configurator-ui/src/**",
          "../error-reporting/src/**",
        ],
        lockfile: true,
      },
    });

    // ── AI gateway mode (presence of `ai` is the opt-in) ───────────────
    const ai = props.ai ? yield* makeAI(props.ai) : undefined;

    // ── Shared workspace deps that resolve through built output ────────
    // `@gadgets/typed-storage` is the one workspace package whose exports
    // point at `dist/` (everything else exports `src/`); build it once so
    // the backend and gatekeeper bundles can resolve it — rolldown would
    // otherwise silently externalize the import and the script fails
    // startup validation with `No such module`.
    const sharedDeps = yield* Command.Build("SharedDeps", {
      command: "pnpm run build",
      cwd: packageDir("@gadgets/typed-storage"),
      outdir: "dist",
      memo: { include: ["src/**", "package.json", "tsconfig.json"], lockfile: true },
    });
    const sharedDepsHash = Output.map(
      sharedDeps.hash.output,
      (hash) => hash ?? "",
    );

    // ── Gatekeeper workers ─────────────────────────────────────────────
    const gatekeepers: Record<string, Worker> = {};
    for (const manifest of gatekeeperSet) {
      gatekeepers[manifest.name] = yield* makeGatekeeperWorker(
        manifest,
        sharedDepsHash,
      );
    }

    // ── Router (the public origin) ─────────────────────────────────────
    // Created BEFORE the backend so its `url` can flow into the backend's
    // env as a plain Input (custom domain, or the workers.dev URL the
    // engine resolves from the precreate stub). The router's own service
    // bindings reference the backend, so they are attached post-hoc via
    // `bind` — bindings exist precisely to close that cycle.
    // Entry, compat date, and the assets routing config (SPA fallback +
    // the contract-tested run_worker_first list) derive from the router
    // package's wrangler.jsonc.
    const routerDir = packageDir("@gadgets/router");
    const routerWrangler = yield* readWranglerConfig(routerDir);
    const router = yield* Cloudflare.Worker("Router", {
      main: routerWrangler.main,
      compatibility: {
        date: routerWrangler.compatibilityDate ?? COMPATIBILITY_DATE,
        flags: routerWrangler.compatibilityFlags,
      },
      observability: OBSERVABILITY,
      domain: props.domain,
      // `cast` (effect/Function's typed identity) mirrors StaticSite.ts:
      // the `assets` union doesn't distribute Input<> over its members, so
      // Output-valued `directory`/`hash` fail structural matching without it.
      assets: cast({
        directory: frontend.outdir,
        hash: Output.map(frontend.hash.output, (hash) => hash ?? ""),
        notFoundHandling: routerWrangler.assets?.notFoundHandling,
        runWorkerFirst: routerWrangler.assets?.runWorkerFirst,
      }),
    });

    /** The OS's public origin: the custom domain, or the router's URL. */
    const publicBaseUrl: Input<string> =
      typeof props.domain === "string"
        ? `https://${props.domain}`
        : Output.map(
            router.url as Output.Output<string | undefined>,
            (url) => url ?? "",
          );

    /** Substitute `{PUBLIC_BASE_URL}` across a props record. */
    const substituteProps = (
      record: Record<string, string>,
    ): Record<string, Input<string>> =>
      Object.fromEntries(
        Object.entries(record).map(([key, template]) => [
          key,
          substituteBaseUrl(template, publicBaseUrl),
        ]),
      );

    // ── Workshop backend (the kernel) ──────────────────────────────────
    const backendDir = packageDir("@gadgets/workshop-backend");
    // Entry, compat date/flags, and DO migrations derive from the
    // package's wrangler.jsonc — the checked-in deploy contract.
    const backendWrangler = yield* readWranglerConfig(backendDir);
    const prepareTree = `node ${JSON.stringify(ownScript("prepare-worker-tree.mjs"))} .wrangler/validate/src`;
    const backendBuild = yield* Command.Build("BackendBuild", {
      command:
        "node build-browser-runtime.mjs && node scripts/build-format-blueprints.mjs && " +
        `pnpm exec capnweb-validate build --out .wrangler/validate && ${prepareTree}`,
      cwd: backendDir,
      // `&&` chains need a real shell (see the gatekeeper build above).
      shell: true,
      outdir: ".wrangler/validate",
      // Sequences the shared workspace-dep build before this one.
      env: { SHARED_DEPS_HASH: sharedDepsHash },
      memo: {
        include: [
          "src/**",
          "format-blueprints/**",
          "build-browser-runtime.mjs",
          "scripts/build-format-blueprints.mjs",
          "package.json",
          "../backend-utils/src/**",
          "../workshop-shared/src/**",
          "../typed-storage/src/**",
          "../error-reporting/src/**",
          "../mcp-shared/src/**",
        ],
        lockfile: true,
      },
    });

    const backendEnv: Record<string, unknown> = {
      BLUEPRINTS: blueprints,
      AVATARS: avatars,
      BLUEPRINT_CONTENT: blueprintContent,
      BROWSER: Cloudflare.Workers.Browser("BROWSER"),
      // Always bound in prod: the webFetch agent tool's toMarkdown needs it,
      // gateway mode or not.
      WORKERS_AI: Cloudflare.Workers.AI("WORKERS_AI"),
      // Sequences the backend build before bundling (see the gatekeeper
      // builds — `main` must stay static for the precreate stub).
      BUILD_HASH: Output.map(backendBuild.hash.output, (hash) => hash ?? ""),
      PUBLIC_BASE_URL: publicBaseUrl,
    };
    // Backend reaches gatekeepers through the `GatekeeperVendor` entrypoint
    // (capability RPC), unlike the router's default entrypoint. Vendor
    // `ctx.props` (e.g. context's sharingDomain) ride the binding; note the
    // Cloudflare API's schema doesn't carry `props` on live uploads yet
    // (`alchemy dev` delivers them) — pending the distilled patch.
    for (const manifest of gatekeeperSet) {
      const worker = gatekeepers[manifest.name]!;
      backendEnv[gatekeeperBindingName(manifest.name)] =
        Cloudflare.WorkerEntrypoint(worker, {
          entrypoint: "GatekeeperVendor",
          ...(manifest.vendorProps
            ? { props: substituteProps(manifest.vendorProps) }
            : {}),
        });
    }
    // Caller-owned service bindings (e.g. a private error reporter).
    for (const service of props.backend?.services ?? []) {
      backendEnv[service.binding] = Cloudflare.WorkerEntrypoint(
        service.worker,
        {
          entrypoint: service.entrypoint,
          ...(service.props ? { props: substituteProps(service.props) } : {}),
        },
      );
    }
    // Durable Object classes are reached via `ctx.exports`
    // (`enable_ctx_exports`); the bindings exist to declare the classes and
    // their SQLite migrations, derived from wrangler.jsonc's history.
    for (const className of backendWrangler.durableObjects) {
      backendEnv[className] = Cloudflare.DurableObject(className);
    }
    if (props.admins !== undefined) backendEnv.ADMINS = props.admins;
    const auth = props.auth;
    if (auth?.gatekeepers?.length) {
      backendEnv.AUTH_GATEKEEPERS = auth.gatekeepers.join(",");
      if (auth.disablePasswordAuth) backendEnv.DISABLE_PASSWORD_AUTH = "true";
    }
    if (auth?.access) {
      backendEnv.CF_ACCESS_AUD = auth.access.aud;
      backendEnv.CF_ACCESS_ISS = auth.access.iss;
    }
    Object.assign(backendEnv, ai?.backendEnv);
    Object.assign(backendEnv, props.backend?.env);

    const backend = yield* Cloudflare.Worker("Backend", {
      main: backendWrangler.main,
      compatibility: {
        date: backendWrangler.compatibilityDate ?? COMPATIBILITY_DATE,
        flags: backendWrangler.compatibilityFlags,
      },
      rules: TEXT_RULES,
      observability: OBSERVABILITY,
      env: backendEnv as WorkerEnv,
    });

    // Dynamic Workers: gadget server code runs in loader-created isolates.
    yield* backend.bind("Loader", {
      bindings: [{ type: "worker_loader", name: "LOADER" }],
    });

    // ── Router service bindings (attached post-hoc via `bind`: the router
    //    was created before the backend so its URL could flow into the
    //    backend's env — bindings close the resulting cycle) ─────────────
    yield* router.bind`${backend}`({
      bindings: [
        {
          type: "service",
          name: "WORKSHOP_BACKEND",
          service: backend.workerName,
        },
      ],
    });
    for (const [name, worker] of Object.entries(gatekeepers)) {
      // Default entrypoint: whole HTTP requests are forwarded.
      yield* router.bind`${worker}`({
        bindings: [
          {
            type: "service",
            name: gatekeeperBindingName(name),
            service: worker.workerName,
          },
        ],
      });
    }

    // Each gatekeeper's public base path (`<origin>/gatekeeper/<name>`),
    // attached via `bind` — the gatekeepers were created before the router.
    for (const manifest of gatekeeperSet) {
      const worker = gatekeepers[manifest.name]!;
      yield* worker.bind("BaseUrl", {
        bindings: [
          {
            type: "plain_text",
            name: "BASE_URL",
            text: appendPath(publicBaseUrl, `/gatekeeper/${manifest.name}`),
          },
        ],
      });
    }

    return {
      /** The OS's public origin. */
      url: router.url,
      router,
      backend,
      gatekeepers,
      blueprints,
      avatars,
      blueprintContent,
      gateway: ai?.gateway,
    };
  }).pipe(Namespace.push(id));

const isGatewayResource = (
  value: GatewayProps | AIGateway,
): value is AIGateway =>
  (value as { Type?: unknown }).Type === "Cloudflare.AI.Gateway";

/** Provision the AI Gateway, its Run+Read token, and stored provider keys. */
const makeAI = (ai: AIProps) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const providers = Object.entries(ai.providers ?? {});

    // Stored provider keys resolve out of the account Secrets Store, which
    // must be attached to the gateway via `storeId`.
    const store = providers.length
      ? yield* Cloudflare.SecretsStore.Store("KeyStore")
      : undefined;

    if (ai.gateway !== undefined && isGatewayResource(ai.gateway) && store) {
      // Stored keys resolve out of the store attached to the gateway via
      // `storeId`; we can't retrofit that onto a gateway we don't manage.
      throw new Error(
        "ai.providers requires the OperatingSystem to provision the gateway: " +
          "pass gateway props (or omit `gateway`) instead of an existing " +
          "Gateway resource, or attach your own SecretsStore + ProviderKeys " +
          "to that gateway and set CF_AI_GATEWAY_PROVIDERS yourself.",
      );
    }

    const gateway =
      ai.gateway !== undefined && isGatewayResource(ai.gateway)
        ? ai.gateway
        : yield* Cloudflare.AI.Gateway("Gateway", {
            ...(ai.gateway as GatewayProps | undefined),
            ...(store ? { storeId: store.storeId } : {}),
          });

    // Least-privilege token for the backend: Run to route inference, Read
    // to retrieve per-log costs for user-visible accounting.
    const token = yield* Cloudflare.ApiToken.AccountApiToken("GatewayToken", {
      policies: [
        {
          effect: "allow",
          permissionGroups: ["AI Gateway Run", "AI Gateway Read"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });

    for (const [slug, value] of providers) {
      yield* Cloudflare.AI.ProviderKey(`${pascal(slug)}Key`, {
        gatewayId: gateway.gatewayId as unknown as string,
        providerSlug: slug,
        store: {
          storeId: store!.storeId as unknown as string,
          accountId: store!.accountId as unknown as string,
        },
        value,
        defaultConfig: true,
      });
    }

    const backendEnv: Record<string, unknown> = {
      CF_AI_GATEWAY: gateway.gatewayId,
      CF_AI_GATEWAY_ACCOUNT_ID: gateway.accountId,
      CF_AI_GATEWAY_API_TOKEN: token.value,
    };
    if (providers.length) {
      backendEnv.CF_AI_GATEWAY_PROVIDERS = providers
        .map(([slug]) => slug)
        .join(",");
    }
    if (ai.workersAi === "direct") {
      backendEnv.CF_AI_GATEWAY_WAI_DIRECT = "true";
    } else if (typeof ai.workersAi === "string") {
      backendEnv.CF_AI_GATEWAY_WAI = ai.workersAi;
    }
    if (ai.limits?.enableCloudflareLimits) {
      backendEnv.ENABLE_CLOUDFLARE_LIMITS = "true";
    }
    if (ai.limits?.dailyLlmCallLimit !== undefined) {
      backendEnv.DAILY_LLM_CALL_LIMIT = String(ai.limits.dailyLlmCallLimit);
    }
    if (ai.limits?.minimumCloudflareBalance !== undefined) {
      backendEnv.MINIMUM_CLOUDFLARE_BALANCE = String(
        ai.limits.minimumCloudflareBalance,
      );
    }

    return { gateway, token, backendEnv };
  }).pipe(Namespace.push("AI"));
