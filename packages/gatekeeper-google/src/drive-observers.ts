import type { DriveBindingScope } from "./drive-session";
import { ObserverTracker, type ObserverBatchResult, type ObserverKv } from "./observers";

/** Key prefix for Drive disclosure units. */
export const DRIVE_OBSERVATION_PREFIX = "observedDriveFile:";

/** Refusal when a joining collaborator holds no Google Drive grant. */
export const DRIVE_BASELINE_DENIED_MESSAGE =
  "This collaborator has not granted Google Drive access, so they cannot observe this binding.";

/** Data access needed to observe a Drive disclosure. */
export type DriveObservation =
  | { kind: "file"; fileId: string }
  | { kind: "folder"; fileId: string };

function encodeObservation(observation: DriveObservation): string {
  let id = encodeURIComponent(observation.fileId);
  return observation.kind === "folder" ? `folder:${id}` : id;
}

function decodeObservation(value: string): DriveObservation {
  if (value.startsWith("folder:")) {
    return {kind: "folder", fileId: decodeURIComponent(value.slice("folder:".length))};
  }
  return {kind: "file", fileId: decodeURIComponent(value)};
}

function scopeRoot(scope: DriveBindingScope): DriveObservation | undefined {
  switch (scope.kind) {
    case "account": return undefined;
    case "folder": return {kind: "folder", fileId: scope.folderId};
    case "file": return {kind: "file", fileId: scope.fileId};
  }
}

/** Creates the observer tracker for one Drive binding. */
export function driveObserverTracker<V>(
  kv: ObserverKv,
  scope: DriveBindingScope,
  verifyBatch: (
    verifier: V,
    observations: DriveObservation[],
  ) => Promise<ObserverBatchResult>,
): ObserverTracker<DriveObservation, V> {
  let root = scopeRoot(scope);
  if (root) {
    let key = `${DRIVE_OBSERVATION_PREFIX}${encodeObservation(root)}`;
    if (kv.get(key) === undefined) kv.put(key, "observed");
  }
  return new ObserverTracker<DriveObservation, V>(kv, {
    setPrefix: DRIVE_OBSERVATION_PREFIX,
    encode: encodeObservation,
    decode: decodeObservation,
    verifyBatch,
    baselineDeniedMessage: DRIVE_BASELINE_DENIED_MESSAGE,
    deniedMessage: () => "This collaborator cannot access Drive data this workspace has read.",
    maxTrackedSets: 2000,
  });
}
