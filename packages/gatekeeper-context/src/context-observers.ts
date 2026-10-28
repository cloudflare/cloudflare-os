// The Workshop tracks the Context Library's observers itself (docs/observers.md §10). A read's
// subresources are the collections whose contents it revealed, each named by its ID: every
// document and skill in a collection shares its access, and a binding reads only its own sharing
// domain, so the ID alone tells the binding what to check.

import { asVerifier, ObserverTracker, type ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { VENDOR_ID } from "./context-types.js";

/**
 * The non-standard method Context gatekeepers call on their own verifier. The overseer only passes
 * a verifier back to the vendor that minted it, so the gatekeeper may trust this result.
 */
export interface ContextVerifierApi extends GatekeeperUserVerifier {
  /** One verdict per collection ID: whether this account can read that collection. */
  hasCollectionsAccess(sharingDomain: string, collectionIds: string[]): Promise<boolean[]>;
  /**
   * The account's ID, so a collection can be shared with the person a user-picker ticket names.
   * Null for any other sharing domain, which this account has no collections in.
   */
  getAccountId(sharingDomain: string): Promise<string | null>;
}

/** The IDs of the `observers` whose Context account can read every one of `collectionIds` now. */
export async function observersWithAccess(
    sharingDomain: string, observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    collectionIds: string[]): Promise<string[]> {
  let unique = [...new Set(collectionIds)];
  let allowed = await Promise.all(observers.map(async ({ id, verifier }) => {
    let access = await asVerifier<Fetcher<ContextVerifierApi>>(verifier)
      .hasCollectionsAccess(sharingDomain, unique);
    // A verdict is tied to its collection only by position, so a ragged answer grants nothing.
    return access.length === unique.length && unique.every((_, index) => access[index] === true)
      ? id : null;
  }));
  return allowed.filter(id => id !== null);
}

// Where the gatekeeper-kit tracker the binding used before kept a marker for each collection a read
// revealed. Never deleted: the Workshop may ask for the export again until it commits the import.
const LEGACY_COLLECTION_PREFIX = "observedCollection:";

/**
 * Every collection the binding's reads revealed while it tracked its observers itself. A marker of
 * any state counts: a "pending" one belongs to a read whose authorization outcome the tracker never
 * learned, so the Workshop may have disclosed it.
 */
export function legacyObservedCollections(kv: ObserverKv): string[] {
  return Array.from(kv.list({ prefix: LEGACY_COLLECTION_PREFIX }), ([key]) =>
    key.slice(LEGACY_COLLECTION_PREFIX.length));
}

/** Drops the registration, and any admission in flight, the binding's own tracker kept for `id`. */
export function retireLegacyObserver(kv: ObserverKv, id: string): void {
  new ObserverTracker({
    kv,
    collectionPrefix: LEGACY_COLLECTION_PREFIX,
    // Only its storage layout is still used: the Workshop checks every observer now.
    hasCollectionAccess: () =>
      Promise.reject(new Error("Skills observers are verified by the Workshop.")),
    vendorId: VENDOR_ID,
  }).removeObserver(id);
}
