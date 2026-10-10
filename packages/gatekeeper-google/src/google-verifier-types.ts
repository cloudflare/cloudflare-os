// The verifier interface the Google gatekeepers call on their own `GatekeeperUserVerifier`.
//
// `GatekeeperUserVerifier` is an opaque token with no methods of its own, so each vendor extends
// it with what its gatekeepers need: answers about a prospective observer, and for applyCreation()
// the account a creation was approved into. The overseer only ever hands a verifier back to a
// gatekeeper of the same vendor, which is what makes the cast in each `addObserver()` and in
// `createFileOnce()` safe.
//
// It lives in its own module so that a gatekeeper implemented outside google.ts (Chat) can name
// the interface without importing the module that implements it, which also re-exports it.

import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { ObserverBatchResult } from "./observers";
import type { DriveObservation } from "./drive-observers";

/**
 * Non-standard methods implemented by `GoogleVerifier`. Each access check is answered with the
 * *observer's* own Google credentials, returning false for "cannot see it" and throwing for a
 * transient failure, so an outage fails an open loudly rather than silently denying a collaborator.
 */
export interface GoogleVerifierApi extends GatekeeperUserVerifier {
  hasDocAccess(documentId: string): Promise<boolean>;
  hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean>;
  hasPresentationAccess(presentationId: string): Promise<boolean>;
  hasCalendarWriterAccess(calendarId: string): Promise<boolean>;
  hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean>;
  hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean>;
  /** Whether the observer's own account can open one Google Chat space, and with `members`, list its members. */
  hasChatSpaceAccess(spaceName: string, options?: { members?: boolean }): Promise<boolean>;
  verifyDriveObservations(observations: DriveObservation[]): Promise<ObserverBatchResult>;
  /**
   * The connected account this verifier stands for, so applyCreation() can create a file in it and
   * bind the result. Unlike the checks above, it asserts nothing about an observer.
   */
  getUserObjectId(): Promise<string>;
}
