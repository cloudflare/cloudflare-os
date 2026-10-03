import { bindings, defineGadgetsWorker } from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "dev-router",
  // The router package doubles as the dev router: with no ASSETS binding configured here, it
  // forwards frontend requests to the backend (see packages/router/src/index.ts), which serves
  // them from its own assets binding in `run-local` mode.
  entrypoint: "packages/router/src/index.ts",

  env: {
    // Gatekeeper service bindings are dynamically added by run-dev-server.ts.
    WORKSHOP_BACKEND: bindings.worker({ worker: "workshop-backend" }),
  },
});
