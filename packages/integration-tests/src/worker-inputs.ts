// The files that decide what the integration-test Worker is, in one table.
//
// Wrangler bundles the Workshop and its gatekeepers outside Vitest's module graph, so nothing here
// is discovered: watch mode only rebuilds and reruns for a file it was told about. Three consumers
// need that set in three shapes -- literal roots for the file watcher, globs for
// `forceRerunTriggers`, and a predicate for the unlink handler in `global-setup.ts` -- and when
// they were written out separately they drifted. They are all derived from `WORKER_INPUTS` below,
// so an entry added once reaches all three.
//
// Entries are whole *packages* minus their derived output, not hand-picked source directories. The
// list of files that can change a Worker's behaviour is not just source: `tsconfig.json`,
// `package.json` and `wrangler.jsonc` all do, the root `tsconfig.json` every package extends
// controls what `typed-storage` emits into the `dist/index.js` wrangler actually loads, and the
// next such file nobody thought of would need another edit here. Tracking directories costs a
// wider rerun (a backend unit-test edit reruns this suite) and buys not having to be exhaustive.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Absolute, forward-slashed -- vite's watcher and picomatch both want `/` separators on Windows. */
const absolute = (workspaceRelative: string) =>
  resolve(WORKSPACE_DIR, workspaceRelative).replaceAll("\\", "/");

/**
 * One entry in the table. Paths are workspace-relative; `excludeDirs` names *direct children* of
 * the entry only, which is what keeps every derived form below a one-liner. Where an exclusion
 * would have to be nested (backend's `src/generated`), split the directory into two entries
 * instead.
 */
type WorkerInput =
  | { kind: "dir"; path: string; excludeDirs?: string[] }
  | { kind: "file"; path: string };

/** Derived output, plus the dependency tree nothing here should be watching. */
const BUILT = ["dist", "node_modules"];

/**
 * `FORMAT_BLUEPRINTS_DIR` may point outside the workspace, so this can be a `../` path. Resolved
 * exactly as `workshop-backend/scripts/build-format-blueprints.ts` resolves it. When it is unset
 * the default lands inside the `packages/workshop-backend` entry below, and the duplicate coverage
 * is harmless.
 *
 * Read here only to build the watch-mode lists; a cached `vp run` strips it, and the suite it runs
 * (`vitest run`) never consults these exports.
 */
const formatBlueprintsDir = relative(
  WORKSPACE_DIR,
  resolve(
    WORKSPACE_DIR,
    "packages/workshop-backend",
    process.env.FORMAT_BLUEPRINTS_DIR ?? "format-blueprints",
  ),
).replaceAll("\\", "/");

const WORKER_INPUTS: WorkerInput[] = [
  // Split in two so the one nested exclusion, `src/generated`, stays a direct child of its entry.
  // `.wrangler` is the build's own output tree: watching it would let a rebuild trigger itself.
  { kind: "dir", path: "packages/workshop-backend", excludeDirs: [...BUILT, "src", ".wrangler"] },
  { kind: "dir", path: "packages/workshop-backend/src", excludeDirs: ["generated"] },
  { kind: "dir", path: "packages/workshop-shared", excludeDirs: BUILT },
  { kind: "dir", path: "packages/backend-utils", excludeDirs: BUILT },
  { kind: "dir", path: "packages/error-reporting", excludeDirs: BUILT },
  // `typed-storage` is the one package that emits: wrangler loads its `dist/index.js`, so `dist` is
  // output here like anywhere else, and it is the package's config -- not just its source -- that
  // decides what gets emitted.
  { kind: "dir", path: "packages/typed-storage", excludeDirs: BUILT },
  { kind: "dir", path: formatBlueprintsDir },
  // The fixture gatekeeper the harness boots beside the Workshop. Split for the same reason the
  // backend is: `build:test-gatekeeper` validates this fixture into its own `.wrangler`, which is
  // a grandchild of `fixtures/` and so cannot be a direct-child exclusion there.
  { kind: "dir", path: "packages/integration-tests/fixtures", excludeDirs: ["gatekeeper-test"] },
  {
    kind: "dir",
    path: "packages/integration-tests/fixtures/gatekeeper-test",
    excludeDirs: [".wrangler", "node_modules"],
  },
  // Extended by every package above, so it controls their emit and their type checking.
  { kind: "file", path: "tsconfig.json" },
  { kind: "file", path: "pnpm-lock.yaml" },
];

/** Literal roots for `server.watcher.add`. Vite registers paths; the globs below filter events. */
export const WATCH_PATHS: string[] = WORKER_INPUTS.map(entry => absolute(entry.path));

/**
 * `forceRerunTriggers` globs covering the same set.
 *
 * A directory with exclusions becomes two patterns rather than one plus a negation: vitest
 * OR-matches the array with `picomatch.isMatch`, so a standalone `!...` entry is just another
 * pattern that matches nearly every path. The exclusion has to live *inside* a pattern.
 */
export const FORCE_RERUN_TRIGGERS: string[] = WORKER_INPUTS.flatMap(entry => {
  if (entry.kind === "file") return [absolute(entry.path)];
  const root = absolute(entry.path);
  if (!entry.excludeDirs?.length) return [`${root}/**`];
  return [`${root}/*`, `${root}/!(${entry.excludeDirs.join("|")})/**`];
});

/**
 * Whether an absolute path is one of the inputs above.
 *
 * Plain string operations rather than the `picomatch` the globs are matched with: it is a
 * transitive dependency here, not resolvable from this package, and the shapes the table can
 * produce are a prefix and a first-segment check.
 */
export function isWorkerInput(absolutePath: string): boolean {
  const path = resolve(absolutePath).replaceAll("\\", "/");
  return WORKER_INPUTS.some(entry => {
    const root = absolute(entry.path);
    if (entry.kind === "file") return path === root;
    if (!path.startsWith(`${root}/`)) return false;
    const [firstSegment] = path.slice(root.length + 1).split("/");
    return !entry.excludeDirs?.includes(firstSegment);
  });
}
