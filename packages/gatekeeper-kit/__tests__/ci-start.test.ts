import { describe, expect, it } from "vitest";
import { AppliedPushLog, CI_START_WINDOW_MS } from "../src/ci-start";
import { fakeKv } from "./fake-kv";

describe("AppliedPushLog", () => {
  it("records a head once, keeping the first time", () => {
    let now = 1_000;
    const log = new AppliedPushLog(fakeKv(), { now: () => now });
    log.record("a");
    now += 5;
    log.record("a");
    expect(log.get("a")).toBe(1_000);
    expect(log.get("b")).toBeUndefined();
  });

  it("prunes records past the window when recording", () => {
    let now = 0;
    const kv = fakeKv();
    const log = new AppliedPushLog(kv, { now: () => now });
    log.record("old");
    now = CI_START_WINDOW_MS;
    log.record("new");
    expect(kv.keys()).toEqual(["ciPushApplied:new"]);
  });

  it("reads no record once it is past the window, before any prune", () => {
    let now = 0;
    const log = new AppliedPushLog(fakeKv(), { now: () => now });
    log.record("a");
    now = CI_START_WINDOW_MS - 1;
    expect(log.get("a")).toBe(0);
    now = CI_START_WINDOW_MS;
    expect(log.get("a")).toBeUndefined();
  });

  it("drops the oldest records past the cap", () => {
    let now = 0;
    const kv = fakeKv();
    const log = new AppliedPushLog(kv, { max: 2, now: () => now++ });
    for (const sha of ["c", "a", "b"]) log.record(sha);
    expect(kv.keys()).toEqual(["ciPushApplied:a", "ciPushApplied:b"]);
  });
});
