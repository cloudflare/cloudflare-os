// Shared building blocks for every cloudflare.config.ts in this repo. Each config's default export
// is the @cloudflare/config Worker definition; its named `wrangler` and `migrations` exports carry
// the Wrangler settings that format has no field for. scripts/generate-worker-configs.ts turns all
// three into the committed, generated wrangler.jsonc beside it.
import { defineConfig, type WorkerConfig } from "@cloudflare/config";
import type { DurableObjectMigration, WranglerBuild } from "./release/manifest-lib.ts";

export { bindings } from "@cloudflare/config";
export type { DurableObjectMigration };

/** Workers runtime compatibility date of every Worker here, and of the vitest pools that model them. */
export const COMPATIBILITY_DATE = "2026-09-04";

/** Observability settings shared by the deployed Workers; workshop-backend extends them with traces. */
export const OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { invocationLogs: false },
} satisfies NonNullable<WorkerConfig["observability"]>;

/** The capnweb-validate prebuild: wrangler bundles its output under `.wrangler/validate`. */
export const CAPNWEB_VALIDATE_BUILD: WranglerBuild = {
  command: "pnpm exec capnweb-validate build --out .wrangler/validate",
  watch_dir: "src",
};

/** A Wrangler module rule. Only the Text rules this repo uses are modelled. */
export interface ModuleRule {
  type: "Text";
  globs: string[];
  fallthrough: boolean;
}

/** Import files matching `globs` as Text modules (types.txt symlinks, inline SVG icons). */
export function textModules(globs: string[]): ModuleRule[] {
  return [{ type: "Text", globs, fallthrough: false }];
}

/**
 * Wrangler settings with no @cloudflare/config field, in Wrangler's own snake_case shapes.
 * The generator copies `build` and `rules` verbatim into the generated wrangler.jsonc.
 */
export interface WranglerExtras {
  build?: WranglerBuild;
  rules?: ModuleRule[];
  /** Emitted as `assets.directory`; requires an assets binding in `env`. */
  assetsDirectory?: string;
  /**
   * Local-dev Miniflare namespace id per KV binding, emitted as that entry's `preview_id`. Without
   * it Miniflare keys local data by binding name, orphaning data already stored under these ids.
   */
  kvPreviewIds?: Record<string, string>;
}

/** The `wrangler` export of a gatekeeper validated by capnweb-validate that imports .txt/.svg. */
export const DEFAULT_GATEKEEPER_WRANGLER = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt", "**/*.svg"]),
} satisfies WranglerExtras;

/** `defineConfig` for one Worker, with the repo-wide compatibility date filled in. */
export function defineGadgetsWorker(worker: Omit<WorkerConfig, "compatibilityDate">) {
  return defineConfig({ worker: { compatibilityDate: COMPATIBILITY_DATE, ...worker } });
}
