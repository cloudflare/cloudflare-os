import {
  trackedCollectionObservers, type ObserverKv, type ObserverStrategy,
} from "@gadgets/gatekeeper-kit/observers";
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

/**
 * Shown to a collaborator refused admission. It must not name the collection: the collaborator
 * cannot read it, and a private collection's title is its members' data.
 */
export const CONTEXT_OBSERVER_DENIED =
  "This workspace has read from a Skills collection that hasn't been shared with your account, so " +
  "you can't open it. Only collaborators who can read every collection the workspace has used may " +
  "open it.";

/**
 * Strategy C for the broad Context Library singleton. Collections are the data sets: public
 * collections are domain-wide; private collections admit their grantees and, when enabled, everyone
 * in the sharing domain. The prefix keeps markers recorded before this tracker moved to the kit.
 */
export function contextObserverStrategy(kv: ObserverKv, sharingDomain: string): ObserverStrategy {
  return trackedCollectionObservers<Fetcher<ContextVerifierApi>>({
    kv,
    collectionPrefix: "observedCollection:",
    hasCollectionAccess: (verifier, collectionIds) =>
      verifier.hasCollectionsAccess(sharingDomain, [...collectionIds]),
    denyMessage: () => CONTEXT_OBSERVER_DENIED,
    vendorId: VENDOR_ID,
  });
}
