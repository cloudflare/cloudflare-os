import {
  OBSERVABILITY, bindings, defineGadgetsWorker, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "router",
  entrypoint: "src/index.ts",

  // The router owns the public origin for customer instances, so it serves the frontend.
  // `runWorkerFirst` keeps API and gatekeeper prefixes on the worker; everything else falls
  // through to static assets with SPA fallback.
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: [
      "/api",
      "/api/*",
      "/blueprint-screenshot",
      "/blueprint-screenshot/*",
      "/gatekeeper/*",
    ],
  },

  env: {
    // Gatekeeper service bindings (GATEKEEPER_*) are added dynamically at deploy time — by the
    // deploy service for customer instances, from the release manifest's binding templates. Only
    // the static backend binding is checked in.
    WORKSHOP_BACKEND: bindings.worker({ worker: "workshop-backend" }),
    ASSETS: bindings.assets(),
  },

  observability: OBSERVABILITY,
});

export const wrangler = {
  assetsDirectory: "../workshop-frontend/dist",
} satisfies WranglerExtras;
