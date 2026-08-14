/**
 * Shared Vite+ `test` task for every package whose tests run under vitest, used by each such
 * package's `vite.config.ts`. Plain objects rather than `defineConfig`, so the packages need no
 * resolvable `vite-plus` import of their own -- the same reason
 * `gatekeeper-configurator-vite-config.ts` takes that shape. The task types below are structural
 * copies of Vite+'s rather than imports of them, which is what keeps that true.
 *
 * TypeScript, unlike the `.mjs`/`.js` around it in this directory, because nothing here is ever run
 * by `node` -- both modules are imported only from `vite.config.ts` files, which vite bundles -- and
 * being TS means a malformed task or a mistyped `base` is a compile error rather than a glob that
 * silently never matches. Importers still write the `.js` extension in the specifier; TS and vite
 * both resolve it to the `.ts`.
 *
 * `test` is a task rather than a package.json script so the scratch paths every `vitest run` writes
 * and then reads back can be kept out of the fingerprint: vp declines to cache a task that reads a
 * path it also wrote, and without these exclusions almost nothing cached. vp forbids a task and a
 * script sharing a name, so the packages have no `test` script any more and
 * `vp run -F <package> test` is what replaces `pnpm --filter <package> test`.
 */

/** A glob paired with the directory its pattern resolves against. */
export type GlobWithBase = {
  pattern: string
  base: 'package' | 'workspace'
}

/** The subset of a Vite+ task this factory produces. */
export type VitestTask = {
  command: string | string[]
  input: (GlobWithBase | { auto: boolean })[]
  output: (GlobWithBase | { auto: boolean })[]
}

/** A Vite+ config carrying a `run.tasks` map. */
export type RunTasksConfig = {
  run?: {
    tasks?: Record<string, unknown>
  }
}

/**
 * Paths vitest generates and reads back on the next run, excluded from both the fingerprint and the
 * archived outputs:
 *
 * - `node_modules/.vite/vitest/<project-hash>/results.json` -- per-file durations and pass/fail,
 *   read by vitest's `BaseSequencer` to order failed-first and slowest-first. Distinct from the
 *   sibling `node_modules/.vite/deps`, which is a real transform cache.
 * - `node_modules/.vite-temp/*.config.ts.timestamp-*.mjs` -- vite's default `bundle` config loader
 *   compiles a TS config to a temp module here, imports it, then unlinks it. The name carries a
 *   timestamp, so every run writes a fresh path and no run could ever match a previous fingerprint.
 * - `.wrangler/validate/**` -- the capnweb-validate build tree, regenerated and then loaded by any
 *   suite that starts a worker under `@cloudflare/vitest-pool-workers`. It is derived from sources
 *   that are tracked, so dropping it from the fingerprint loses no invalidation. `build:app`
 *   excludes the same tree, for the same reason.
 *
 * These are tool-managed scratch paths that Vite+'s own cooperative tracking already excludes for
 * `vp build` (`guide/automatic-data-tracking.md` names `node_modules/.vite-temp` as a path that
 * "should not be inputs or outputs"), so excluding them is the blessed shape rather than a
 * workaround.
 *
 * Workspace-wide rather than package-relative: tracking reaches past the package that owns the
 * task, so a sibling's scratch files would otherwise stay in this package's fingerprint and the
 * packages would invalidate each other -- the same trap documented on `build:app`.
 *
 * This list is unlikely to be closed. When a test task stops caching, `vp run --last-details` names
 * the path it read and wrote -- add it here if it is shared, or at the call site if it is one
 * package's own (as `workshop-frontend`'s `dist/**` is).
 */
const VITEST_SCRATCH_EXCLUSIONS: GlobWithBase[] = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/**', base: 'workspace' },
]

/**
 * The `test` task for a package, given the vitest invocation its `test` script used to hold.
 * An array of commands is run in order and cached as one entry per command, so a package with
 * codegen ahead of its tests can still replay the codegen and re-run only the tests.
 *
 * `extraExclusions` adds package-specific patterns to the shared ones. Only `workshop-frontend`
 * needs any: nothing else here writes a build artifact into a directory its own tests track.
 */
export function vitestTask(
  command: string | string[],
  extraExclusions: GlobWithBase[] = [],
): VitestTask {
  const exclusions = [...VITEST_SCRATCH_EXCLUSIONS, ...extraExclusions]
  return {
    command,
    input: [{ auto: true }, ...exclusions],
    output: [{ auto: true }, ...exclusions],
  }
}

/**
 * A whole `vite.config.ts` default export, for the packages that need no other Vite+ settings.
 * Packages that do use `withVitestTask()` or `vitestTask()` instead.
 */
export default function vitestTaskViteConfig(
  command: string | string[],
  extraExclusions: GlobWithBase[] = [],
): { run: { tasks: { test: VitestTask } } } {
  return {
    run: {
      tasks: {
        test: vitestTask(command, extraExclusions),
      },
    },
  }
}

/**
 * `config` with the `test` task added to whatever tasks it already declares. Used by
 * `gatekeeper-configurator-vite-config.ts` to build its `withTests` variant.
 */
export function withVitestTask<T extends RunTasksConfig>(
  config: T,
  command: string | string[],
): T & { run: { tasks: Record<string, unknown> } } {
  return {
    ...config,
    run: {
      ...config.run,
      tasks: {
        ...config.run?.tasks,
        test: vitestTask(command),
      },
    },
  }
}
