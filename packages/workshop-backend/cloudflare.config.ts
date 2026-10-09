import {
  OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "workshop-backend",
  entrypoint: ".wrangler/validate/src/server.ts",

  // `global_fetch_strictly_public` makes the global fetch() function strictly fetch from
  // the public internet in production, rather than the legacy behavior in which same-zone
  // requests go directly to origin bypassing Cloudflare. This flag is important to protect
  // against SSRF, particularly in the webFetch agent tool, but also generally.
  //
  // When self-hosting with `workerd` stand-alone, it is already the default behavior that the
  // global fetch() function blocks private-network IP addresses or hostnames that resolve to such
  // addresses.
  //
  // Note that `wrangler dev` intentionally reconfigures its global outbound to permit fetching
  // from any address (so local services on localhost stay reachable), so this flag effectively
  // only takes effect in production or when running workerd stand-alone. That's an acceptable
  // tradeoff for dev.
  compatibilityFlags: [
    "allow_irrevocable_stub_storage",
    "global_fetch_strictly_public",

    // The pi-ai inference layer wraps the official provider SDKs (@anthropic-ai/sdk, openai,
    // @google/genai), which need Node compatibility. Puppeteer (used for Gadget PDF exports)
    // also requires Node compatibility. Otherwise, we'd only need nodejs_als.
    "nodejs_compat",
  ],

  // Gatekeeper service bindings and the Workers AI binding are added by run-dev-server.ts in dev
  // and by the release manifest (scripts/release/manifest-lib.ts) in production.
  env: {
    // Wrangler will launch a Chrome instance locally to emulate the Browser Run API during
    // local development. Add `remote: true` to use a remote browser running on Cloudflare instead.
    BROWSER: bindings.browser(),

    // All DO classes (UserDurableObject, OverseerDurableObject, AdminSettings, PendingLogin, ...)
    // are reached via ctx.exports and need no explicit durable_objects binding.
    BLUEPRINTS: bindings.kv(),
    AVATARS: bindings.kv(),
    BLUEPRINT_CONTENT: bindings.r2({ name: "gadgets-blueprint-content" }),
    LOADER: bindings.workerLoader(),
  },

  // When deploying to prod, you may want to bundle the frontend as assets on the backend, like so.
  // But it's not the only way to do it.
  //
  // assets: {
  //   notFoundHandling: "single-page-application",
  //   runWorkerFirst: ["/api", "/api/*", "/blueprint-screenshot/*"],
  // },
  // with `ASSETS: bindings.assets()` in `env` and
  // `assetsDirectory: "../workshop-frontend/dist"` in `wrangler`.
  observability: {
    ...OBSERVABILITY,
    // Traces are free during the beta; spans bill against the Logs quota from 2026-10-01,
    // so revisit the sampling rate before then.
    traces: { enabled: true, headSamplingRate: 0.5 },
  },
});

export const wrangler = {
  build: { command: "pnpm run build:worker", watch_dir: "src" },
  kvPreviewIds: { BLUEPRINTS: "gadgets-blueprint-metadata", AVATARS: "gadgets-avatars" },
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserDurableObject", "OverseerDurableObject"] },
  { tag: "v1", new_sqlite_classes: ["AdminSettings"] },
  // Sign-in via authentication gatekeepers: a short-lived PendingLogin DO bridges each gatekeeper
  // login back to the waiting browser.
  { tag: "v2", new_sqlite_classes: ["PendingLogin"] },
  { tag: "v3", new_sqlite_classes: ["UserDirectoryDurableObject"] },
];
