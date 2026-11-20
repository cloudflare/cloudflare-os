// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the connected identity, the verifier's own methods, and
// a credential source over one account. Kept apart from acme-account.ts so the facet and
// configurator modules can use them without an import cycle.

import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { isAuthError, type WireUser } from "./acme-api";
import { VENDOR_ID } from "./acme-env";

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

/** The gatekeeper's own methods on its verifier, which the overseer hands back only to us. */
export interface AcmeVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether the observer's own connection can read each subresource, in order (see
   * `UserAccount.checkSubresourceAccess`). Throws for an ID it can't check, or when access can't
   * be determined.
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}
