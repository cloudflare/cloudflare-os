// Picks the task concurrency for the `vp run` invocations this repo makes, from the machine it is
// running on.
//
// Vite+ runs at most `DEFAULT_CONCURRENCY_LIMIT = 4` tasks at once (vite-task,
// `crates/vt_plan/src/execution_graph.rs`) unless `--concurrency-limit N` or
// `VP_RUN_CONCURRENCY_LIMIT=N` says otherwise; it has no CPU or memory awareness of its own, and
// `defineConfig`'s `run` block has no setting for it, so a `vite.config.ts` cannot change it either.
// Almost nobody knows the env var exists, so on a 10-core / 32 GiB laptop `pnpm build` and
// `pnpm test` leave most of the machine idle. The flag and the env var are the only levers, which is
// why this is a wrapper around the repo's own invocations (root scripts via `run.ts`; the dev
// server, run-local and the release build set `env` on their spawns) rather than configuration. A
// bare `vp run -F <pkg> …` typed by hand still gets Vite+'s default. The dev server spawns two
// `vp run`s at once, so it divides the one limit between them (`concurrentRuns`, below) rather than
// handing each the whole machine.
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
// An explicit value always wins -- including a deliberately low one for an OOM-prone machine -- and
// is never validated or rewritten here: vite-task's own parser reports a bad value. Precedence is
// `--concurrency-limit` > `process.env.VP_RUN_CONCURRENCY_LIMIT` > the repo-root `.env` > this
// formula, and the note says which of the sources the number came from, since a value that silently
// failed to apply is the whole problem being avoided. That is also why a `--concurrency-limit` or
// `--parallel` on the command line prints nothing at all (`overridesConcurrency`): vite-task gives
// the flag priority over the variable, so a note naming our number would contradict the run.
//
// The `.env` step exists because that is where people reasonably expect to put a persistent
// per-machine setting, and neither half of the stack looks there on its own: nothing loads a root
// `.env` into `process.env` (no `--env-file`, no dotenv), and `vp` does not read one either, so the
// variable was silently ignored while this wrapper printed a note inviting the user to set the very
// variable they had just set. Note that a shell `export` in that file is inert unless the file is
// `source`d -- `parseEnv` tolerates the prefix, so the line works here either way.
//
// Only this one variable is read out of `.env`, deliberately: this is not a general environment
// bridge. A cached `vp` run strips the environment down to a built-in set and folds only declared
// vars into task fingerprints (see AGENTS.md), so forwarding arbitrary `.env` entries would change
// what tasks see without changing what they cache against.

import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** vite-task's `DEFAULT_CONCURRENCY_LIMIT`: what `vp run` uses when nothing overrides it. */
export const VP_DEFAULT_CONCURRENCY_LIMIT = 4;

/** Memory budgeted per concurrent task; see the header. */
export const BYTES_PER_TASK = 2 * 1024 ** 3;

/** The environment variable vite-task reads its concurrency limit from. */
export const VP_RUN_CONCURRENCY_LIMIT = "VP_RUN_CONCURRENCY_LIMIT";

/**
 * The repo-root `.env`. Derived from this module's own location rather than `cwd`, because the
 * callers run from different directories (`run-dev-server` and the release build among them) and a
 * setting meant for the workspace should not depend on where the command was typed. Three hops:
 * scripts/vp → scripts → repo root.
 */
export const ROOT_ENV_FILE =
    join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), ".env");

/**
 * `VP_RUN_CONCURRENCY_LIMIT` as spelled in `envFile`, or `null` when the file is absent or does not
 * set it. Returned as the raw string: validating it is vite-task's job, exactly as for a value that
 * arrived through the real environment.
 */
export function envFileConcurrencyLimit(envFile: string = ROOT_ENV_FILE): string | null {
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    // No `.env` at all is the normal case, not a problem to report.
    return null;
  }
  // `node:util`'s parser, so there is no dependency to add and no hand-rolled parsing to get wrong:
  // it already handles quotes, comments, blank lines and a leading `export `.
  const value = parseEnv(text)[VP_RUN_CONCURRENCY_LIMIT];
  return typeof value === "string" ? value : null;
}

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
  /**
   * Where cgroupfs is assumed to be mounted, used only when `mountInfo` names no cgroup mount.
   * Defaults to `/sys/fs/cgroup`.
   */
  root?: string;
  /** The file naming which cgroup this process is in. Defaults to `/proc/self/cgroup`. */
  procSelfCgroup?: string;
  /**
   * The file listing this process's mounts, from which the cgroup roots are discovered. Defaults to
   * `/proc/self/mountinfo`. Separate from `root` rather than derived from it, because `root` is the
   * fallback assumption and this is the evidence that replaces it.
   */
  mountInfo?: string;
  /** Defaults to `process.platform`; anything but `linux` short-circuits to `null`. */
  platform?: NodeJS.Platform;
}

const CGROUP_ROOT = "/sys/fs/cgroup";
const PROC_SELF_CGROUP = "/proc/self/cgroup";
const PROC_SELF_MOUNTINFO = "/proc/self/mountinfo";

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

// The four characters `/proc/self/mountinfo` escapes in a mount point, since a literal one would
// break its space-separated format. Applied in a single regex pass, so an escaped backslash cannot
// be re-read as the start of another escape.
const MOUNTINFO_ESCAPES: Record<string, string> = {
  "040": " ", "011": "\t", "012": "\n", "134": "\\",
};

function unescapeMountPoint(field: string): string {
  return field.replace(/\\(040|011|012|134)/g, (_match, code: string) => MOUNTINFO_ESCAPES[code]);
}

/**
 * The cgroup mount points this process can see, or `null` per hierarchy when there is none.
 *
 * Read rather than assumed, because the canonical layout is a convention and not a guarantee: a
 * cgroup2 hierarchy can be mounted somewhere other than the cgroupfs root (hybrid setups put it at
 * `/sys/fs/cgroup/unified`), and a v1 memory controller can be co-mounted with others under a joined
 * name (`/sys/fs/cgroup/cpu,memory`) instead of the fixed `memory` subdirectory. Under either the
 * hardcoded paths read nothing, and because every read here is best-effort that failure is silent
 * and *opens*: the budget falls back to `totalmem()`, the host's physical memory, which is exactly
 * the container OOM the cgroup term was added to prevent.
 *
 * Lines are `id parent major:minor root mountPoint options [optional...] - fstype source superOpts`
 * (proc(5)). The optional-fields group is variable length, so each line is split on the first ` - `
 * separator before being split into fields: the mount point is index 4 of the left half, and
 * `fstype` and `superOpts` are indices 0 and 2 of the right. v2 is the mount whose `fstype` is
 * `cgroup2`; v1-memory is a `cgroup` mount whose comma-split `superOpts` include `memory`. Where
 * several mounts match, the shortest mount point wins, so a canonical `/sys/fs/cgroup` beats a
 * nested bind mount of the same hierarchy.
 *
 * One simplification, documented rather than solved: field 4 -- the mounted subtree's root *within*
 * the filesystem -- is ignored, so a bind mount exposing a subtree is treated as the hierarchy root.
 * That is the right reading for the namespaced-container case, which is the one that matters here.
 */
export function cgroupMounts(mountInfo: string = PROC_SELF_MOUNTINFO): {
  v2Root: string | null;
  v1MemoryRoot: string | null;
} {
  let v2Root: string | null = null;
  let v1MemoryRoot: string | null = null;

  for (const line of (readTrimmed(mountInfo) ?? "").split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + " - ".length).split(" ");
    // A left half with no mount point in it is junk, not a mount worth guessing at. The right half
    // needs no such guard: `fstype` and `superOpts` are only ever compared, so a missing one simply
    // matches nothing.
    if (left.length < 5) continue;

    const mountPoint = unescapeMountPoint(left[4]);
    const fstype = right[0];
    if (fstype === "cgroup2") {
      if (v2Root === null || mountPoint.length < v2Root.length) v2Root = mountPoint;
    } else if (fstype === "cgroup" && (right[2] ?? "").split(",").includes("memory")) {
      if (v1MemoryRoot === null || mountPoint.length < v1MemoryRoot.length) {
        v1MemoryRoot = mountPoint;
      }
    }
  }
  return { v2Root, v1MemoryRoot };
}

// `/foo/bar` → [`/`, `/foo`, `/foo/bar`]: the cgroup itself and every ancestor. Each one carries its
// own limit, so all of them have to be read -- see the `min` below.
function withAncestors(path: string): string[] {
  const paths = ["/"];
  let current = "";
  for (const segment of path.split("/").filter(part => part.length > 0)) {
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
 *
 * Each hierarchy's root comes from `cgroupMounts`, and falls back to the canonical layout under
 * `root` when `mountInfo` is unreadable or names no cgroup mount of that version -- so on a host
 * mounted the usual way the files read are byte-identical to what a hardcoded layout would give.
 */
export function cgroupMemoryLimitBytes(probe: CgroupProbe = {}): number | null {
  const {
    root = CGROUP_ROOT, procSelfCgroup = PROC_SELF_CGROUP, mountInfo = PROC_SELF_MOUNTINFO,
    platform = process.platform,
  } = probe;
  // Nothing else has cgroups, and this keeps macOS and Windows at zero syscalls.
  if (platform !== "linux") return null;

  const mounts = cgroupMounts(mountInfo);
  const v2Root = mounts.v2Root ?? root;
  const v1MemoryRoot = mounts.v1MemoryRoot ?? join(root, "memory");

  const paths = selfCgroupPaths(procSelfCgroup);
  const files = [
    ...withAncestors(paths.v2).map(path => join(v2Root, path, "memory.max")),
    ...withAncestors(paths.v1).map(path => join(v1MemoryRoot, path, "memory.limit_in_bytes")),
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

// A real ceiling: present, finite and positive. `0`, a negative and v2's `NaN` are none of those,
// and must not win the `min` and shrink the budget to nothing.
function isCeiling(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** The smaller of the two finite ceilings; `hostBytes` alone when there is no cgroup limit. */
export function effectiveMemoryBytes(hostBytes: number, cgroupLimitBytes: number | null): number {
  return isCeiling(hostBytes) && isCeiling(cgroupLimitBytes)
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
 * A copy of `env` with `VP_RUN_CONCURRENCY_LIMIT` resolved, plus the one-line note to print.
 *
 * Precedence is `env` > `envFileValue` > `machine`. A value already in `env` leaves the copy
 * byte-identical and prints nothing: the caller set it in the environment and needs no telling. The
 * other two both print, naming their source -- for `.env` that confirmation *is* the feature, since
 * the failure it replaces was a value that looked set and silently was not.
 */
export function concurrencyEnv(
  env: NodeJS.ProcessEnv, machine: Machine, envFileValue: string | null = null,
): { env: NodeJS.ProcessEnv; note: string | null } {
  if (env[VP_RUN_CONCURRENCY_LIMIT] !== undefined) return { env: { ...env }, note: null };

  // Passed through exactly as written, unvalidated, for the same reason an environment value is:
  // vite-task's parser reports a bad one against the name the user actually set.
  if (envFileValue !== null) {
    return {
      env: { ...env, [VP_RUN_CONCURRENCY_LIMIT]: envFileValue },
      note: `vp run: concurrency ${envFileValue} (from .env)`,
    };
  }

  const limit = defaultConcurrencyLimit(machine.cpus, machine.memoryBytes);
  const gib = (machine.memoryBytes / 1024 ** 3).toFixed(1);
  const memory = machine.cgroupLimited ? `${gib} GiB cgroup limit` : `${gib} GiB`;
  return {
    env: { ...env, [VP_RUN_CONCURRENCY_LIMIT]: String(limit) },
    note: `vp run: concurrency ${limit} (${machine.cpus} cpus, ${memory}) -- ` +
      `set ${VP_RUN_CONCURRENCY_LIMIT} in the environment or the repo-root .env to override`,
  };
}

/**
 * Whether `args` carry a `vp run` flag that overrides the environment, which would make our note
 * wrong. vite-task gives `--concurrency-limit N` priority over `VP_RUN_CONCURRENCY_LIMIT`, and
 * `--parallel` removes the limit altogether unless one is also given, so in either case the number
 * we resolved is not the number that runs.
 *
 * Scans *all* of `args` rather than only what precedes the task specifier. Locating the specifier
 * would mean reimplementing vp's own option parsing (`-F` takes a value, `--filter` may or may not
 * be `=`-joined, ...), and the two failure directions are not symmetric: over-detecting suppresses
 * a note, which costs nothing, while under-detecting prints a concurrency that is not what runs --
 * exactly the silent mismatch this module exists to prevent. So it errs towards silence.
 */
export function overridesConcurrency(args: readonly string[]): boolean {
  return args.some(arg =>
      arg === "--concurrency-limit" || arg.startsWith("--concurrency-limit=") ||
      arg === "--parallel");
}

/**
 * `env` with `VP_RUN_CONCURRENCY_LIMIT` divided between `concurrentRuns` children that will be
 * spawned with it *at the same time*, so that N concurrent runs stay inside the one budget the
 * formula computed rather than claiming it N times over.
 *
 * Never below vp's own default, which is what each child would have used with the variable unset:
 * dividing below it would make a machine-aware limit *slower* than no limit at all. Capped at the
 * whole limit for the other end -- an explicitly-set limit smaller than the floor must not be raised
 * past what was asked for. So the split can only ever raise a machine's effective parallelism above
 * vp's default, never lower it, and never above what the user typed.
 *
 * Unvalidated on the way in and passed straight through when the value is not a plain positive
 * integer, for the same reason `concurrencyEnv` does not validate: a bad value has to reach vp,
 * which reports it against the name the user actually set. Nothing sensible can be divided by,
 * either. `concurrentRuns <= 1` returns a copy of `env` unchanged.
 */
export function splitConcurrencyLimit(
  env: NodeJS.ProcessEnv, concurrentRuns: number,
): NodeJS.ProcessEnv {
  if (concurrentRuns <= 1) return { ...env };

  const total = Number(env[VP_RUN_CONCURRENCY_LIMIT]);
  if (!Number.isInteger(total) || total < 1) return { ...env };

  const perRun =
      Math.min(total, Math.max(VP_DEFAULT_CONCURRENCY_LIMIT, Math.floor(total / concurrentRuns)));
  return { ...env, [VP_RUN_CONCURRENCY_LIMIT]: String(perRun) };
}

/** See {@link vpRunEnv}. */
export interface VpRunEnvOptions {
  /**
   * The arguments being forwarded to `vp run`, inspected only to decide whether to print: a flag
   * that beats the environment makes the note a lie. Defaults to none, because only run.ts forwards
   * user argv -- run-dev-server, run-local and the release build each construct a fixed `vp run`
   * invocation, and their *own* argv must not be mistaken for vp flags.
   */
  vpArgs?: readonly string[];
  /**
   * How many `vp run` children will be spawned with this environment *at the same time*. The limit
   * is divided between them (`splitConcurrencyLimit`), so that N concurrent runs stay inside the
   * one budget the formula computed rather than claiming it N times over -- but never below vp's
   * own default, which is what each of them would have used anyway, so the split can only ever
   * raise the machine's effective parallelism and never lower it. Defaults to 1: no division.
   */
  concurrentRuns?: number;
  /** The environment to resolve against. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The environment to spawn `vp run` with: `process.env` plus the resolved concurrency limit, unless
 * one was already set there. Prints the note to stderr, so call it once per process rather than once
 * per spawn.
 *
 * The variable is set even when a `--concurrency-limit`/`--parallel` flag in `vpArgs` will beat it.
 * The flag wins regardless, and leaving it set is what keeps behaviour unchanged if the flag turns
 * out to be malformed -- vp reports that itself.
 *
 * The note names the *undivided* number, since that is the machine's budget and what the user would
 * set to override it; with `concurrentRuns > 1` each child then gets its share of it.
 */
export function vpRunEnv(
  { vpArgs = [], concurrentRuns = 1, env = process.env }: VpRunEnvOptions = {},
): NodeJS.ProcessEnv {
  const result = concurrencyEnv(env, measureMachine(), envFileConcurrencyLimit());
  if (result.note && !overridesConcurrency(vpArgs)) console.error(result.note);
  return splitConcurrencyLimit(result.env, concurrentRuns);
}
