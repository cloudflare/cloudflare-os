import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * No bindings: the Worker holds no credential and makes no request of its own. The Workshop lends
 * it the Admin API of a workspace's owner, a session at a time.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-admin",
  entrypoint: ".wrangler/validate/src/worker.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: {
    ...CAPNWEB_VALIDATE_BUILD,
    // The Worker bundles the Admin API's schema, which is generated and not committed. Wrangler's
    // build command cannot depend on a task, so it writes the schema itself when it is stale.
    command: `node ../api-schema/scripts/generate.ts --if-stale && ${CAPNWEB_VALIDATE_BUILD.command}`,
    // The schema's sources (the Admin API and ADMIN_AGENT_KINDS) are workshop-shared's, so an edit
    // there rebuilds it under `pnpm dev-server`. Not api-schema/generated, which the build writes.
    watch_dir: ["src", "../workshop-shared/src"],
  },
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** The facet class is reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["AdminGatekeeperImpl"] },
];
