// The role Exchange gives someone on one of the connected user's own calendars, read from the
// calendar's sharing list (`calendarPermissions`), as Exchange applies it:
//
// - an entry for the person themselves wins, whatever the default says;
// - otherwise the organization-wide default (`My Organization`) applies to people in the
//   organization, and nobody else;
// - an entry that isn't a person (a group, a distribution list) can't be expanded here, so it can
//   only lower what the default gives, never raise it: whoever is in it may hold that role instead.
//
// Entries are matched on the collaborator's primary SMTP address, from their own verified
// connection. Someone listed under an alias is matched as nobody, which fails closed.

import { sharingRole, SHARING_ROLES, type SharingRole } from "./calendar-scope";
import type { GraphCalendarPermission } from "./calendar-graph";
import type { VerifiedIdentity } from "./microsoft-credentials";
import type { OwnerAcl } from "./calendar-observers";

/** What the ACL reader needs from the binding owner's side. */
export type AclSource = {
  /** One of the owner's calendars' sharing list, as the owner reads it. */
  permissions(calendarId: string): Promise<GraphCalendarPermission[]>;
  /** Whether an address is a person in the directory (rather than a group, list or contact). */
  isPerson(address: string): Promise<boolean>;
  /** The organization's verified domains. */
  orgDomains(): Promise<readonly string[]>;
};

function lower(a: SharingRole, b: SharingRole): SharingRole {
  return SHARING_ROLES.indexOf(a) <= SHARING_ROLES.indexOf(b) ? a : b;
}

/** Whether an address is in one of the organization's domains: a member, not a guest from elsewhere. */
export function inOrganization(address: string | undefined, domains: readonly string[]): boolean {
  if (address === undefined) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domains.some(owned => owned.toLowerCase() === domain);
}

/** The role a sharing list gives someone: see the module comment. */
export async function roleIn(permissions: readonly GraphCalendarPermission[], observer: VerifiedIdentity, source: Pick<AclSource, "isPerson" | "orgDomains">): Promise<SharingRole> {
  const address = observer.email?.toLowerCase();
  // Someone with no mailbox has no calendar access in Outlook at all.
  if (address === undefined) return "none";
  const own = permissions.find(entry => entry.address === address);
  if (own) return sharingRole(own.role);
  const fallback = permissions.find(entry => entry.address === undefined && entry.insideOrganization && !entry.removable);
  if (fallback === undefined || !inOrganization(address, await source.orgDomains())) return "none";
  let role = sharingRole(fallback.role);
  for (const entry of permissions) {
    if (entry.address === undefined || !entry.insideOrganization || role === "none") continue;
    if (!(await source.isPerson(entry.address))) role = lower(role, sharingRole(entry.role));
  }
  return role;
}

/** The owner's ACL reader for the observer strategy. */
export function ownerAcl(source: AclSource): OwnerAcl {
  return {
    roleOf: async (calendarId, observer) => await roleIn(await source.permissions(calendarId), observer, source),
  };
}
