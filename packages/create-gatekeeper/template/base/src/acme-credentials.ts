// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the connected identity, the subresource IDs every read reports, the verifier's own methods, and
// a credential source over one account. Kept apart from acme-account.ts so the facet and
// configurator modules can use them without an import cycle.

import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { isAuthError, type WireUser } from "./acme-api";
import { VENDOR_ID } from "./acme-env";
import { ITEM_ID } from "./acme-urls";

/** What the gadget is told when the connection no longer works. */
export const RECONNECT_MESSAGE =
  "The Acme Service connection has expired or was revoked. Reconnect the Acme Service account.";

/** What a facet sees of the grant: nothing that could mint a new credential crosses the account boundary. */
export type PublicGrant = { accessToken: string; expiresAt?: number };

/** The connected user, as the account last read them. */
export type Identity = {
  userId: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  fetchedAt: number;
};

/** The stored identity for what the provider said about the grant's user. */
export function identityOf(user: WireUser): Identity {
  return {
    userId: user.id,
    name: user.name,
    ...(user.email ? { email: user.email } : {}),
    ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
    fetchedAt: Date.now(),
  };
}

/** The `UserAccount` holding the connection `userObjectId` names. */
export const accountStub = (exports: Cloudflare.Exports, userObjectId: string) =>
  exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId));

/** Credentials for the account behind `userObjectId`, as a facet or entrypoint reads them. */
export function accountSource(exports: Cloudflare.Exports, userObjectId: string): CredentialSource<PublicGrant> {
  return new CredentialSource<PublicGrant>({
    // A fresh stub per read: a source can outlive the request that made it.
    account: () => accountStub(exports, userObjectId),
    isAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });
}

// ---------------------------------------------------------------------------
// Subresources

// STOP(subresources): What a read depends on, as IDs an observer's own connection can be asked
// about. Qualify every ID with its tenant (organization, workspace, instance) unless the deployed
// Worker's configuration fixes one: `item/<id>` alone lets an observer in another tenant be
// allowed for a different item with the same ID. Refuse another tenant's IDs in
// `verifyObserverAccess()`. Report every dependency on every read: the tenant too, where
// membership in it is required besides the object's own permissions. `[]` means "nothing restricts this", never
// "the binding already checked".
/** The subresource ID of one item, `item/<id>`. */
export function itemSubresourceId(itemId: string): string {
  return formatSubresourceId({ fragments: [{ name: "item", id: itemId }] });
}

/**
 * The item an {@link itemSubresourceId} ID names.
 * @throws Error for any other ID, or a spelling other than the canonical one.
 */
export function parseSubresource(id: string): { itemId: string } {
  const { namespace, fragments: [item, ...rest] } = parseSubresourceId(id);
  if (namespace !== undefined || rest.length > 0 || item?.name !== "item" || !ITEM_ID.test(item.id)) {
    throw new Error("Not an Acme Service subresource ID.");
  }
  return { itemId: item.id };
}

/** The gatekeeper's own methods on its verifier, which the overseer hands back only to us. */
export interface AcmeVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether the observer's own connection can read each subresource, in order (see
   * `UserAccount.checkSubresourceAccess`). Throws for an ID it can't check, or when access can't
   * be determined.
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}
