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
// Formula: `max(4, min(availableParallelism(), floor(min(totalmem(), cgroup limit) / 2 GiB)))`.
//   - `availableParallelism()` rather than `cpus().length` because it respects cgroup CPU limits in
//     containers.
//   - ~2 GiB per task is the memory budget. Single-threaded `tsc` measures ~0.7 GB on the biggest
//     package (AGENTS.md), and the workerd test fleets are heavier -- they are the documented OOM /
//     hang risk -- so memory, not CPU, caps the count on small machines: 8 GiB → 4, 16 GiB → 8,
//     32 GiB → 10 on a 10-core laptop (CPU-bound), 64 GiB / 16 cores → 16. The budget is the
//     *smaller* of host RAM and whatever cgroup memory limit applies, because `totalmem()` reports
//     the host's physical memory and ignores the limit: in a container (`docker run -m 4g` on a
//     64 GiB host, a constrained CI runner) it would see 64 GiB and pick a concurrency the container
//     cannot sustain -- which is precisely the OOM this term exists to prevent. `totalmem()` alone
//     is the fallback wherever no limit is readable: macOS, Windows, no cgroupfs, unlimited cgroup.
//   - The floor is Vite+'s own default, so no machine gets slower than today. CI (`ubuntu-latest`,
//     4 vCPU / 16 GiB) lands on exactly 4, so CI behaviour is unchanged.
//
// An explicit `process.env.VP_RUN_CONCURRENCY_LIMIT` always wins -- including a deliberately low
// one for an OOM-prone machine -- and is never validated or rewritten here: vite-task's own parser
// reports a bad value. The note printed when *we* chose the value is the discoverability fix; it
// stays silent when the user set the variable.

import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";

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
  /** The *effective* memory ceiling in bytes: host RAM, or the tighter cgroup limit if there is one. */
  memoryBytes: number;
  /**
   * Whether a cgroup limit is what produced `memoryBytes`. Note text only -- without it a container
   * user sees `4.0 GiB` on a 64 GiB host and concludes the detection is broken.
   */
  cgroupLimited?: boolean;
}

/** `max(4, min(cpus, floor(mem / 2 GiB)))` -- see the header for the reasoning behind each term. */
export function defaultConcurrencyLimit(cpus: number, totalMemBytes: number): number {
  const byMemory = Math.floor(totalMemBytes / BYTES_PER_TASK);
  return Math.max(VP_DEFAULT_CONCURRENCY_LIMIT, Math.min(cpus, byMemory));
}

/** Filesystem facts the cgroup probe reads; parameters so tests can point at a fixture tree. */
export interface CgroupProbe {
  /** The cgroupfs mount point. Defaults to `/sys/fs/cgroup`. */
  root?: string;
  /** The file naming which cgroup this process is in. Defaults to `/proc/self/cgroup`. */
  procSelfCgroup?: string;
  /** Defaults to `process.platform`; anything but `linux` short-circuits to `null`. */
  platform?: NodeJS.Platform;
}

const CGROUP_ROOT = "/sys/fs/cgroup";
const PROC_SELF_CGROUP = "/proc/self/cgroup";

// Every read here is best-effort: an absent file, an unreadable controller and EACCES are all just
// "no limit from this path", never a failure of the build we are about to run.
function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * The cgroup paths this process belongs to, one per hierarchy version. `/proc/self/cgroup` lines are
 * `<id>:<controllers>:<path>`; v2 is the single `0::<path>` line, and under v1 the one that governs
 * memory is whichever line lists the `memory` controller. Read separately because a hybrid host has
 * both and they need not agree.
 */
function selfCgroupPaths(procSelfCgroup: string): { v2: string; v1: string } {
  // An unreadable file means path `/` -- which is also what a namespaced container reports, and that
  // is by far the common case, so the fallback and the usual answer coincide.
  const text = readTrimmed(procSelfCgroup);
  if (text === null) return { v2: "/", v1: "/" };

  let v2 = "/";
  let v1 = "/";
  for (const line of text.split("\n")) {
    const parsed = /^([^:]*):([^:]*):(.*)$/.exec(line.trim());
    if (!parsed) continue;
    const [, id, controllers, path] = parsed;
    if (path === "") continue;
    if (id === "0" && controllers === "") v2 = path;
    else if (controllers.split(",").includes("memory")) v1 = path;
  }
  return { v2, v1 };
}

// `/foo/bar` → [`/`, `/foo`, `/foo/bar`]: the cgroup itself and every ancestor. Each one carries its
// own limit, so all of them have to be read -- see the `min` below.
function withAncestors(path: string): string[] {
  const paths = ["/"];
  let current = "";
  for (const segment of path.split("/").filter(segment => segment.length > 0)) {
    current += `/${segment}`;
    paths.push(current);
  }
  return paths;
}

/**
 * The cgroup memory ceiling for this process, or `null` when there is none.
 *
 * The smallest finite limit over this process's own cgroup and all of its ancestors: the deepest one
 * is the usual answer, but an ancestor can be tighter and only the smallest is a real ceiling.
 *
 * Unlimited reads as `null` for v2, whose sentinel is the literal `max` (→ `NaN`). v1's sentinel is a
 * huge byte count (`9223372036854771712`) which parses fine and is left to be clamped against host
 * memory by `effectiveMemoryBytes`, so no magic threshold is needed here.
 */
export function cgroupMemoryLimitBytes(probe: CgroupProbe = {}): number | null {
  const {
    root = CGROUP_ROOT, procSelfCgroup = PROC_SELF_CGROUP, platform = process.platform,
  } = probe;
  // Nothing else has cgroups, and this keeps macOS and Windows at zero syscalls.
  if (platform !== "linux") return null;

  const paths = selfCgroupPaths(procSelfCgroup);
  const files = [
    ...withAncestors(paths.v2).map(path => join(root, path, "memory.max")),
    ...withAncestors(paths.v1).map(path => join(root, "memory", path, "memory.limit_in_bytes")),
  ];

  let limit: number | null = null;
  for (const file of files) {
    const text = readTrimmed(file);
    if (text === null) continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (limit === null || value < limit) limit = value;
  }
  return limit;
}

/** The smaller of the two finite ceilings; `hostBytes` alone when there is no cgroup limit. */
export function effectiveMemoryBytes(hostBytes: number, cgroupLimitBytes: number | null): number {
  const usable = (value: number | null): value is number =>
      value !== null && Number.isFinite(value) && value > 0;
  return usable(hostBytes) && usable(cgroupLimitBytes)
      ? Math.min(hostBytes, cgroupLimitBytes)
      : hostBytes;
}

/** The machine facts, measured. */
export function measureMachine(): Machine {
  const hostBytes = totalmem();
  const memoryBytes = effectiveMemoryBytes(hostBytes, cgroupMemoryLimitBytes());
  return { cpus: availableParallelism(), memoryBytes, cgroupLimited: memoryBytes < hostBytes };
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
  const limit = defaultConcurrencyLimit(machine.cpus, machine.memoryBytes);
  const gib = (machine.memoryBytes / 1024 ** 3).toFixed(1);
  const memory = machine.cgroupLimited ? `${gib} GiB cgroup limit` : `${gib} GiB`;
  return {
    env: { ...env, [VP_RUN_CONCURRENCY_LIMIT]: String(limit) },
    note: `vp run: concurrency ${limit} (${machine.cpus} cpus, ${memory}) -- ` +
      `set ${VP_RUN_CONCURRENCY_LIMIT} to override`,
  };
}

/**
 * The environment to spawn `vp run` with: `process.env` plus the computed concurrency limit, unless
 * one was set. Prints the note to stderr when it decided, so call it once per process rather than
 * once per spawn.
 */
export function vpRunEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = concurrencyEnv(env, measureMachine());
  if (result.note) console.error(result.note);
  return result.env;
}
