import {
  bindings, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/** No `wrangler` export: `build:test-gatekeeper`, not wrangler, builds this worker's entrypoint. */
export default defineGadgetsWorker({
  name: "gatekeeper-test",

  // `build:test-gatekeeper` applies the same RPC validation used by production gatekeepers.
  entrypoint: ".wrangler/validate/src/test-gatekeeper.ts",

  compatibilityFlags: ["experimental", "allow_irrevocable_stub_storage"],

  env: {
    // Lets the control surface submit external chat messages through the Workshop's gateway
    // entrypoint the way a real chat-integration worker (bound with its own `source` prop) would.
    // The harness always boots workshop-backend as the primary worker, so the name resolves.
    WORKSHOP_EXTERNAL_MESSAGES: bindings.worker({
      worker: "workshop-backend",
      exportName: "ExternalMessageGateway",
      props: { source: "test" },
    }),

    // The Workshop's Overseer namespace, so the control surface can derive the DO id behind an
    // external gadgetKey -- the same name-derived id the gateway targets -- for tests to open the
    // workspace over the web API. The binding only derives ids; it never reaches an instance.
    WORKSHOP_OVERSEER: bindings.durableObject({
      worker: "workshop-backend",
      exportName: "OverseerDurableObject",
    }),
  },
});

/** This worker's own DO classes are reached via ctx.exports; no durable_objects binding needed. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["TestGatekeeper", "TestControl"] },
];
