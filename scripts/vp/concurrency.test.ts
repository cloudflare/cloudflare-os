import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BYTES_PER_TASK, ROOT_ENV_FILE, VP_DEFAULT_CONCURRENCY_LIMIT, VP_RUN_CONCURRENCY_LIMIT,
  cgroupMemoryLimitBytes, cgroupMounts, concurrencyEnv, defaultConcurrencyLimit,
  effectiveMemoryBytes, envFileConcurrencyLimit, overridesConcurrency, splitConcurrencyLimit,
  vpRunEnv,
} from "./concurrency.ts";

const GiB = 1024 ** 3;

describe("defaultConcurrencyLimit", () => {
  // The machines the header comment cites, plus both directions of the floor: too little memory
  // for the cores, and too few cores for the memory.
  const table: [cpus: number, gib: number, expected: number][] = [
    [4, 16, 4],    // CI (ubuntu-latest): unchanged from Vite+'s default
    [4, 8, 4],
    [8, 16, 8],
    [10, 32, 10],  // CPU-bound: 32 GiB would allow 16
    [16, 64, 16],
    [2, 4, 4],     // below the floor on both counts
    [64, 8, 4],    // memory caps a many-core box at the floor
    [16, 24, 12],  // memory caps below the cpu count
  ];
  for (const [cpus, gib, expected] of table) {
    it(`${cpus} cpus / ${gib} GiB -> ${expected}`, () => {
      assert.equal(defaultConcurrencyLimit(cpus, gib * GiB), expected);
    });
  }

  it("never goes below Vite+'s own default", () => {
    assert.equal(defaultConcurrencyLimit(1, 0), VP_DEFAULT_CONCURRENCY_LIMIT);
    assert.equal(VP_DEFAULT_CONCURRENCY_LIMIT, 4);
  });

  it("budgets 2 GiB per task", () => {
    assert.equal(BYTES_PER_TASK, 2 * GiB);
  });

  // The regression the cgroup ceiling exists for: `totalmem()` reports the host's physical memory,
  // so a 4 GiB container on a 16-core / 64 GiB host would otherwise be handed 16.
  it("lands on the floor inside a memory-limited container on a big host", () => {
    assert.equal(defaultConcurrencyLimit(16, effectiveMemoryBytes(64 * GiB, 4 * GiB)), 4);
    assert.equal(defaultConcurrencyLimit(16, 64 * GiB), 16);
  });
});

describe("effectiveMemoryBytes", () => {
  const table: [label: string, host: number, limit: number | null, expected: number][] = [
    ["no cgroup limit", 32 * GiB, null, 32 * GiB],
    ["limit above host memory", 8 * GiB, 64 * GiB, 8 * GiB],
    ["limit below host memory", 64 * GiB, 4 * GiB, 4 * GiB],
    // Not ceilings, so they must not win the `min` and shrink the budget to nothing.
    ["zero", 32 * GiB, 0, 32 * GiB],
    ["negative", 32 * GiB, -1, 32 * GiB],
    ["NaN", 32 * GiB, NaN, 32 * GiB],
    ["Infinity", 32 * GiB, Infinity, 32 * GiB],
  ];
  for (const [label, host, limit, expected] of table) {
    it(`${label} -> ${(expected / GiB).toFixed(0)} GiB`, () => {
      assert.equal(effectiveMemoryBytes(host, limit), expected);
    });
  }
});

// Fixture trees live under the OS temp directory, never in the workspace: this suite's `input` is
// workspace-wide (see `scripts/vite.config.ts`), so a write in here would be writing its own task
// input. Same discipline as `bin-entry.test.ts`.
const fixtureRoot = mkdtempSync(join(tmpdir(), "vp-concurrency-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let caseCount = 0;

/** A path that is never written, for the cases that need a probe file to be absent. */
const ABSENT = join(fixtureRoot, "absent");

// A cgroupfs-shaped fixture: `files` are paths relative to the cgroup root, `procSelfCgroup` the
// contents of `/proc/self/cgroup` and `mountInfo` those of `/proc/self/mountinfo` (each omitted to
// leave that file absent -- and an absent `mountInfo` is what puts the probe on its hardcoded
// fallback layout, which is why most cases below leave it out). `mountInfo` is a function of the
// fixture's own cgroup root, since the mount points it names have to point into the fixture tree.
function cgroupFixture(
  files: Record<string, string>,
  procSelfCgroup?: string,
  mountInfo?: (root: string) => string,
): { root: string; procSelfCgroup: string; mountInfo: string } {
  const dir = join(fixtureRoot, `case-${++caseCount}`);
  const root = join(dir, "cgroup");
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const procPath = join(dir, "proc-self-cgroup");
  if (procSelfCgroup !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(procPath, procSelfCgroup);
  }
  const mountInfoPath = join(dir, "proc-self-mountinfo");
  if (mountInfo !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(mountInfoPath, mountInfo(root));
  }
  return { root, procSelfCgroup: procPath, mountInfo: mountInfoPath };
}

// A `/proc/self/mountinfo` fixture, written as the literal lines a real kernel emits so the parser
// is exercised against the format rather than against a builder that shares its assumptions.
function mountInfoWith(lines: string[]): string {
  const dir = join(fixtureRoot, `mountinfo-${++caseCount}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "mountinfo");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("cgroupMounts", () => {
  const table: [label: string, lines: string[], v2Root: string | null,
    v1MemoryRoot: string | null][] = [
    ["canonical v2 at the cgroupfs root", [
      "23 27 0:22 / /sys ro,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs ro",
      "28 23 0:25 / /sys/fs/cgroup ro,nosuid,nodev,noexec shared:9 - cgroup2 cgroup2 " +
        "rw,nsdelegate,memory_recursiveprot",
    ], "/sys/fs/cgroup", null],
    // The hybrid layout the hardcoded v2 path missed entirely: cgroup2 is not at the root.
    ["hybrid cgroup2 beside a v1 memory controller", [
      "30 23 0:26 / /sys/fs/cgroup/unified rw,nosuid,nodev,noexec,relatime shared:5 - cgroup2 " +
        "cgroup2 rw",
      "35 23 0:31 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec,relatime shared:10 - cgroup " +
        "cgroup rw,memory",
    ], "/sys/fs/cgroup/unified", "/sys/fs/cgroup/memory"],
    // A joined-name v1 mount: the controller is there, just not at the `memory` subdirectory.
    ["v1 memory co-mounted under a joined name", [
      "36 23 0:32 / /sys/fs/cgroup/cpu,memory rw,nosuid,nodev,noexec,relatime shared:11 - cgroup " +
        "cgroup rw,cpu,cpuacct,memory",
    ], null, "/sys/fs/cgroup/cpu,memory"],
    // `shared:9` present versus absent shifts every later field, which is the whole reason the line
    // is split on ` - ` before it is split into fields.
    ["a line with no optional fields at all", [
      "28 23 0:25 / /sys/fs/cgroup rw,relatime - cgroup2 cgroup2 rw",
    ], "/sys/fs/cgroup", null],
    ["a mount point carrying octal escapes", [
      "28 23 0:25 / /tmp/odd\\040cgroup\\134dir rw,relatime shared:9 - cgroup2 cgroup2 rw",
    ], "/tmp/odd cgroup\\dir", null],
    // Shortest wins, so the canonical mount beats a bind mount of the same hierarchy.
    ["a nested bind mount of the same hierarchy", [
      "40 23 0:25 /foo /var/lib/nested/cgroup2 rw,relatime - cgroup2 cgroup2 rw",
      "28 23 0:25 / /sys/fs/cgroup rw,relatime shared:9 - cgroup2 cgroup2 rw",
    ], "/sys/fs/cgroup", null],
    // A `cgroup` mount without the controller must not be mistaken for one that has it, and no
    // non-cgroup filesystem may match either.
    ["no cgroup mounts at all", [
      "25 27 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
      "33 23 0:29 / /sys/fs/cgroup/pids rw,relatime shared:8 - cgroup cgroup rw,pids",
    ], null, null],
    ["unparseable junk", ["", "nonsense", "1 2 3 - ", "- cgroup2 cgroup2 rw"], null, null],
  ];

  for (const [label, lines, v2Root, v1MemoryRoot] of table) {
    it(`${label} -> ${v2Root ?? "no v2"} / ${v1MemoryRoot ?? "no v1 memory"}`, () => {
      assert.deepEqual(cgroupMounts(mountInfoWith(lines)), { v2Root, v1MemoryRoot });
    });
  }

  it("reports neither hierarchy when the file is absent", () => {
    assert.deepEqual(cgroupMounts(ABSENT), { v2Root: null, v1MemoryRoot: null });
  });
});

describe("cgroupMemoryLimitBytes", () => {
  it("reads a v2 memory.max", () => {
    const probe = cgroupFixture({ "memory.max": "4294967296\n" }, "0::/\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), 4 * GiB);
  });

  it("treats v2's `max` sentinel as no limit", () => {
    const probe = cgroupFixture({ "memory.max": "max\n" }, "0::/\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), null);
  });

  it("takes the tightest ancestor, not the deepest cgroup", () => {
    const probe = cgroupFixture({
      "foo/bar/memory.max": String(8 * GiB),
      "foo/memory.max": String(2 * GiB),
    }, "0::/foo/bar\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), 2 * GiB);
  });

  it("reads a v1 memory.limit_in_bytes for the memory controller's own path", () => {
    const probe = cgroupFixture(
        { "memory/svc/memory.limit_in_bytes": String(4 * GiB) },
        "12:memory,cpu:/svc\n11:pids:/other\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), 4 * GiB);
  });

  // v1's unlimited sentinel parses as a real number, so it comes back as-is and the clamp against
  // host memory is what makes it harmless.
  it("returns v1's unlimited sentinel and lets the host clamp it", () => {
    const sentinel = "9223372036854771712";
    const probe = cgroupFixture({ "memory/memory.limit_in_bytes": sentinel }, "5:memory:/\n");
    const limit = cgroupMemoryLimitBytes({ ...probe, platform: "linux" });
    assert.equal(limit, Number(sentinel));
    assert.equal(effectiveMemoryBytes(32 * GiB, limit), 32 * GiB);
  });

  it("reports no limit when the controller files are absent", () => {
    const probe = cgroupFixture({}, "0::/\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), null);
  });

  // An unreadable /proc/self/cgroup means path `/`, which is what a namespaced container reports
  // anyway -- so the root limit is still found.
  it("falls back to the root cgroup when /proc/self/cgroup is missing", () => {
    const probe = cgroupFixture({ "memory.max": String(4 * GiB) });
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), 4 * GiB);
  });

  // The two layouts the hardcoded paths silently missed. Each asserts `null` for the same fixture
  // read without `mountInfo`, so the case is a demonstration of the bug and not just of the fix.
  it("finds a hybrid layout's cgroup2 mount away from the cgroupfs root", () => {
    const probe = cgroupFixture(
        { "unified/memory.max": String(4 * GiB) },
        "0::/\n",
        root => `30 23 0:26 / ${root}/unified rw,relatime shared:5 - cgroup2 cgroup2 rw`);
    assert.equal(cgroupMemoryLimitBytes({ ...probe, mountInfo: ABSENT, platform: "linux" }), null);
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), 4 * GiB);
  });

  it("finds a v1 memory controller co-mounted under a joined name", () => {
    const probe = cgroupFixture(
        { "cpu,memory/svc/memory.limit_in_bytes": String(2 * GiB) },
        "12:cpu,memory:/svc\n",
        root =>
          `36 23 0:32 / ${root}/cpu,memory rw,relatime - cgroup cgroup rw,cpu,cpuacct,memory`);
    assert.equal(cgroupMemoryLimitBytes({ ...probe, mountInfo: ABSENT, platform: "linux" }), null);
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "linux" }), 2 * GiB);
  });

  // The canonical case has to stay byte-identical to the behaviour before discovery existed, since
  // that is what makes this change purely additive.
  it("falls back to the canonical layout when mountinfo is unreadable", () => {
    const probe = cgroupFixture(
        { "memory.max": String(4 * GiB), "memory/memory.limit_in_bytes": String(2 * GiB) },
        "0::/\n5:memory:/\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, mountInfo: ABSENT, platform: "linux" }),
        2 * GiB);
  });

  it("reports no limit and reads nothing off Linux", () => {
    const probe = cgroupFixture({ "memory.max": String(4 * GiB) }, "0::/\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "darwin" }), null);
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "win32" }), null);
  });
});

// A `.env` fixture, again under the OS temp directory rather than the workspace -- and here that
// matters twice over, since the real path this reads is the repo root's own `.env`.
function envFileWith(contents: string): string {
  const dir = join(fixtureRoot, `env-${++caseCount}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

describe("envFileConcurrencyLimit", () => {
  // Every spelling someone might reasonably use, including the shell `export` that is inert in the
  // file itself but which people write anyway.
  const spellings: [label: string, contents: string][] = [
    ["bare", "VP_RUN_CONCURRENCY_LIMIT=2\n"],
    ["export prefix", "export VP_RUN_CONCURRENCY_LIMIT=2\n"],
    ["double quoted", `VP_RUN_CONCURRENCY_LIMIT="2"\n`],
    ["single quoted", "VP_RUN_CONCURRENCY_LIMIT='2'\n"],
    ["padded", "VP_RUN_CONCURRENCY_LIMIT = 2\n"],
    ["after a comment", "# tuning\nVP_RUN_CONCURRENCY_LIMIT=2\n"],
    ["among other vars", "FOO=bar\nVP_RUN_CONCURRENCY_LIMIT=2\nBAZ=qux\n"],
  ];
  for (const [label, contents] of spellings) {
    it(`reads a ${label} value`, () => {
      assert.equal(envFileConcurrencyLimit(envFileWith(contents)), "2");
    });
  }

  it("reports nothing when the file is absent", () => {
    assert.equal(envFileConcurrencyLimit(join(fixtureRoot, "nope", ".env")), null);
  });

  it("reports nothing when the file sets other variables only", () => {
    assert.equal(envFileConcurrencyLimit(envFileWith("FOO=bar\n")), null);
  });

  // Unvalidated on purpose: vite-task reports a bad value against the name the user set, and this
  // suite pins that so nobody "helpfully" adds a parse here that swallows it instead.
  it("passes a non-numeric value through untouched", () => {
    assert.equal(envFileConcurrencyLimit(envFileWith("VP_RUN_CONCURRENCY_LIMIT=garbage\n")),
        "garbage");
  });

  it("defaults to the repo-root .env, not the current directory", () => {
    // Resolved from the module's own location, so it is stable wherever the command was typed --
    // and pinned against a file that exists only at the workspace root rather than by counting
    // `..` hops from here, which would mirror whatever the implementation does and go green with it.
    assert.equal(basename(ROOT_ENV_FILE), ".env");
    const root = dirname(ROOT_ENV_FILE);
    assert.ok(existsSync(join(root, "pnpm-workspace.yaml")),
        `${root} is not the workspace root`);
  });
});

describe("concurrencyEnv", () => {
  const machine = { cpus: 10, memoryBytes: 32 * GiB };

  it("sets the variable when absent and says so", () => {
    const input = { PATH: "/usr/bin" };
    const { env, note } = concurrencyEnv(input, machine);
    assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "10");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(
        note,
        "vp run: concurrency 10 (10 cpus, 32.0 GiB) -- " +
          "set VP_RUN_CONCURRENCY_LIMIT in the environment or the repo-root .env to override");
  });

  // Saying *why* the number is small is the whole point of the flag: a container user otherwise
  // sees 4.0 GiB on a 64 GiB host and concludes the detection is broken.
  it("names the cgroup limit when that is what capped the memory", () => {
    const { note } = concurrencyEnv({}, { cpus: 16, memoryBytes: 4 * GiB, cgroupLimited: true });
    assert.equal(
        note,
        "vp run: concurrency 4 (16 cpus, 4.0 GiB cgroup limit) -- " +
          "set VP_RUN_CONCURRENCY_LIMIT in the environment or the repo-root .env to override");
  });

  // The `.env` step, and the note that makes it verifiable: the failure it replaces was a value
  // that looked set and silently was not.
  it("takes a .env value over the formula and says where it came from", () => {
    const { env, note } = concurrencyEnv({ PATH: "/usr/bin" }, machine, "2");
    assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "2");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(note, "vp run: concurrency 2 (from .env)");
  });

  // Precedence: the environment is the more specific, more immediate statement of intent, so
  // `VP_RUN_CONCURRENCY_LIMIT=2 pnpm test` still works on a machine whose `.env` says otherwise.
  it("lets a real environment value beat .env, silently", () => {
    const { env, note } = concurrencyEnv({ [VP_RUN_CONCURRENCY_LIMIT]: "3" }, machine, "8");
    assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "3");
    assert.equal(note, null);
  });

  it("passes an unparseable .env value through for vp to report", () => {
    const { env, note } = concurrencyEnv({}, machine, "garbage");
    assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "garbage");
    assert.equal(note, "vp run: concurrency garbage (from .env)");
  });

  // An explicit value always wins, and validating it is vite-task's job, not ours: a deliberately
  // low "1" for an OOM-prone machine and an unparseable string both pass through untouched, and the
  // latter is reported by vp's own parser.
  it("leaves an existing value byte-identical and prints nothing", () => {
    for (const value of ["1", "2", "64", "garbage", ""]) {
      const { env, note } = concurrencyEnv({ [VP_RUN_CONCURRENCY_LIMIT]: value }, machine);
      assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], value);
      assert.equal(note, null);
    }
  });

  it("does not mutate the input", () => {
    const input: NodeJS.ProcessEnv = { HOME: "/home/x" };
    const frozen = Object.freeze({ ...input });
    concurrencyEnv(input, machine);
    assert.deepEqual(input, frozen);
    assert.equal(VP_RUN_CONCURRENCY_LIMIT in input, false);

    const preset: NodeJS.ProcessEnv = { [VP_RUN_CONCURRENCY_LIMIT]: "3" };
    const { env } = concurrencyEnv(preset, machine);
    assert.notEqual(env, preset);
    assert.deepEqual(env, preset);
  });
});

describe("overridesConcurrency", () => {
  // True means "vp will use a number other than the one we resolved, so say nothing". The negatives
  // matter as much as the positives: a false positive here silently drops the note for an ordinary
  // run, which is how the machine-aware limit would go unnoticed again.
  const table: [args: string[], expected: boolean][] = [
    [["--concurrency-limit", "2"], true],
    [["--concurrency-limit=2"], true],
    [["--parallel"], true],
    // Among other arguments, and after the task specifier -- where pnpm appends a forwarded flag.
    [["--filter=!cloudflare-os", "--cache", "build", "--concurrency-limit", "2"], true],
    [["--parallel", "--filter=@gadgets/typed-storage", "build"], true],
    [["--concurrency-limit"], true],       // value omitted; vp reports that itself
    [[], false],
    [["build"], false],
    [["--filter=!cloudflare-os", "--cache", "test"], false],
    [["--concurrency-limitx", "2"], false],
    [["--concurrency-limit-ish=2"], false],
    [["--no-parallel"], false],
    // A task argument that merely contains the flag's name is not the flag.
    [["build", "--", "--concurrency-limit"], true],
    [["--grep", "--parallel-ish"], false],
  ];

  for (const [args, expected] of table) {
    it(`${expected ? "detects" : "ignores"} ${JSON.stringify(args)}`, () => {
      assert.equal(overridesConcurrency(args), expected);
    });
  }
});

// The note goes to stderr through `console.error`, so this is how a case observes whether one was
// printed. Restores the original in a `finally`, since leaving it swapped would silence every
// later suite in the file.
function captureStderr(run: () => NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; err: string } {
  const original = console.error;
  let err = "";
  console.error = (...args: unknown[]) => { err += `${args.join(" ")}\n`; };
  try {
    return { env: run(), err };
  } finally {
    console.error = original;
  }
}

// The bug: `node scripts/vp/run.ts --concurrency-limit 2 ... build` announced the machine's number
// and then ran at 2, because the note printed unconditionally.
describe("vpRunEnv", () => {
  it("stays silent but still sets the variable when a flag overrides it", () => {
    for (const args of [["--concurrency-limit", "2"], ["--concurrency-limit=2"], ["--parallel"]]) {
      const { env, err } = captureStderr(() => vpRunEnv({ env: {}, vpArgs: args }));
      // Set regardless: the flag wins in vp either way, and leaving it set is what preserves
      // behaviour if the flag turns out to be malformed.
      assert.match(env[VP_RUN_CONCURRENCY_LIMIT] ?? "", /^\d+$/,
          `expected a resolved limit for ${JSON.stringify(args)}`);
      assert.equal(err, "", `expected no note for ${JSON.stringify(args)}`);
    }
  });

  it("prints the note when no flag overrides it", () => {
    const { env, err } = captureStderr(
        () => vpRunEnv({ env: {}, vpArgs: ["--filter=!cloudflare-os", "build"] }));
    assert.match(env[VP_RUN_CONCURRENCY_LIMIT] ?? "", /^\d+$/);
    assert.match(err, /^vp run: concurrency \d+ /);
  });

  // The default: callers that build their own fixed `vp run` invocation pass no args, and their own
  // argv must not be mistaken for vp flags.
  it("prints the note when given no arguments at all", () => {
    const { err } = captureStderr(() => vpRunEnv({ env: {} }));
    assert.match(err, /^vp run: concurrency \d+ /);
  });

  // An environment value is the user stating intent directly, so it is silent for its own reason --
  // independent of any flag.
  it("stays silent for an environment value, flag or no flag", () => {
    for (const args of [[], ["--parallel"]]) {
      const { env, err } = captureStderr(
          () => vpRunEnv({ env: { [VP_RUN_CONCURRENCY_LIMIT]: "3" }, vpArgs: args }));
      assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "3");
      assert.equal(err, "");
    }
  });
});

// The division table, shared by the pure function and the wrapper that applies it. Driven by explicit
// env values so it is deterministic: no machine dependence, and silent, since an environment value
// prints no note.
const SPLITS: [label: string, value: string, runs: number, expected: string][] = [
  ["divides evenly", "16", 2, "8"],
  ["divides four ways", "16", 4, "4"],
  ["floors at vp's default rather than 3", "6", 2, "4"],
  // An explicit limit below the floor is what was asked for, and must not be raised past it.
  ["never raises an explicit limit past what was asked", "3", 2, "3"],
  ["one run is no division", "16", 1, "16"],
  // Unvalidated, so vp reports the bad value against the name the user set.
  ["passes a non-numeric value through", "abc", 2, "abc"],
  ["passes a fraction through", "2.5", 2, "2.5"],
  ["passes zero through", "0", 2, "0"],
];

describe("splitConcurrencyLimit", () => {
  for (const [label, value, runs, expected] of SPLITS) {
    it(`${label}: ${value} / ${runs} -> ${expected}`, () => {
      const env = splitConcurrencyLimit({ PATH: "/usr/bin", [VP_RUN_CONCURRENCY_LIMIT]: value }, runs);
      assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], expected);
      assert.equal(env.PATH, "/usr/bin");
    });
  }

  it("leaves an unset variable unset", () => {
    assert.deepEqual(splitConcurrencyLimit({ PATH: "/usr/bin" }, 2), { PATH: "/usr/bin" });
  });

  it("returns a copy, never the input", () => {
    for (const runs of [1, 2]) {
      const input: NodeJS.ProcessEnv = { [VP_RUN_CONCURRENCY_LIMIT]: "16" };
      const env = splitConcurrencyLimit(input, runs);
      assert.notEqual(env, input);
      assert.equal(input[VP_RUN_CONCURRENCY_LIMIT], "16");
    }
  });
});

// The dev server spawns two `vp run`s at once with one environment; without the split each would
// claim the whole machine's budget.
describe("vpRunEnv concurrentRuns", () => {
  for (const [label, value, runs, expected] of SPLITS) {
    it(`${label}: ${value} / ${runs} -> ${expected}`, () => {
      const { env, err } = captureStderr(() =>
          vpRunEnv({ env: { [VP_RUN_CONCURRENCY_LIMIT]: value }, concurrentRuns: runs }));
      assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], expected);
      assert.equal(err, "");
    });
  }

  // The machine-derived number is divided too, and the note still names the undivided budget: that
  // is the number a user would set to override it.
  it("divides the machine-derived limit and prints the whole budget once", () => {
    const whole = captureStderr(() => vpRunEnv({ env: {} }));
    const split = captureStderr(() => vpRunEnv({ env: {}, concurrentRuns: 2 }));
    const total = Number(whole.env[VP_RUN_CONCURRENCY_LIMIT]);
    const perRun = Number(split.env[VP_RUN_CONCURRENCY_LIMIT]);
    assert.match(split.env[VP_RUN_CONCURRENCY_LIMIT] ?? "", /^\d+$/);
    assert.ok(perRun <= total, `${perRun} > ${total}`);
    assert.ok(perRun >= VP_DEFAULT_CONCURRENCY_LIMIT);
    assert.equal(perRun, Math.min(total, Math.max(VP_DEFAULT_CONCURRENCY_LIMIT, Math.floor(total / 2))));
    assert.equal(split.err, whole.err);
    assert.match(split.err, /^vp run: concurrency \d+ /);
  });
});
