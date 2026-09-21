import type { DriveBindingScope } from "./drive-session";
import { ObserverTracker, type ObserverBatchResult, type ObserverKv } from "./observers";

/** Key prefix for the Drive file IDs a binding has disclosed metadata about. */
export const DRIVE_OBSERVATION_PREFIX = "observedDriveFile:";

/** Refusal when a joining collaborator holds no Google Drive grant at all. */
export const DRIVE_BASELINE_DENIED_MESSAGE =
  "This collaborator has not granted Google Drive access, so they cannot observe this binding.";

function scopeRootId(scope: DriveBindingScope): string | undefined {
  switch (scope.kind) {
    case "account": return undefined;
    case "sharedDrive": return scope.driveId;
    case "file": return scope.fileId;
  }
}

/**
 * The observer tracker for one Drive binding, seeded with the set its scope already names.
 *
 * A shared-drive or single-file binding can always reach its own root, so that ID is recorded up
 * front rather than waiting for a read to discover it. A file binding therefore never grows past
 * it because its session admits no other ID. This lets all three scopes share one admission path.
 * Without the seed a file binding would need a second, hand-rolled verify kept in step by hand with
 * this one's staging and rollback.
 *
 * `verifyBatch` is passed in rather than a verifier type, so this module stays independent of the
 * worker entrypoint that owns the RPC interface.
 */
export function driveObserverTracker<V>(
  kv: ObserverKv,
  scope: DriveBindingScope,
  verifyBatch: (verifier: V, fileIds: readonly string[]) => Promise<ObserverBatchResult>,
): ObserverTracker<string, V> {
  let rootId = scopeRootId(scope);
  if (rootId !== undefined) {
    let key = `${DRIVE_OBSERVATION_PREFIX}${encodeURIComponent(rootId)}`;
    if (kv.get(key) === undefined) kv.put(key, "observed");
  }
  return new ObserverTracker<string, V>(kv, {
    setPrefix: DRIVE_OBSERVATION_PREFIX,
    encode: encodeURIComponent,
    decode: decodeURIComponent,
    verifyBatch,
    baselineDeniedMessage: DRIVE_BASELINE_DENIED_MESSAGE,
    deniedMessage: fileId =>
      `This collaborator cannot access Drive file ${fileId}, whose metadata this workspace has read.`,
    // checkFileAccess issues ceil(N/100) sequential subrequests. The overseer re-runs addObserver
    // on every open, per observer, at concurrency 6. 2000 files → 20 subrequests per observer, 120
    // if six run together — well inside the 1000-subrequest budget. Uncapped, a whole-account
    // binding would grow until admission exceeds that budget and locks every collaborator out.
    maxTrackedSets: 2000,
  });
}
