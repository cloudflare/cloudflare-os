import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-websearch",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  env: {
    // Workers AI's `websearch()`. It always runs remotely, so `pnpm dev-server` keeps it only with
    // --use-workers-ai-binding.
    AI: bindings.ai(),
    // The AI Gateway searches go through. The deploy service sets it to the instance's gateway,
    // the one the backend's CF_AI_GATEWAY names; "default" exists in every account, so local dev
    // needs no gateway of its own.
    CF_AI_GATEWAY: bindings.text("default"),
  },
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** The workspace facet is reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["WebSearchGatekeeper"] },
];
