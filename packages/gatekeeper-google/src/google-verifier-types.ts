// The verifier interface the Google gatekeepers call on their own `GatekeeperUserVerifier`.
//
// `GatekeeperUserVerifier` is an opaque token with no methods of its own, so each vendor extends
// it with the questions its gatekeepers need answered about a prospective observer. The overseer
// only ever hands a verifier back to a gatekeeper of the same vendor, which is what makes the
// cast in each `addObserver()` safe.
//
// It lives in its own module so that a gatekeeper implemented outside google.ts (Chat) can name
// the interface without importing the module that implements it, which also re-exports it.

import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { ObserverBatchResult } from "./observers";
import type { DriveObservation } from "./drive-observers";

/**
 * Non-standard methods implemented by `GoogleVerifier`, each answered with the *observer's* own
 * Google credentials. Every one returns false for "cannot see it" and throws for a transient
 * failure, so an outage fails an open loudly rather than silently denying a collaborator.
 */
export interface GoogleVerifierApi extends GatekeeperUserVerifier {
  hasDocAccess(documentId: string): Promise<boolean>;
  hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean>;
  hasCalendarWriterAccess(calendarId: string): Promise<boolean>;
  hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean>;
  hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean>;
  /** Whether the observer's own account can open one Google Chat space. */
  hasChatSpaceAccess(spaceName: string): Promise<boolean>;
  verifyDriveObservations(observations: DriveObservation[]): Promise<ObserverBatchResult>;
}
