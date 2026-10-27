// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the pinned identity, the verifier's API, and a credential source over one account. Kept apart
// from microsoft.ts so the facet and configurator modules can use them without an import cycle.

import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { isGraphAuthError } from "./graph-api";
import { VENDOR_ID } from "./microsoft-env";

/** What the gadget is told when the connection no longer works. */
export const RECONNECT_MESSAGE =
  "The Microsoft 365 connection has expired or was revoked. Reconnect the Microsoft 365 account.";

/** What a facet sees of the grant: refresh material never crosses the account boundary. */
export type PublicGrant = { accessToken: string; expiresAt?: number; scopes: string[] };

/**
 * The Microsoft 365 user a connection is pinned to. `tenantId` and `objectId` are the immutable
 * pair Entra ID identifies a user by; the name, UPN and email can all change and are display only.
 */
export type StoredIdentity = {
  tenantId: string;
  objectId: string;
  name: string;
  /** The user principal name, e.g. `ada@contoso.com`. */
  username?: string;
  email?: string;
  /**
   * The tenant's SharePoint name (`contoso` for contoso.sharepoint.com), read from the root site.
   * Absent for a user with no SharePoint license.
   */
  sharePointTenant?: string;
  fetchedAt: number;
};

/**
 * A collaborator as their own connection proves them: their tenant and user, and their mailbox's
 * primary SMTP address, read from Graph with their own token (absent for a user with no mailbox).
 */
export type VerifiedIdentity = { tenantId: string; objectId: string; email?: string };

/** This gatekeeper's methods on its own verifier; the overseer hands the verifier back only to this gatekeeper. */
export interface MicrosoftVerifierApi extends GatekeeperUserVerifier {
  /**
   * The observer's tenant, user and address, or null when their connection is unusable or reaches
   * none of the resources. A credential that no longer works answers null, not a stale identity.
   */
  getIdentity(): Promise<VerifiedIdentity | null>;
  /**
   * Whether the observer's own account can open each access unit (see sharepoint-observers.ts,
   * outlook-observers.ts and calendar-observers.ts). Exactly one verdict per unit.
   */
  canAccess(units: string[]): Promise<boolean[]>;
}

/** Credentials for the account behind `userObjectId`, as a facet or entrypoint reads them. */
export function accountSource(exports: Cloudflare.Exports, userObjectId: string): CredentialSource<PublicGrant> {
  return new CredentialSource<PublicGrant>({
    // A fresh stub per read: a source can outlive the request that made it.
    account: () => exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId)),
    isAuthError: isGraphAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });
}
