// Boots the real workshop-backend alongside one or more real gatekeepers under wrangler's
// createTestHarness, so tests drive production code paths end to end.
//
// Parameterised over gatekeepers on purpose: a suite for a new gatekeeper should be "point the
// harness at the package and plug in a handler module", not a forked copy of this file. Per-vendor
// suites in consumer repos use this as-is.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));

// Sibling of this package, whether that's `packages/` in this repo or `public/packages/` when a repo
// vendors this one as a submodule.
const WORKSHOP_DIR = resolve(HERE, "../../workshop-backend");
const REPO_ROOT = resolve(HERE, "../../..");

/** Directory of the bundled fixture gatekeeper. See fixtures/gatekeeper-test/README-ish comments. */
export const TEST_GATEKEEPER_DIR = resolve(HERE, "../fixtures/gatekeeper-test");
export const TEST_GATEKEEPER_WORKER = "gatekeeper-test";
/** Service binding suffix, and therefore the vendor id the Workshop derives from it. */
export const TEST_GATEKEEPER_BINDING = "TEST";
export const TEST_VENDOR_ID = TEST_GATEKEEPER_BINDING.toLowerCase();

/** Username that `vars.ADMINS` grants deployment-admin rights to, mirroring run-dev-server.ts. */
export const ADMIN_USERNAME = "admin";

// The slice of wrangler.jsonc the harness reads or rewrites. Loose on purpose: everything else a
// config declares flows through untouched, and wrangler re-validates the whole file when the worker
// boots -- this schema only guards the fields this file touches, so a broken config fails here with
// the field named rather than surviving a cast and failing somewhere stranger.
const WORKER_CONFIG = z.looseObject({
  name: z.string(),
  main: z.string(),
  account_id: z.string().optional(),
  ai: z.looseObject({
    binding: z.string(),
    remote: z.boolean().optional(),
  }).optional(),
  build: z.looseObject({ command: z.string().optional(), cwd: z.string().optional() }).optional(),
  services: z.array(z.looseObject({
    binding: z.string(),
    service: z.string(),
    entrypoint: z.string().optional(),
  })).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  worker_loaders: z.unknown().optional(),
});

/** A parsed wrangler.jsonc, typed on the fields the harness (or a `patch` callback) works with. */
export type WorkerConfig = z.infer<typeof WORKER_CONFIG>;

export type GatekeeperSpec = {
  /**
   * Service binding suffix. `GATEKEEPER_<binding>` is what the Workshop scans for, and it lowercases
   * the suffix into the vendor id -- so "JIRA" here is the vendor id "jira" in every RPC.
   */
  binding: string;
  /** The gatekeeper package's directory, holding the wrangler.jsonc to boot. */
  dir: string;
  /** Adjust the gatekeeper's config after it's read, e.g. to set vars the tests depend on. */
  patch?: (config: WorkerConfig) => void;
};

// Read a checked-in wrangler.jsonc and make it usable as an *inline* harness config.
//
// A worker whose `main` is generated (capnweb-validate) needs `build.cwd` pinned to its own directory
// or the output lands in the wrong place -- run-dev-server.ts pins it for the same reason. `main` then
// has to be absolute too: an inline config has no file path of its own, so wrangler resolves a
// relative `main` against the harness `root` rather than the worker directory.
function readWorkerConfig(dir: string): WorkerConfig {
  const path = join(dir, "wrangler.jsonc");
  const parsed = WORKER_CONFIG.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} is not a usable worker config: ${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  config.build = { ...config.build, cwd: dir };
  config.main = join(dir, config.main);

  // Local-dev var files (.dev.vars/.env at the harness root) must not leak into tests: a
  // developer's local settings (say CF_AI_GATEWAY_*) would make suites behave differently on
  // their machine than in CI -- up to sending real AI traffic. Declaring an empty required-secrets
  // list makes wrangler exclude every such key that is not already a config var.
  config.secrets = { required: [] };
  return config;
}

function workshopConfig(
    gatekeepers: { binding: string; name: string }[],
    enableGadgetExecution: boolean,
    patch?: (config: WorkerConfig) => void): WorkerConfig {
  const config = readWorkerConfig(WORKSHOP_DIR);
  // globalSetup completed the destructive shared `.wrangler/validate` build before file workers
  // started. Rebuilding it in each fork would race on that directory.
  if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;

  // The checked-in config declares no services; run-dev-server.ts adds one per gatekeeper. We add
  // only the ones the suite asked for, so buildGatekeeperVendorMap() discovers exactly those vendors
  // and the observer-config prompt has no surprise rows.
  config.services = gatekeepers.map(gk => ({
    binding: `GATEKEEPER_${gk.binding}`,
    service: gk.name,
    entrypoint: "GatekeeperVendor",
  }));

  // No CF_ACCESS_AUD, so /api takes the unauthenticated path and password signup is available.
  config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME] };

  // Most integration tests need no Gadget execution. Keep the loader only for tests that exercise
  // executeCode or a generated Gadget server.
  if (!enableGadgetExecution) delete config.worker_loaders;

  patch?.(config);
  return config;
}

export type Harness = {
  server: TestHarness;
  /** Base URL of the running server, e.g. http://127.0.0.1:1234. */
  url: URL;
  /**
   * Dispatch a request to a named worker's own HTTP entrypoint.
   *
   * Its host is never resolved -- the request goes straight to that worker -- so no `routes` config
   * is needed. The path still has to match whatever the worker expects.
   *
   * Typed as the harness's own dispatch signature: this package sees both Node and Workers global
   * types, so spelling out Request/Response here would pick the wrong flavour.
   */
  fetchWorker(name: string, ...args: Parameters<TestHarness["fetch"]>)
      : ReturnType<TestHarness["fetch"]>;
};

export async function startHarness(opts: {
  gatekeepers: GatekeeperSpec[];
  patchWorkshop?: (config: WorkerConfig) => void;
  enableGadgetExecution?: boolean;
  /** Defaults to this repo's root. Override when a gatekeeper lives outside it. */
  root?: string;
}): Promise<Harness> {
  // Each gatekeeper's config is read (and patched) exactly once; the service binding below points at
  // the name the booted worker will actually carry, patches included.
  const gatekeepers = opts.gatekeepers.map(gk => {
    const config = readWorkerConfig(gk.dir);
    gk.patch?.(config);
    return { binding: gk.binding, name: config.name, config };
  });

  const server = createTestHarness({
    root: opts.root ?? REPO_ROOT,
    // workshop-backend is primary, so unrouted requests (e.g. /api) go to it.
    workers: [
      { config: workshopConfig(gatekeepers, opts.enableGadgetExecution ?? false,
          opts.patchWorkshop) },
      ...gatekeepers.map(({ config }) => ({ config })),
    ],
  });

  const { url } = await server.listen();
  return {
    server,
    url,
    fetchWorker: (name, ...args) => server.getWorker(name).fetch(...args),
  };
}

/**
 * How long to wait for a scheduled workspace restart to land (scheduleAccessRestart's delay plus
 * slack). See settleRestart().
 */
export const RESTART_SETTLE_MS = 400;

/**
 * Wait out a restart a test triggered but doesn't otherwise observe.
 *
 * Widening a collaborator's verification scope severs every session on the workspace by aborting
 * the DO ~100ms later, i.e. after the test body has returned. An abort that lands with no client
 * left on the workspace crashes the local workerd, and a suite's tests share one harness, so the
 * crash fails whichever siblings are mid-flight rather than the test that caused it. Call this
 * before the triggering test drops its connection.
 */
export function settleRestart(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, RESTART_SETTLE_MS));
}

/** Boot the Workshop with only the bundled fixture gatekeeper bound. */
export function startTestGatekeeperHarness(options: { enableGadgetExecution?: boolean } = {})
    : Promise<Harness> {
  return startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    enableGadgetExecution: options.enableGadgetExecution,
  });
}
