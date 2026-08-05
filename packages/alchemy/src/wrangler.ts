import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { parse as parseJsonc } from "jsonc-parser";

/**
 * The deploy-relevant subset of a gatekeeper package's `wrangler.jsonc` —
 * the single source of truth for how the worker deploys today. Deriving
 * these at deploy time (instead of copying them into manifests) means an
 * upstream change to a package's flags, migrations, or entrypoint is picked
 * up automatically.
 */
export interface WranglerConfig {
  /** Worker entry module, resolved to an absolute path. */
  main: string;
  /** `compatibility_date`. */
  compatibilityDate: string | undefined;
  /** `compatibility_flags`. */
  compatibilityFlags: string[];
  /** All `new_sqlite_classes` across the ordered migration history. */
  durableObjects: string[];
  /** KV binding names from `kv_namespaces`. */
  kvNamespaces: string[];
  /** Plain vars from `vars`. */
  vars: Record<string, string>;
  /** Static-assets routing config from `assets`, when declared. */
  assets:
    | { notFoundHandling: string | undefined; runWorkerFirst: string[] | boolean | undefined }
    | undefined;
}

interface RawWranglerConfig {
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  migrations?: { new_sqlite_classes?: string[] }[];
  kv_namespaces?: { binding: string }[];
  vars?: Record<string, string>;
  assets?: {
    not_found_handling?: string;
    run_worker_first?: string[] | boolean;
  };
}

/** Parse `<dir>/wrangler.jsonc` into its deploy-relevant subset. */
export const readWranglerConfig = (
  dir: string,
): Effect.Effect<WranglerConfig> =>
  Effect.sync(() => {
    const file = NodePath.join(dir, "wrangler.jsonc");
    const raw = parseJsonc(readFileSync(file, "utf8")) as RawWranglerConfig;
    if (typeof raw?.main !== "string") {
      throw new Error(`${file} has no "main" — not a deployable worker config`);
    }
    return {
      main: NodePath.join(dir, raw.main),
      compatibilityDate: raw.compatibility_date,
      compatibilityFlags: raw.compatibility_flags ?? [],
      durableObjects: (raw.migrations ?? []).flatMap(
        (migration) => migration.new_sqlite_classes ?? [],
      ),
      kvNamespaces: (raw.kv_namespaces ?? []).map((kv) => kv.binding),
      vars: raw.vars ?? {},
      assets: raw.assets
        ? {
            notFoundHandling: raw.assets.not_found_handling,
            runWorkerFirst: raw.assets.run_worker_first,
          }
        : undefined,
    };
  });
