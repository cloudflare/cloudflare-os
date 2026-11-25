import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * No bindings: what the Worker can do is the Admin API each account stores, handed over by the
 * Workshop when a deployment admin connects it (hence `allow_irrevocable_stub_storage`).
 */
export default defineGadgetsWorker({
  name: "gatekeeper-admin",
  entrypoint: ".wrangler/validate/src/admin.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: {
    ...CAPNWEB_VALIDATE_BUILD,
    // The Worker bundles its subset of the Admin API's schema, which is generated and not
    // committed. Wrangler's build command cannot depend on a task, so it writes the Workshop
    // API's schema when that is stale, then the subset.
    command: "node ../api-schema/scripts/generate.ts --if-stale && " +
        `node scripts/generate-schema.ts && ${CAPNWEB_VALIDATE_BUILD.command}`,
    // The schema's source is workshop-shared's Admin API, cut by api-schema's tools, so an edit to
    // either rebuilds it under `pnpm dev-server`.
    watch_dir: ["src", "../workshop-shared/src", "../api-schema/src"],
  },
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["AdminGatekeeperImpl", "UserAccount"] },
];
