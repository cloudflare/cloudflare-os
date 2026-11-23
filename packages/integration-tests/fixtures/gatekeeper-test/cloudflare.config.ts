import { defineGadgetsWorker, type DurableObjectMigration } from "@gadgets/scripts/worker-config";

/** No `wrangler` export: `build:test-gatekeeper`, not wrangler, builds this worker's entrypoint. */
export default defineGadgetsWorker({
  name: "gatekeeper-test",

  // `build:test-gatekeeper` applies the same RPC validation used by production gatekeepers.
  entrypoint: ".wrangler/validate/src/test-gatekeeper.ts",

  compatibilityFlags: ["experimental", "allow_irrevocable_stub_storage"],
});

/** This worker's own DO classes are reached via ctx.exports; no durable_objects binding needed. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["TestGatekeeper", "TestControl"] },
];
