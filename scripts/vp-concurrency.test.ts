import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BYTES_PER_TASK, VP_DEFAULT_CONCURRENCY_LIMIT, VP_RUN_CONCURRENCY_LIMIT, cgroupMemoryLimitBytes,
  concurrencyEnv, defaultConcurrencyLimit, effectiveMemoryBytes,
} from "./vp-concurrency.ts";

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

// A cgroupfs-shaped fixture: `files` are paths relative to the cgroup root, `procSelfCgroup` the
// contents of `/proc/self/cgroup` (omitted to leave that file absent).
function cgroupFixture(files: Record<string, string>, procSelfCgroup?: string): {
  root: string;
  procSelfCgroup: string;
} {
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
  return { root, procSelfCgroup: procPath };
}

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

  it("reports no limit and reads nothing off Linux", () => {
    const probe = cgroupFixture({ "memory.max": String(4 * GiB) }, "0::/\n");
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "darwin" }), null);
    assert.equal(cgroupMemoryLimitBytes({ ...probe, platform: "win32" }), null);
  });
});

describe("concurrencyEnv", () => {
  const machine = { cpus: 10, memoryBytes: 32 * GiB };

  it("sets the variable when absent and says so", () => {
    const input = { PATH: "/usr/bin" };
    const { env, note } = concurrencyEnv(input, machine);
    assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "10");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(note, "vp run: concurrency 10 (10 cpus, 32.0 GiB) -- set VP_RUN_CONCURRENCY_LIMIT to override");
  });

  // Saying *why* the number is small is the whole point of the flag: a container user otherwise
  // sees 4.0 GiB on a 64 GiB host and concludes the detection is broken.
  it("names the cgroup limit when that is what capped the memory", () => {
    const { note } = concurrencyEnv({}, { cpus: 16, memoryBytes: 4 * GiB, cgroupLimited: true });
    assert.equal(
        note,
        "vp run: concurrency 4 (16 cpus, 4.0 GiB cgroup limit) -- " +
          "set VP_RUN_CONCURRENCY_LIMIT to override");
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
