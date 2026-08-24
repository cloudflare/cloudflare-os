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
  verdicts: (ids: readonly string[]) => ObserverBatchResult,
) {
  let kv = new FakeKv();
  let asked: string[][] = [];
  let track = driveObserverTracker<"verifier">(kv, scope, async (_verifier, fileIds) => {
    asked.push([...fileIds]);
    return verdicts(fileIds);
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

  it("percent-encodes an ID that would otherwise collide with the key grammar", async () => {
    let { kv, asked, track } = tracker({ kind: "file", fileId: "a:b/c" }, allow);

    expect([...kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}a%3Ab%2Fc`]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([["a:b/c"]]);
  });
});
