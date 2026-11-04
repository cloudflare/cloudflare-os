// What the account Durable Object shares with the rest of the Worker: the stored grant, its public
// projection, the pinned Canva identity, and a credential source over one account. Kept apart from
// canva.ts so the action and normalizer modules can use them without an import cycle.

import { CredentialSource, type AccountCredentialStub } from "@gadgets/gatekeeper-kit/credentials";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { CanvaApi, CanvaApiError } from "./canva-api";

export const VENDOR_ID = "canva";

/** What the gadget is told when the connection no longer works. */
export const RECONNECT_MESSAGE =
  "The Canva connection has expired or was revoked. Reconnect the Canva account in the Workshop.";

/**
 * The stored grant. Canva rotates the refresh token on every refresh; it never crosses the account
 * boundary.
 */
export type CanvaGrant = {
  accessToken: string;
  refreshToken: string;
  /** Absolute access-token expiry in epoch milliseconds. */
  expiresAt?: number;
  scopes: string[];
};

/** What a facet sees of the grant. */
export type PublicGrant = { accessToken: string; expiresAt?: number; scopes: string[] };

/**
 * The Canva user a connection is pinned to, read when it was made. A reconnect by a different Canva
 * user is refused, so this is the stable authority every action is fenced on.
 */
export type StoredIdentity = {
  userId: string;
  teamId: string;
  displayName: string;
  fetchedAt: number;
};

/** The Canva gatekeeper's own methods on its verifier, which the overseer hands back only to us. */
export interface CanvaVerifierApi extends GatekeeperUserVerifier {
  /** The Canva user the observer's connection is pinned to, or null when it is unusable. */
  getTeamUser(): Promise<{ userId: string; teamId: string } | null>;
}

/** Whether Canva refused the presented credentials. 403 is a scope or plan problem, not this. */
export function isCanvaAuthError(error: unknown): boolean {
  return error instanceof CanvaApiError && error.isAuthError;
}

/** Credentials for one account, as a facet or entrypoint reads them. */
export function accountSource(account: () => AccountCredentialStub<PublicGrant>): CredentialSource<PublicGrant> {
  return new CredentialSource<PublicGrant>({
    // A fresh stub per read: a source can outlive the request that made it.
    account,
    isAuthError: isCanvaAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });
}

/** Reads who a freshly minted access token belongs to. */
export async function fetchIdentity(accessToken: string): Promise<StoredIdentity> {
  const api = new CanvaApi(async () => accessToken);
  const [me, profile] = await Promise.all([api.getCurrentUser(), api.getProfile()]);
  return {
    userId: me.team_user.user_id,
    teamId: me.team_user.team_id,
    displayName: profile.profile.display_name,
    fetchedAt: Date.now(),
  };
}
