/**
 * Shared Vite+ `test` task for every package whose tests run under vitest, used by each such
 * package's `vite.config.ts`. Plain objects rather than `defineConfig`, so the packages need no
 * resolvable `vite-plus` import of their own -- the same reason
 * `gatekeeper-configurator-vite-config.ts` takes that shape. The task types below are structural
 * copies of Vite+'s rather than imports of them, which is what keeps that true.
 *
 * TypeScript, unlike the `.mjs` beside it in this directory, because being TS means a malformed task
 * or a mistyped `base` is a compile error rather than a glob that silently never matches.
 *
 * Reached as `@gadgets/scripts/vitest-task`, an `exports` subpath of this directory's package, not
 * as a relative path. A relative specifier only resolves for a consumer at `packages/<name>/` of
 * this workspace, which is not true of the forks that vendor this repo as a submodule. Note that
 * this module is loaded by `node` as well as by vite -- vp resolves it through the `exports` map
 * when it loads a consumer's task graph -- so intra-directory imports must name the file on disk
 * (`./vitest-task-vite-config.ts`); the `.js` specifier only vite remaps would not resolve.
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
 * Paths vitest itself generates and reads back on the next run, excluded from both the fingerprint
 * and the archived outputs:
 *
 * - `node_modules/.vite/vitest/<project-hash>/results.json` -- per-file durations and pass/fail,
 *   read by vitest's `BaseSequencer` to order failed-first and slowest-first. Distinct from the
 *   sibling `node_modules/.vite/deps`, which is a real transform cache.
 * - `node_modules/.vite-temp/*.config.ts.timestamp-*.mjs` -- vite's default `bundle` config loader
 *   compiles a TS config to a temp module here, imports it, then unlinks it. The name carries a
 *   timestamp, so every run writes a fresh path and no run could ever match a previous fingerprint.
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
 *
 * Not named `VITE_...`: `scripts/env-passthrough.test.ts` discovers env reads by matching
 * `.VITE_<NAME>` property access, and a spread of a constant with that prefix reads as one.
 */
export const VITEST_TOOL_SCRATCH_EXCLUSIONS: GlobWithBase[] = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
]

/**
 * The randomly-named scratch trees wrangler writes while a worker runs: `tmp/` holds each boot's
 * bundle, `state/` the local Durable Object and KV storage. Neither is derived from anything
 * tracked and both differ on every run, so a suite that starts a worker cannot cache without them
 * excluded. A survey of every package's `.wrangler` shows these and `validate/` are its only
 * children.
 */
export const WRANGLER_RUNTIME_SCRATCH_EXCLUSIONS: GlobWithBase[] = [
  { pattern: '!**/.wrangler/tmp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/state/**', base: 'workspace' },
]

/**
 * The default set: the vitest scratch paths plus the whole of `.wrangler`.
 *
 * `.wrangler/validate/**` is the capnweb-validate build tree, regenerated and then loaded by any
 * suite that starts a worker under `@cloudflare/vitest-pool-workers`. For these packages it is
 * derived from sources the same task already tracks, so dropping it from the fingerprint loses no
 * invalidation -- and it must be dropped, because a task that reads a path it also wrote never
 * caches. `build:app` excludes the same tree, for the same reason.
 *
 * `integration-tests` is the one package where that reasoning does not hold -- it reads another
 * package's tree and never writes one -- so it opts out via `vitestTaskWithExclusions`.
 */
const DEFAULT_SCRATCH_EXCLUSIONS: GlobWithBase[] = [
  ...VITEST_TOOL_SCRATCH_EXCLUSIONS,
  { pattern: '!**/.wrangler/**', base: 'workspace' },
]

/**
 * Seconds of silence after which a command is considered wedged. A healthy `vitest run` prints a
 * line per completed test file, so silence -- not wall clock -- is what distinguishes a hang from a
 * slow suite.
 */
const IDLE_TIMEOUT_SECONDS = 60

/** Wall-clock backstop, for a command that stays chatty while looping forever. */
const TOTAL_TIMEOUT_SECONDS = 600

/**
 * Nothing under vitest bounds a wedged run -- its own timeouts are enforced inside the test worker
 * that died, and Vite+ has no task timeout -- so a hung suite stalls the whole `vp run` until
 * something outside kills it
 *
 * The watchdog is reached by *bin name*, not by path. The command string is part of the cache
 * fingerprint, so an absolute path derived from `import.meta.url` would differ per checkout and per
 * CI runner and destroy cache portability. A relative `../../scripts/with-timeout.ts` is portable
 * but assumes the consumer sits at `packages/<name>/` of *this* workspace -- untrue for a fork that
 * vendors this repo as a submodule, where it silently resolves to a `scripts/` that holds none of
 * these builders. A bin name is both: fingerprint-stable and position-independent. vp puts the
 * consuming package's `node_modules/.bin` on the task's PATH, so it resolves wherever the package
 * lives, and a rename fails loudly with "Failed to find executable" rather than silently.
 *
 * The thresholds are baked into the string rather than read from the environment for the same
 * fingerprint reason: a cached `vp` run strips undeclared env vars, so an override would silently
 * not apply (and would owe `scripts/env-passthrough.test.ts` an entry). Here a policy change is a
 * visible, fingerprinted change.
 */
export const withTestTimeout = (command: string): string =>
  `gadgets-with-timeout` +
  ` --idle ${IDLE_TIMEOUT_SECONDS} --max ${TOTAL_TIMEOUT_SECONDS} -- ${command}`

/**
 * The `test` task for a package, given the vitest invocation its `test` script used to hold.
 * An array of commands is run in order and cached as one entry per command, so a package with
 * codegen ahead of its tests can still replay the codegen and re-run only the tests.
 *
 * `extraExclusions` adds package-specific patterns to the shared ones. Only `workshop-frontend`
 * needs any: nothing else here writes a build artifact into a directory its own tests track.
 *
 * Every command is wrapped in the watchdog above, including the codegen steps some packages bundle
 * into this task (`workshop-backend`'s `node build-browser-runtime.mjs`) -- those are equally
 * unbounded.
 */
export function vitestTask(
  command: string | string[],
  extraExclusions: GlobWithBase[] = [],
): VitestTask {
  return vitestTaskWithExclusions(command, [...DEFAULT_SCRATCH_EXCLUSIONS, ...extraExclusions])
}

/**
 * Like `vitestTask`, but `exclusions` *replaces* the shared list instead of extending it, for a
 * suite that needs a different `.wrangler` policy than the default above.
 *
 * Only `integration-tests` does: its worker is a prebuilt artifact under another package's
 * `.wrangler/validate`, which is the only fingerprint that carries backend source into this suite.
 * Excluding it would leave the task with no backend information at all.
 */
export function vitestTaskWithExclusions(
  command: string | string[],
  exclusions: GlobWithBase[],
): VitestTask {
  return {
    command: Array.isArray(command) ? command.map(withTestTimeout) : withTestTimeout(command),
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
