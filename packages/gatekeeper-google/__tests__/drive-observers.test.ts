import { describe, expect, it } from "vitest";
import { DRIVE_OBSERVATION_PREFIX, driveObserverTracker } from "../src/drive-observers";
import type { DriveBindingScope } from "../src/drive-session";
import type { ObserverBatchResult } from "../src/observers";
import { FakeKv } from "./fake-kv";

function allow(ids: readonly string[]): ObserverBatchResult {
  return { baselineAllowed: true, allowed: ids.map(() => true) };
}

function deny(ids: readonly string[]): ObserverBatchResult {
  return { baselineAllowed: true, allowed: ids.map(() => false) };
}

function tracker(
  scope: DriveBindingScope,
  verdicts: (ids: readonly string[], verifier: string) => ObserverBatchResult | Promise<ObserverBatchResult>,
) {
  let kv = new FakeKv();
  let asked: string[][] = [];
  let track = driveObserverTracker<string>(kv, scope, async (verifier, fileIds) => {
    asked.push([...fileIds]);
    return verdicts(fileIds, verifier);
  });
  return { kv, asked, track };
}

describe("driveObserverTracker", () => {

  it("seeds a file binding with its bound file, so a joiner is verified against it", async () => {
    let { kv, asked, track } = tracker({ kind: "file", fileId: "file-1" }, allow);

    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}file-1`]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["file-1"]]);
  });

  it("seeds a shared-drive binding with its root", async () => {
    let { asked, track } = tracker({ kind: "sharedDrive", driveId: "drive-1" }, allow);

    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["drive-1"]]);
  });

  it("seeds an account binding with nothing", async () => {
    let { kv, asked, track } = tracker({ kind: "account" }, allow);

    expect([...kv.entries.keys()]).toEqual([]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([[]]);
  });

  it("refuses - and records no observer for - a joiner denied the bound file", async () => {
    let { kv, track } = tracker({ kind: "file", fileId: "file-1" }, deny);

    await expect(track.addObserver("obs", "verifier"))
      .rejects.toThrow(/cannot access Drive file file-1/);
    expect([...track.observers()]).toEqual([]);
    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}file-1`]);
  });

  it("refuses a joiner holding no Drive grant at all", async () => {
    let { track } = tracker({ kind: "file", fileId: "file-1" },
      ids => ({ baselineAllowed: false, allowed: ids.map(() => false) }));

    await expect(track.addObserver("obs", "verifier"))
      .rejects.toThrow(/has not granted Google Drive access/);
  });

  it("rechecks a file tracked during account observer admission", async () => {
    let release!: () => void;
    let started!: () => void;
    let opening = new Promise<void>(resolve => { release = resolve; });
    let seen = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    let { kv, asked, track } = tracker({ kind: "account" }, async ids => {
      if (calls++ === 0) { started(); await opening; }
      return ids.length === 0 ? allow(ids) : deny(ids);
    });

    let admission = track.addObserver("obs", "verifier");
    await seen;
    kv.put(`${DRIVE_OBSERVATION_PREFIX}file-1`, "pending");
    release();

    await expect(admission).rejects.toThrow(/cannot access Drive file file-1/);
    expect(asked).toEqual([[], ["file-1"]]);
  });

  it("keeps the old Drive verifier after failed same-ID re-verification", async () => {
    let { track } = tracker(
      { kind: "file", fileId: "file-1" },
      (ids, verifier) => verifier === "old" ? allow(ids) : deny(ids),
    );
    await track.addObserver("obs", "old");

    await expect(track.addObserver("obs", "new"))
      .rejects.toThrow(/cannot access Drive file file-1/);

    expect((await track.prepareObservation(["file-2"])).excludeObservers).toBeUndefined();
  });
  it("percent-encodes an ID that would otherwise collide with the key grammar", async () => {
    let { kv, asked, track } = tracker({ kind: "file", fileId: "a:b/c" }, allow);

    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}a%3Ab%2Fc`]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["a:b/c"]]);
  });
});
