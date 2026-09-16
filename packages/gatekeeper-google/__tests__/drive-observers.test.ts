import { describe, expect, it } from "vitest";
import {
  DRIVE_OBSERVATION_PREFIX, driveObserverTracker, type DriveObservation,
} from "../src/drive-observers";
import type { DriveBindingScope } from "../src/drive-session";
import type { ObserverBatchResult } from "../src/observers";
import { FakeKv } from "./fake-kv";

function allow(units: readonly DriveObservation[]): ObserverBatchResult {
  return { baselineAllowed: true, allowed: units.map(() => true) };
}

function deny(units: readonly DriveObservation[]): ObserverBatchResult {
  return { baselineAllowed: true, allowed: units.map(() => false) };
}

function tracker(
  scope: DriveBindingScope,
  verdicts: (
    units: readonly DriveObservation[], verifier: string,
  ) => ObserverBatchResult | Promise<ObserverBatchResult>,
) {
  let kv = new FakeKv();
  let asked: DriveObservation[][] = [];
  let track = driveObserverTracker<string>(kv, scope, async (verifier, units) => {
    asked.push([...units]);
    return verdicts(units, verifier);
  });
  return { kv, asked, track };
}

describe("driveObserverTracker", () => {
  it("seeds file and folder bindings with distinct disclosure units", async () => {
    let file = tracker({ kind: "file", fileId: "same" }, allow);
    let folder = tracker({ kind: "folder", folderId: "same" }, allow);

    expect([...file.kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}same`]);
    expect([...folder.kv.entries.keys()]).toEqual([`${DRIVE_OBSERVATION_PREFIX}folder:same`]);
    await file.track.addObserver("obs", "verifier");
    await folder.track.addObserver("obs", "verifier");
    expect(file.asked).toEqual([[{kind: "file", fileId: "same"}]]);
    expect(folder.asked).toEqual([[{kind: "folder", fileId: "same"}]]);
  });

  it("seeds an account binding with nothing", async () => {
    let { kv, asked, track } = tracker({ kind: "account" }, allow);
    expect([...kv.entries.keys()]).toEqual([]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([[]]);
  });

  it("refuses a joiner denied one tracked unit", async () => {
    let { track } = tracker({ kind: "folder", folderId: "folder-1" }, deny);
    await expect(track.addObserver("obs", "verifier"))
      .rejects.toThrow("This collaborator cannot access Drive data this workspace has read.");
    expect([...track.observers()]).toEqual([]);
  });

  it("refuses a joiner holding no Drive grant", async () => {
    let { track } = tracker({ kind: "file", fileId: "file-1" },
      units => ({ baselineAllowed: false, allowed: units.map(() => false) }));
    await expect(track.addObserver("obs", "verifier"))
      .rejects.toThrow(/has not granted Google Drive access/);
  });

  it("rechecks a unit tracked during account observer admission", async () => {
    let release!: () => void;
    let started!: () => void;
    let opening = new Promise<void>(resolve => { release = resolve; });
    let seen = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    let { kv, asked, track } = tracker({ kind: "account" }, async units => {
      if (calls++ === 0) { started(); await opening; }
      return units.length === 0 ? allow(units) : deny(units);
    });

    let admission = track.addObserver("obs", "verifier");
    await seen;
    kv.put(`${DRIVE_OBSERVATION_PREFIX}folder:child`, "pending");
    release();

    await expect(admission).rejects.toThrow(/cannot access Drive data this workspace has read/);
    expect(asked).toEqual([[], [{kind: "folder", fileId: "child"}]]);
  });

  it("decodes historical bare keys as file observations", async () => {
    let { kv, asked, track } = tracker({ kind: "account" }, allow);
    kv.put(`${DRIVE_OBSERVATION_PREFIX}old%2Ffile`, "observed");
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([[{kind: "file", fileId: "old/file"}]]);
  });

  it("percent-encodes IDs without colliding with the typed key grammar", async () => {
    let { kv, asked, track } = tracker({ kind: "folder", folderId: "folder:a/b" }, allow);
    expect([...kv.entries.keys()]).toEqual([
      `${DRIVE_OBSERVATION_PREFIX}folder:folder%3Aa%2Fb`,
    ]);
    await track.addObserver("obs", "verifier");
    expect(asked).toEqual([[{kind: "folder", fileId: "folder:a/b"}]]);
  });
});
