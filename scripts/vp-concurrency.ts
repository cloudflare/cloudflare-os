// Picks the task concurrency for the `vp run` invocations this repo makes, from the machine it is
// running on.
//
// Vite+ runs at most `DEFAULT_CONCURRENCY_LIMIT = 4` tasks at once (vite-task,
// `crates/vt_plan/src/execution_graph.rs`) unless `--concurrency-limit N` or
// `VP_RUN_CONCURRENCY_LIMIT=N` says otherwise; it has no CPU or memory awareness of its own, and
// `defineConfig`'s `run` block has no setting for it, so a `vite.config.ts` cannot change it either.
// Almost nobody knows the env var exists, so on a 10-core / 32 GiB laptop `pnpm build` and
// `pnpm test` leave most of the machine idle. The flag and the env var are the only levers, which is
// why this is a wrapper around the repo's own invocations (root scripts via `vp-run.ts`; the dev
// server, run-local and the release build set `env` on their spawns) rather than configuration. A
// bare `vp run -F <pkg> …` typed by hand still gets Vite+'s default.
//
// Formula: `max(4, min(availableParallelism(), floor(totalmem() / 2 GiB)))`.
//   - `availableParallelism()` rather than `cpus().length` because it respects cgroup CPU limits in
//     containers.
//   - ~2 GiB per task is the memory budget. Single-threaded `tsc` measures ~0.7 GB on the biggest
//     package (AGENTS.md), and the workerd test fleets are heavier -- they are the documented OOM /
//     hang risk -- so memory, not CPU, caps the count on small machines: 8 GiB → 4, 16 GiB → 8,
//     32 GiB → 10 on a 10-core laptop (CPU-bound), 64 GiB / 16 cores → 16.
//   - The floor is Vite+'s own default, so no machine gets slower than today. CI (`ubuntu-latest`,
//     4 vCPU / 16 GiB) lands on exactly 4, so CI behaviour is unchanged.
//
// An explicit `process.env.VP_RUN_CONCURRENCY_LIMIT` always wins -- including a deliberately low
// one for an OOM-prone machine -- and is never validated or rewritten here: vite-task's own parser
// reports a bad value. The note printed when *we* chose the value is the discoverability fix; it
// stays silent when the user set the variable.

import { availableParallelism, totalmem } from "node:os";

/** vite-task's `DEFAULT_CONCURRENCY_LIMIT`: what `vp run` uses when nothing overrides it. */
export const VP_DEFAULT_CONCURRENCY_LIMIT = 4;

/** Memory budgeted per concurrent task; see the header. */
export const BYTES_PER_TASK = 2 * 1024 ** 3;

/** The environment variable vite-task reads its concurrency limit from. */
export const VP_RUN_CONCURRENCY_LIMIT = "VP_RUN_CONCURRENCY_LIMIT";

/** The two machine facts the formula depends on, separated out so it can be tested. */
export interface Machine {
  /** Schedulable CPUs, as `os.availableParallelism()` reports them. */
  cpus: number;
  /** Physical memory in bytes, as `os.totalmem()` reports it. */
  totalMemBytes: number;
}

/** `max(4, min(cpus, floor(mem / 2 GiB)))` -- see the header for the reasoning behind each term. */
export function defaultConcurrencyLimit(cpus: number, totalMemBytes: number): number {
  const byMemory = Math.floor(totalMemBytes / BYTES_PER_TASK);
  return Math.max(VP_DEFAULT_CONCURRENCY_LIMIT, Math.min(cpus, byMemory));
}

/**
 * A copy of `env` with `VP_RUN_CONCURRENCY_LIMIT` set from `machine` unless it is already present
 * (in which case the copy is byte-identical), plus the one-line note to print when this call chose
 * the value. `null` note means the caller set it and nothing should be printed.
 */
export function concurrencyEnv(
  env: NodeJS.ProcessEnv, machine: Machine,
): { env: NodeJS.ProcessEnv; note: string | null } {
  if (env[VP_RUN_CONCURRENCY_LIMIT] !== undefined) return { env: { ...env }, note: null };
  const limit = defaultConcurrencyLimit(machine.cpus, machine.totalMemBytes);
  const gib = (machine.totalMemBytes / 1024 ** 3).toFixed(1);
  return {
    env: { ...env, [VP_RUN_CONCURRENCY_LIMIT]: String(limit) },
    note: `vp run: concurrency ${limit} (${machine.cpus} cpus, ${gib} GiB) -- ` +
      `set ${VP_RUN_CONCURRENCY_LIMIT} to override`,
  };
}

/**
 * The environment to spawn `vp run` with: `process.env` plus the computed concurrency limit, unless
 * one was set. Prints the note to stderr when it decided, so call it once per process rather than
 * once per spawn.
 */
export function vpRunEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = concurrencyEnv(env, { cpus: availableParallelism(), totalMemBytes: totalmem() });
  if (result.note) console.error(result.note);
  return result.env;
}
