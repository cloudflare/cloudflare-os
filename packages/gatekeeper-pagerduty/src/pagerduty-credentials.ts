// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the connected identity, the subresource IDs every read reports, the verifier's own methods, and
// a credential source over one account. Kept apart from pagerduty.ts so the facet and configurator
// modules can use them without an import cycle.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { isAuthError } from "./pagerduty-api";
import { ID_TOKEN_ISSUER, ID_TOKEN_JWKS_URL, VENDOR_ID, type Region, type Tenant } from "./pagerduty-env";
import { toUser, type WireUser } from "./pagerduty-normalize";
import { OBJECT_ID, regionOf } from "./pagerduty-urls";
import type { PagerDutyUser } from "./types";

/** What the gadget is told when the connection no longer works. */
export const RECONNECT_MESSAGE =
  "The PagerDuty connection has expired or was revoked. Reconnect the PagerDuty account.";

/** What a facet sees of the grant: the refresh token never crosses the account boundary. */
export type PublicGrant = { accessToken: string; expiresAt?: number };

/** The user and account a grant belongs to, as the ID token named them. */
export type GrantIdentity = Tenant & { userId: string; accountId: string };

/** The connected user, as the account last read them. */
export type Identity = GrantIdentity & {
  name: string;
  email: string;
  /** The user's base role, e.g. `user` or `read_only_limited_user`; empty if PagerDuty named none. */
  role: string;
  jobTitle: string | null;
  timeZone: string;
  htmlUrl: string;
  avatarUrl?: string;
  fetchedAt: number;
};

/**
 * Base roles that see the account's incidents and services. PagerDuty's other two see none,
 * whatever teams allow: a Limited Stakeholder (`read_only_limited_user`) sees only status pages,
 * and Restricted Access only what a team or object role grants, which no account-level read
 * relies on.
 */
const SIGHTED_ROLES = ["owner", "admin", "user", "limited_user", "observer", "read_only_user"];

/**
 * Whether a user with base role `role` can see the account's public objects: not one whose role
 * PagerDuty left out, or added since.
 */
export function seesPublicObjects(role: string): boolean {
  return SIGHTED_ROLES.includes(role);
}

/** The connected user as `getMetadata().you` reports them. */
export function youOf(identity: Identity): PagerDutyUser {
  return {
    id: identity.userId,
    name: identity.name,
    email: identity.email,
    jobTitle: identity.jobTitle,
    timeZone: identity.timeZone,
    htmlUrl: identity.htmlUrl,
  };
}

/** The stored identity for a grant, with what `GET /users/me` said about its user. */
export function identityOf(grant: GrantIdentity, user: WireUser): Identity {
  if (user.id !== grant.userId) throw new Error("PagerDuty described a different user than the grant's.");
  const { name, email, jobTitle, timeZone, htmlUrl } = toUser(user);
  return {
    ...grant, name, email, jobTitle, timeZone, htmlUrl,
    role: user.role ?? "",
    ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
    fetchedAt: Date.now(),
  };
}

const JWKS = createRemoteJWKSet(new URL(ID_TOKEN_JWKS_URL));

/**
 * Which user, account and region an ID token, as the token endpoint returned it, names. Its
 * signature (RS256, against PagerDuty's published keys), issuer, expiry and audience, which
 * includes the app's client ID, are checked.
 * @throws Error for a token that does not verify or lacks a claim.
 */
export async function verifyIdToken(idToken: string, clientId: string): Promise<GrantIdentity> {
  const { payload } = await jwtVerify(idToken, JWKS, { issuer: ID_TOKEN_ISSUER, audience: clientId, algorithms: ["RS256"] });
  const { user_id: userId, account_id: accountId, subdomain } = payload;
  const region = regionOf(payload as { aud?: string | string[]; region?: unknown });
  if (typeof userId !== "string" || typeof accountId !== "string" || typeof subdomain !== "string"
      || !OBJECT_ID.test(userId) || !OBJECT_ID.test(accountId) || !/^[a-z0-9-]+$/i.test(subdomain) || !region) {
    throw new Error("PagerDuty's ID token did not say which user and account authorized the connection.");
  }
  return { userId, accountId, subdomain: subdomain.toLowerCase(), region };
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

const OBJECT_KINDS = ["team", "service", "incident", "schedule", "escalation_policy"] as const;

/** The objects a read can depend on beyond the account itself. */
export type ObjectKind = typeof OBJECT_KINDS[number];

/** One account, by the region it lives in and PagerDuty's ID for it. */
export type AccountKey = { region: Region; accountId: string };

/** A parsed subresource: the account, or one object in it. */
export type Subresource = AccountKey & { object?: { kind: ObjectKind; id: string } };

/**
 * The subresource ID of an account, `region/<region>/account/<id>`, or of one object in it,
 * `region/<region>/account/<id>/<kind>/<objectId>`. Every read reports the account, which only
 * an observer connected to the same account with a role that sees its public objects may see.
 */
export function subresourceId(account: AccountKey, object?: { kind: ObjectKind; id: string }): string {
  return formatSubresourceId({
    fragments: [
      { name: "region", id: account.region },
      { name: "account", id: account.accountId },
      ...(object ? [{ name: object.kind, id: object.id }] : []),
    ],
  });
}

/**
 * The account and object a {@link subresourceId} ID names.
 * @throws Error for any other ID, or a spelling other than the canonical one.
 */
export function parseSubresource(id: string): Subresource {
  const { namespace, fragments: [region, account, object, ...rest] } = parseSubresourceId(id);
  if (namespace !== undefined || rest.length > 0 || region?.name !== "region"
      || (region.id !== "us" && region.id !== "eu") || account?.name !== "account" || !OBJECT_ID.test(account.id)
      || (object && (!OBJECT_KINDS.includes(object.name as ObjectKind) || !OBJECT_ID.test(object.id)))) {
    throw new Error("Not a PagerDuty subresource ID.");
  }
  const key: AccountKey = { region: region.id, accountId: account.id };
  return object ? { ...key, object: { kind: object.name as ObjectKind, id: object.id } } : key;
}

/** The PagerDuty gatekeeper's own methods on its verifier, which the overseer hands back only to us. */
export interface PagerDutyVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether the observer's own connection can read each subresource, in order (see
   * `UserAccount.checkSubresourceAccess`). Throws for an ID it can't check, or when access can't
   * be determined.
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}
