import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BYTES_PER_TASK, VP_DEFAULT_CONCURRENCY_LIMIT, VP_RUN_CONCURRENCY_LIMIT, concurrencyEnv,
  defaultConcurrencyLimit,
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
});

describe("concurrencyEnv", () => {
  const machine = { cpus: 10, totalMemBytes: 32 * GiB };

  it("sets the variable when absent and says so", () => {
    const input = { PATH: "/usr/bin" };
    const { env, note } = concurrencyEnv(input, machine);
    assert.equal(env[VP_RUN_CONCURRENCY_LIMIT], "10");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(note, "vp run: concurrency 10 (10 cpus, 32.0 GiB) -- set VP_RUN_CONCURRENCY_LIMIT to override");
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
