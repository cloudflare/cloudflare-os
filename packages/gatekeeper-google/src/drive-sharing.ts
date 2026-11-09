/**
 * Approval-backed Drive sharing: who has access to a file, what a queued change of it carries, how
 * it is described, how an approved one is made, and how a listing shows the changes still awaiting
 * a decision.
 *
 * Drive lists one permission per grantee, with a detail for each source of its access. Only what is
 * given on the file itself is changed here, so every rule compares the role a permission gives on
 * the file with the highest one a parent gives. A change is held, when it is applied, to the state
 * its approval described: the grantee's role and, for a domain's or anyone's access, whether it can
 * be found by searching.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, type ActionDefinition, type JournalEntry,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, codeSpan, type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  isDrivePermissionId, isFileInvisible, isInsufficientScope, type DriveApi,
  type DrivePermissionGrant, type DrivePermissionRecord,
} from "./drive-api";
import type {
  DriveAccess, DriveGrantee, DriveRole, DriveShareOptions, DriveShareRole,
} from "./drive-types";
import {
  addressDomain, driveRefusal, pendingId, proveTarget, requireWritable, sendOnce,
  WRITES_GRANT_MISSING, type DriveActor, type DriveWritesHost, type DriveWriteTargetPayload,
  type QueuedWrite, type RefusalRow,
} from "./drive-writes";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.sharing", vendorId: "google",
});

/** Roles, lowest first, for comparing what someone has with what is asked. */
export const ROLE_RANK: Record<DriveRole, number> = {
  reader: 0, commenter: 1, writer: 2, fileOrganizer: 3, organizer: 4, owner: 5,
};

/** Whether `role` is one that can be given: `writer` or below. */
function isShareRole(role: DriveRole): role is DriveShareRole {
  return ROLE_RANK[role] <= ROLE_RANK.writer;
}

/** The highest of `roles`, if there is one. */
function highest(roles: readonly DriveRole[]): DriveRole | undefined {
  return roles.reduce<DriveRole | undefined>(
    (top, role) => top === undefined || ROLE_RANK[role] > ROLE_RANK[top] ? role : top, undefined);
}

/**
 * What a permission gives, for the rules that compare roles: the role given on the file itself,
 * and the highest role any parent gives, if either.
 */
export function accessOf(
  permission: DrivePermissionRecord,
): { direct?: DriveRole; inherited?: DriveRole } {
  let direct = highest(
    permission.details.filter(detail => !detail.inherited).map(detail => detail.role));
  let inherited = highest(
    permission.details.filter(detail => detail.inherited).map(detail => detail.role));
  return { ...(direct ? { direct } : {}), ...(inherited ? { inherited } : {}) };
}

/** The shape every grantee has, as given, as stored and as Drive lists one. */
type GranteeLike = { type: DriveGrantee["type"]; emailAddress?: string; domain?: string };

/** Whether access of this kind is given to an address: a user's or a group's. */
function isAddressed(type: DriveGrantee["type"]): type is "user" | "group" {
  return type === "user" || type === "group";
}

/** Whether a domain's or anyone's permission can be found by searching, as a payload records it. */
function reachOf(permission: DrivePermissionRecord): Reach {
  return !isAddressed(permission.type) && permission.allowFileDiscovery === true
    ? { discoverable: true } : {};
}

/**
 * A file's permissions as the agent sees them: one entry per detail, a permission's inherited
 * ones first. `me` is the connected account's Drive permission ID, whose entries are marked.
 */
export function toAccessEntries(
  permissions: readonly DrivePermissionRecord[], me: string,
): DriveAccess[] {
  return permissions.flatMap((permission): DriveAccess[] => {
    // The account behind it is gone, so it is nobody's access.
    if (permission.deleted) return [];
    let { id, type, emailAddress, displayName, domain, allowFileDiscovery } = permission;
    let grantee = {
      id, type,
      ...(emailAddress === undefined ? {} : { emailAddress }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(domain === undefined ? {} : { domain }),
      ...(isAddressed(type) || allowFileDiscovery === undefined
        ? {} : { discoverable: allowFileDiscovery }),
      ...(type === "user" && id === me ? { me: true as const } : {}),
    };
    return [
      ...permission.details.filter(detail => detail.inherited).map(detail => ({
        ...grantee, role: detail.role, inherited: true as const,
        ...(detail.inheritedFrom === undefined ? {} : { inheritedFrom: detail.inheritedFrom }),
      })),
      ...permission.details.filter(detail => !detail.inherited)
        .map(detail => ({ ...grantee, role: detail.role })),
    ];
  });
}

/** Most pages of permissions one read takes: 100 permissions a page. */
const MAX_PERMISSION_PAGES = 10;

/** A file whose permissions fill more pages than one read takes. */
export class PermissionListTooLong extends Error {
  constructor() {
    super("This file is shared with more people than can be listed here.");
  }
}

/** Every permission of a file, page by page. */
export async function readPermissions(
  api: Pick<DriveApi, "listPermissions">, fileId: string,
): Promise<DrivePermissionRecord[]> {
  let permissions: DrivePermissionRecord[] = [];
  let seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PERMISSION_PAGES; page++) {
    let result = await api.listPermissions(fileId, pageToken === undefined ? {} : { pageToken });
    permissions.push(...result.permissions);
    pageToken = result.nextPageToken;
    if (pageToken === undefined) return permissions;
    // A token handed back twice would be read until the page limit and prove nothing more.
    if (seen.has(pageToken)) break;
    seen.add(pageToken);
  }
  throw new PermissionListTooLong();
}

/** A grantee as Drive listed them when a change was queued, for the approver. */
export type GranteeSnapshot = {
  type: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  displayName?: string;
  domain?: string;
};

/** Whether a domain's or anyone's access can be found by searching: state a change is held to. */
export type Reach = { discoverable?: true };

/** What makes a share or a raise loud: who it reaches beyond named people inside the domain. */
export type Audience = Reach & {
  /**
   * The connected account's own domain, when the grantee's address or domain is outside it, or
   * when Drive does not show the grantee's address, so that it may be.
   */
  outsideDomain?: string;
  /** A user or group whose address Drive does not show. */
  addressHidden?: true;
  /**
   * A user or group whose address could not be compared, because Drive gave no address for the
   * connected account itself.
   */
  accountAddressUnknown?: true;
};

/**
 * Each Drive sharing change, by the action kind it is queued as. Every field is one its approval
 * shows or its apply checks, and applying writes none.
 */
export type DriveSharingActions = {
  createPermission: DriveWriteTargetPayload & Audience & {
    /** The target is a folder, so the change reaches what it holds. */
    isFolder?: true;
    /** As given, trimmed; a domain in lower case. */
    grantee: DriveGrantee;
    role: DriveShareRole;
    /** Users and groups: absent means Google emails them. */
    notify?: false;
    message?: string;
    /** What a parent already gives the grantee, which `role` is above. */
    inheritedRole?: DriveRole;
  };
  updatePermission: DriveWriteTargetPayload & Audience & {
    /** The target is a folder, so the change reaches what it holds. */
    isFolder?: true;
    /** The ID the approval shows and the change is sent to. */
    permissionId: string;
    grantee: GranteeSnapshot;
    fromRole: DriveShareRole;
    toRole: DriveShareRole;
    /** What a parent also gives the grantee, which the change leaves as it is. */
    inheritedRole?: DriveRole;
  };
  deletePermission: DriveWriteTargetPayload & Reach & {
    /** The target is a folder, so the change reaches what it holds. */
    isFolder?: true;
    /** The ID the approval shows and the change is sent to. */
    permissionId: string;
    grantee: GranteeSnapshot;
    /** The role given on the file, which is removed. */
    role: DriveShareRole;
    /** What a parent also gives the grantee, which stays. */
    inheritedRole?: DriveRole;
  };
};

/** One queued Drive sharing change. */
export type DriveSharingAction = TaggedAction<DriveSharingActions>;

/** The keys a grantee of each kind has. */
const GRANTEE_KEYS: Record<DriveGrantee["type"], readonly string[]> = {
  user: ["type", "emailAddress"],
  group: ["type", "emailAddress"],
  domain: ["type", "domain"],
  anyone: ["type"],
};

/** The options `share()` has. */
const SHARE_OPTION_KEYS: readonly string[] = ["notify", "message", "discoverable"];

/** Longest address taken, in characters. */
const MAX_ADDRESS_CHARS = 254;
/** Longest message Google's email carries, in characters. */
const MAX_MESSAGE_CHARS = 1000;

/** One `@` with text on both sides and no white space. */
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+$/;
/** Dot-separated labels of letters, digits and hyphens, with at least one dot. */
const DOMAIN_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** A key short and plain enough to repeat in a refusal. */
const NAMEABLE_KEY = /^[A-Za-z_$][\w$]{0,31}$/;

/**
 * The own keys of `value` that carry a value. The RPC delivers a key set to `undefined`, as code
 * that copies an entry's fields into a grantee writes one, and such a key is none.
 */
function presentKeys(value: object): string[] {
  return Object.entries(value).filter(([, held]) => held !== undefined).map(([key]) => key);
}

/** A key as a refusal names it, so that no message carries an arbitrary string. */
function namedKey(key: string): string {
  return NAMEABLE_KEY.test(key) ? key : "that key";
}

/**
 * A grantee, checked and normalized; throws, saying why, for one that is not well formed. A key
 * its kind does not have is refused, since untyped callers reach this and one could carry intent
 * that nothing here serves.
 */
export function checkGrantee(grantee: DriveGrantee): DriveGrantee {
  let known = GRANTEE_KEYS[grantee.type];
  let extra = presentKeys(grantee).find(key => !known.includes(key));
  if (extra !== undefined) {
    throw new Error(`A grantee of type ${grantee.type} has no ${namedKey(extra)}.`);
  }
  switch (grantee.type) {
    case "user":
    case "group": {
      let emailAddress = grantee.emailAddress.trim();
      if (emailAddress.length > MAX_ADDRESS_CHARS || !ADDRESS_PATTERN.test(emailAddress)) {
        throw new Error("Not an email address.");
      }
      return { type: grantee.type, emailAddress };
    }
    case "domain": {
      let domain = grantee.domain.trim().toLowerCase();
      if (!DOMAIN_PATTERN.test(domain)) throw new Error("Not a domain name.");
      return { type: "domain", domain };
    }
    case "anyone":
      return { type: "anyone" };
  }
}

/** A share's grantee and options, checked and normalized; throws, saying why, for either. */
export function checkShare(
  grantee: DriveGrantee, options: DriveShareOptions | undefined,
): Pick<
  DriveSharingActions["createPermission"], "grantee" | "notify" | "message" | "discoverable"
> {
  let checked = checkGrantee(grantee);
  let addressed = isAddressed(checked.type);
  let { notify, message, discoverable } = options ?? {};
  if (notify !== undefined && !addressed) {
    throw new Error("notify applies only to a user or a group.");
  }
  if (message !== undefined) {
    if (!addressed || notify === false) {
      throw new Error("message applies only to a user or a group that is emailed.");
    }
    if (!message.trim()) throw new Error("The message is empty.");
    let characters = [...message].length;
    if (characters > MAX_MESSAGE_CHARS) {
      throw new Error(
        `The message is ${characters} characters; at most ${MAX_MESSAGE_CHARS} are sent.`);
    }
  }
  if (discoverable !== undefined && addressed) {
    throw new Error("discoverable applies only to a domain or to anyone.");
  }
  // An option the types do not have, such as an expiry, must not queue a share without it.
  let extra = presentKeys(options ?? {}).find(key => !SHARE_OPTION_KEYS.includes(key));
  if (extra !== undefined) {
    throw new Error(
      `share() has no option ${namedKey(extra)}. Its options are notify, message and ` +
      "discoverable: access given here does not expire, and ownership is not transferred.");
  }
  return {
    grantee: checked,
    ...(notify === false ? { notify: false as const } : {}),
    ...(message === undefined ? {} : { message }),
    ...(discoverable === true ? { discoverable: true as const } : {}),
  };
}

/** The refusal for access named by an entry itself, or by a bare address. */
export const ACCESS_NAME =
  "That does not name access. Pass the id of an entry listAccess() returned, or a grantee: " +
  "{ type: \"user\", emailAddress }, { type: \"group\", emailAddress }, " +
  "{ type: \"domain\", domain } or { type: \"anyone\" }.";

/**
 * Access as `updateAccess()` and `unshare()` name it, checked before Google is asked anything: a
 * Drive access ID, or a grantee, normalized. A `pending:` ID is the session's to answer first.
 */
export function checkAccessName(access: string | DriveGrantee): string | DriveGrantee {
  if (typeof access === "string") {
    // An address where a grantee is meant.
    if (access.includes("@")) throw new Error(ACCESS_NAME);
    if (!isDrivePermissionId(access)) throw new Error("Not a Google Drive access ID.");
    return access;
  }
  // An entry `listAccess()` returned, where its `id` is meant.
  if (presentKeys(access).includes("id")) throw new Error(ACCESS_NAME);
  return checkGrantee(access);
}

/** Whether `held` is `grantee`'s: an address as a user's or a group's alike, ignoring case. */
function isGrantee(held: GranteeLike, grantee: GranteeLike): boolean {
  switch (grantee.type) {
    case "user":
    case "group":
      // Which of the two an address is, is Google's to decide, so either kind matches either.
      return isAddressed(held.type) && held.emailAddress !== undefined &&
        grantee.emailAddress !== undefined &&
        held.emailAddress.toLowerCase() === grantee.emailAddress.toLowerCase();
    case "domain":
      return held.type === "domain" && held.domain !== undefined &&
        grantee.domain !== undefined && held.domain.toLowerCase() === grantee.domain.toLowerCase();
    case "anyone":
      return held.type === "anyone";
  }
}

/**
 * The permissions on a file that are `grantee`'s. A permission Drive lists without an address
 * matches no address, and one whose account was deleted matches nothing.
 */
export function matchGrantee(
  permissions: readonly DrivePermissionRecord[], grantee: GranteeLike,
): DrivePermissionRecord[] {
  return permissions.filter(permission => !permission.deleted && isGrantee(permission, grantee));
}

/** Drive's two IDs for anyone's access. */
const ANYONE_IDS: ReadonlySet<string> = new Set(["anyoneWithLink", "anyone"]);

/**
 * Whether two access IDs name one access: the same ID, or Drive's two IDs for anyone's access,
 * `anyoneWithLink` and `anyone`, which are one permission listed under whichever its form gives.
 */
export function sameAccessId(a: string, b: string): boolean {
  return a === b || (ANYONE_IDS.has(a) && ANYONE_IDS.has(b));
}

/** Mail domains of personal Google accounts, which have no organization to be outside of. */
const PERSONAL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/** Who a change reaches beyond named people inside the connected account's domain. */
export function audienceOf(
  actor: DriveActor, grantee: GranteeLike, discoverable: boolean | undefined,
): Audience {
  if (grantee.type === "anyone") return discoverable === true ? { discoverable: true } : {};
  let own = actor.emailAddress === undefined ? undefined : addressDomain(actor.emailAddress);
  // Mail domains are compared and nothing else: no signal here tells an organization's account
  // from a personal one at another provider.
  let comparable = own !== undefined && !PERSONAL_DOMAINS.has(own) ? own : undefined;
  if (grantee.type === "domain") {
    return {
      ...(discoverable === true ? { discoverable: true as const } : {}),
      ...(comparable !== undefined && grantee.domain?.toLowerCase() !== comparable
        ? { outsideDomain: comparable } : {}),
    };
  }
  if (grantee.emailAddress === undefined) {
    // An address that cannot be placed is never passed as inside.
    return {
      addressHidden: true, ...(comparable === undefined ? {} : { outsideDomain: comparable }),
    };
  }
  // No address for the account leaves nothing to compare with, which is said, not skipped.
  if (own === undefined) return { accountAddressUnknown: true };
  return comparable !== undefined && addressDomain(grantee.emailAddress) !== comparable
    ? { outsideDomain: comparable } : {};
}

/** The refusal for changing the connected account's own access. */
const OWN_ACCESS = "The connected account's own access cannot be changed here.";
/** The refusal for access at a role above `writer`, which nothing here gives or takes. */
const OWNER_OR_MANAGER =
  "An owner's, manager's or content manager's access cannot be changed here.";

/** The refusal for changing access that is still waiting for approval. */
export const ACCESS_WAITING_CHANGE =
  "That access is waiting for approval and has not been given yet. Change its role once it is " +
  "given, or have the user reject it and share again with the role wanted.";
/** The refusal for removing access that is still waiting for approval. */
export const ACCESS_WAITING_REMOVE =
  "That access is waiting for approval and has not been given yet. To withdraw it, have the " +
  "user reject it.";

/** The refusal for a share to a grantee whose share of the same file still waits. */
export const SHARE_PENDING = "That grantee already has access to this file waiting for approval.";
/** The refusal for a change of access that already has one waiting. */
export const CHANGE_PENDING = "That access already has a change waiting for approval.";

/** The refusal for a share to a grantee whose access has a role change or a removal waiting. */
export const SHARE_BEHIND_CHANGE =
  "That grantee's access has a change waiting for approval. Once it is decided, share again " +
  "if the access was removed, or change its role with updateAccess().";

/** The refusal for a `pending:` access ID that names no share waiting for the file asked about. */
const PENDING_ACCESS_SPENT =
  "That pending ID names no access waiting for approval. If it was given, list the file's " +
  "access again and use its Drive ID.";

/** Whether `entry` is a sharing change: one queued under a sharing definition's name. */
function isSharingEntry(entry: QueuedWrite): entry is JournalEntry<DriveSharingAction> {
  return Object.hasOwn(DRIVE_SHARING_DEFINITIONS, entry.action.kind);
}

/** The sharing changes among `pending` that are for file `fileId`. */
function sharingEntries(
  fileId: string, pending: readonly QueuedWrite[],
): JournalEntry<DriveSharingAction>[] {
  return pending.filter(isSharingEntry).filter(({ action }) => action.payload.fileId === fileId);
}

/**
 * The refusal for a `pending:` access ID given to `updateAccess()` (`"change"`) or `unshare()`
 * (`"remove"`) of file `fileId`: its share of that file still waits, or the ID names nothing there.
 */
export function pendingAccessRefusal(
  fileId: string, accessId: string, pending: readonly QueuedWrite[], call: "change" | "remove",
): string {
  // A share that waits for another file is answered as spent: the waiting message would be said
  // of a file the share is not for.
  let waits = sharingEntries(fileId, pending).some(({ id, action }) =>
    action.kind === "createPermission" && pendingId(id) === accessId);
  if (!waits) return PENDING_ACCESS_SPENT;
  return call === "change" ? ACCESS_WAITING_CHANGE : ACCESS_WAITING_REMOVE;
}

/** Whether `pending` holds a change or removal of permission `permissionId` on file `fileId`. */
export function hasPendingChange(
  fileId: string, permissionId: string, pending: readonly QueuedWrite[],
): boolean {
  return sharingEntries(fileId, pending).some(({ action }) =>
    action.kind !== "createPermission" && sameAccessId(action.payload.permissionId, permissionId));
}

/** Whether `pending` holds a share of file `fileId` with `grantee`. */
export function hasPendingShare(
  fileId: string, grantee: DriveGrantee, pending: readonly QueuedWrite[],
): boolean {
  return sharingEntries(fileId, pending).some(({ action }) =>
    action.kind === "createPermission" && isGrantee(action.payload.grantee, grantee));
}

/** The refusal for a share to a grantee who has `role` given on the file itself. */
function alreadyGiven(type: DriveGrantee["type"], role: DriveRole): string {
  let has = `That grantee already has ${role} access given on this file itself.`;
  return isAddressed(type)
    ? `${has} Change it with updateAccess(), which takes the same grantee.`
    : `${has} updateAccess(), which takes the same grantee, changes its role. Whether it can be ` +
      "found by searching is set when access is given: to change that, unshare() it and, once " +
      "that is approved, share() again.";
}

/** The refusal for a share to a grantee whom a parent already gives `role`, which is as much. */
function alreadyInherited(role: DriveRole): string {
  // Nothing here gives more than `writer`, so above it there is no higher role to offer.
  let remedy = ROLE_RANK[role] >= ROLE_RANK.writer
    ? "No higher role can be given here; the access itself is changed where it comes from."
    : "Give a higher role, or change the sharing of the folder it comes from.";
  return `That grantee already has ${role} access to this file through a parent, which this ` +
    `would not change. ${remedy}`;
}

/** What a share adds to its payload from the file's permissions, or the refusal it meets. */
export function planShare(
  fileId: string, permissions: readonly DrivePermissionRecord[], actor: DriveActor,
  grantee: DriveGrantee, role: DriveShareRole, pending: readonly QueuedWrite[],
): Pick<DriveSharingActions["createPermission"],
  "inheritedRole" | "outsideDomain" | "accountAddressUnknown"> {
  // Told by address where Drive gave the account one. Without it the account's own permission,
  // where the file lists it, is met below as any grantee's is.
  if (actor.emailAddress !== undefined && isAddressed(grantee.type) &&
      isGrantee({ type: "user", emailAddress: actor.emailAddress }, grantee)) {
    throw new Error(OWN_ACCESS);
  }
  let held = matchGrantee(permissions, grantee)
    .map(permission => ({ id: permission.id, ...accessOf(permission) }));
  // Said before the next refusal, whose updateAccess() would refuse the same grantee.
  if (held.some(({ direct }) => direct !== undefined && !isShareRole(direct))) {
    throw new Error(OWNER_OR_MANAGER);
  }
  let given = held.find(({ direct }) => direct !== undefined);
  if (given?.direct !== undefined) {
    // A listing leaves out access whose removal waits, so the refusal must not name it as there.
    if (hasPendingChange(fileId, given.id, pending)) throw new Error(SHARE_BEHIND_CHANGE);
    throw new Error(alreadyGiven(grantee.type, given.direct));
  }
  let inheritedRole = highest(held.flatMap(({ inherited }) => inherited ?? []));
  if (inheritedRole !== undefined && ROLE_RANK[inheritedRole] >= ROLE_RANK[role]) {
    throw new Error(alreadyInherited(inheritedRole));
  }
  let { outsideDomain, accountAddressUnknown } = audienceOf(actor, grantee, undefined);
  return {
    ...(inheritedRole === undefined ? {} : { inheritedRole }),
    ...(outsideDomain === undefined ? {} : { outsideDomain }),
    ...(accountAddressUnknown ? { accountAddressUnknown } : {}),
  };
}

/** A grantee as Drive lists them, for a queued change's approval. */
function snapshotOf(permission: DrivePermissionRecord): GranteeSnapshot {
  let { type, emailAddress, displayName, domain } = permission;
  return {
    type,
    ...(emailAddress === undefined ? {} : { emailAddress }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(domain === undefined ? {} : { domain }),
  };
}

/**
 * The permission `access` names, with the role it gives on the file itself, or the refusal for
 * access that is not on the file or that nothing here changes.
 */
function changeableAccess(
  permissions: readonly DrivePermissionRecord[], actor: DriveActor, access: string | DriveGrantee,
): { permission: DrivePermissionRecord; direct: DriveShareRole; inherited?: DriveRole } {
  let permission: DrivePermissionRecord | undefined;
  if (typeof access === "string") {
    // Either of Drive's two IDs names anyone's access, whichever form it is listed in. A deleted
    // account's permission is nobody's access: a listing leaves it out, and no ID names it.
    permission = permissions.find(listed => !listed.deleted && sameAccessId(listed.id, access));
    if (!permission) throw new Error("That access was not found on this file.");
  } else {
    let matches = matchGrantee(permissions, checkGrantee(access));
    if (matches.length > 1) {
      throw new Error("More than one access on this file matches that grantee; name it by the " +
        "ID listAccess() returns.");
    }
    permission = matches[0];
    if (!permission) throw new Error("That grantee has no access given on this file itself.");
  }
  let { direct, inherited } = accessOf(permission);
  if (direct === undefined) {
    throw new Error("That access comes from a parent folder or the shared drive, not from this " +
      "file, so it cannot be changed here. share() can give a higher role on this file; the " +
      "access itself is changed where it comes from.");
  }
  if (!isShareRole(direct)) throw new Error(OWNER_OR_MANAGER);
  // A connection should not remove itself.
  if (permission.type === "user" && permission.id === actor.permissionId) {
    throw new Error(OWN_ACCESS);
  }
  return { permission, direct, ...(inherited === undefined ? {} : { inherited }) };
}

/** The permission `access` names and what a role change of it carries, or its refusal. */
export function planUpdate(
  permissions: readonly DrivePermissionRecord[], actor: DriveActor,
  access: string | DriveGrantee, role: DriveShareRole,
): Omit<DriveSharingActions["updatePermission"], keyof DriveWriteTargetPayload | "isFolder"> {
  let { permission, direct, inherited } = changeableAccess(permissions, actor, access);
  if (role === direct) throw new Error("That access already has that role.");
  if (inherited !== undefined && ROLE_RANK[role] <= ROLE_RANK[inherited]) {
    throw new Error(`A parent already gives that grantee ${inherited} access to this file, and ` +
      "access given on the file cannot be lower. To leave only the parent's access, use " +
      "unshare().");
  }
  // A raise's approval says first whom it reaches. A lowering's is not loud, and is held when it
  // is applied to whether the access can be found by searching, and to nothing else of whom it
  // reaches.
  let audience = ROLE_RANK[role] > ROLE_RANK[direct]
    ? audienceOf(actor, permission, permission.allowFileDiscovery) : reachOf(permission);
  return {
    permissionId: permission.id, grantee: snapshotOf(permission), fromRole: direct, toRole: role,
    ...(inherited === undefined ? {} : { inheritedRole: inherited }),
    ...audience,
  };
}

/** The same for a removal. */
export function planUnshare(
  permissions: readonly DrivePermissionRecord[], actor: DriveActor, access: string | DriveGrantee,
): Omit<DriveSharingActions["deletePermission"], keyof DriveWriteTargetPayload | "isFolder"> {
  let { permission, direct, inherited } = changeableAccess(permissions, actor, access);
  return {
    permissionId: permission.id, grantee: snapshotOf(permission), role: direct,
    ...(inherited === undefined ? {} : { inheritedRole: inherited }),
    ...reachOf(permission),
  };
}

/** The entry a queued share shows as until it is decided. */
export function pendingAccess(
  id: number, payload: DriveSharingActions["createPermission"],
): DriveAccess {
  let { grantee } = payload;
  return {
    id: pendingId(id), type: grantee.type, role: payload.role,
    ...(grantee.type === "user" || grantee.type === "group"
      ? { emailAddress: grantee.emailAddress } : {}),
    ...(grantee.type === "domain" ? { domain: grantee.domain } : {}),
    // Drive lists such access with the flag either way, so the entry carries it while it waits.
    ...(isAddressed(grantee.type) ? {} : { discoverable: payload.discoverable === true }),
    pending: true,
  };
}

/** `entries` with this binding's undecided sharing changes for `fileId` applied, in queue order. */
export function overlayPendingAccess(
  fileId: string, entries: DriveAccess[], pending: readonly QueuedWrite[],
): DriveAccess[] {
  let shown = [...entries];
  let queued = sharingEntries(fileId, pending).toSorted((a, b) => a.id - b.id);
  for (let { id, action } of queued) {
    if (action.kind === "createPermission") {
      shown.push(pendingAccess(id, action.payload));
      continue;
    }
    // Only what is given on the file itself is changed: an inherited entry stays as it is. One
    // that went since, or that an earlier queued removal left out, changes nothing.
    let { permissionId } = action.payload;
    let at = shown.findIndex(entry => !entry.inherited && sameAccessId(entry.id, permissionId));
    if (at < 0) continue;
    if (action.kind === "deletePermission") shown.splice(at, 1);
    else shown[at] = { ...shown[at], role: action.payload.toRole, pending: true };
  }
  return shown;
}

/** The one kind every Drive sharing change is queued as. */
export const DRIVE_SHARING: ActionKind = { tag: "driveSharing", label: "Drive sharing" };

/** A role as Drive names it to people. */
const ROLE_WORDS: Record<DriveShareRole, string> = {
  reader: "viewer", commenter: "commenter", writer: "editor",
};

/** A kind of grantee, as a share's title names the one the caller gave. */
const AUDIENCE_WORDS: Record<DriveGrantee["type"], string> = {
  user: "a person", group: "a group", domain: "a domain", anyone: "anyone",
};

/** Whom access is given to, as a role change and a removal name the kind Drive lists. */
function whomOf(type: DriveGrantee["type"]): string {
  return type === "anyone" ? "anyone who has the link" : AUDIENCE_WORDS[type];
}

/** What a target is called: a folder, or a file of any other kind. */
function nounOf(payload: { isFolder?: true }): "file" | "folder" {
  return payload.isFolder ? "folder" : "file";
}

/** `text` with its first letter in upper case. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What makes a share or a raise loud: the beginning of its card's title and of its text. Both are
 * empty for a named grantee inside the connected account's domain.
 *
 * Approval surfaces that offer Approve on a collapsed row show the title and the start of the
 * first paragraph, so whom the change reaches is said in both, and the role given in the first.
 */
export function loudOpening(
  grantee: { type: DriveGrantee["type"] }, role: DriveShareRole, audience: Audience,
  noun: "file" | "folder",
): { title: string; prose: string } {
  let as = ROLE_WORDS[role];
  let searchable = audience.discoverable === true;
  let own = audience.outsideDomain === undefined ? undefined : codeSpan(audience.outsideDomain);
  switch (grantee.type) {
    case "anyone":
      return searchable ? {
        title: "Public, searchable: ",
        prose: `**Public: anyone can find this ${noun} by searching and gets ${as} access.**`,
      } : {
        title: "Public link: ",
        prose: `**Public: anyone who has the link gets ${as} access to this ${noun}.**`,
      };
    case "domain":
      return {
        title: `${own === undefined ? "Whole" : "Outside"} domain${
          searchable ? ", searchable" : ""}: `,
        // The sentence that names the account's own domain comes before the one about searching.
        prose: `**Everyone in the domain below gets ${as} access to this ${noun}.**${
          own === undefined ? "" : ` **That domain is not ${own}, the connected account's own.**`}${
          searchable ? " **They can also find it by searching.**" : ""}`,
      };
    case "user":
    case "group":
      if (audience.addressHidden) {
        return {
          title: "Unknown address: ",
          prose: own === undefined
            ? "**Drive does not show this grantee's address.**"
            : `**Drive does not show this grantee's address, so it may be outside ${own}, the ` +
              "connected account's own domain.**",
        };
      }
      if (audience.accountAddressUnknown) {
        return {
          title: "Unchecked address: ",
          prose: "**Drive did not give the connected account's own address, so whether this " +
            "address is outside its domain is not known.**",
        };
      }
      if (own !== undefined) {
        return {
          title: "Outside address: ",
          prose: `**This address is outside ${own}, the connected account's own domain.**`,
        };
      }
      return { title: "", prose: "" };
  }
}

/** A card's first paragraph: what makes the change loud, if anything, and then what it does. */
function firstParagraph(loud: string, sentence: string): string {
  return loud ? `${loud} ${sentence}` : sentence;
}

/** The fields that name a change's target: its ID, and its name as it was when queued. */
function targetFields(builder: ActionDescriptionBuilder, payload: DriveWriteTargetPayload): void {
  builder.inline("File", payload.fileId);
  if (payload.fileName !== undefined) builder.inline("File name", payload.fileName);
}

/** The fields that name existing access: its ID, which a change is sent to, and its grantee. */
function accessFields(
  builder: ActionDescriptionBuilder, payload: { permissionId: string; grantee: GranteeSnapshot },
): void {
  let { grantee } = payload;
  builder.inline("Access ID", payload.permissionId);
  if (grantee.type === "anyone") {
    builder.inline("Shared with", whomOf("anyone"));
  } else if (grantee.type === "domain") {
    if (grantee.domain !== undefined) builder.inline("Domain", grantee.domain);
  } else {
    if (grantee.emailAddress !== undefined) builder.inline("Shared with", grantee.emailAddress);
    if (grantee.displayName !== undefined) builder.inline("Name", grantee.displayName);
  }
}

const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const CANNOT_SHARE = "The connected account can no longer change who has access to that file.";
const GRANTEE_CHANGED =
  "That grantee's access to this file changed after this was queued, so nothing was changed.";
const ACCESS_GONE = "That access is no longer on this file.";
const ACCESS_CHANGED = "That access changed after this was queued, so nothing was changed.";

/** Said when a look finds neither what the approval described nor what the change was to make. */
const CHANGED_AGAIN =
  "This was changed again on Google Drive after it was first sent, so it was left as it is. " +
  "Check the file, then reject this to clear it.";

/**
 * Said when a share that was to be found by searching met access at another role: Google's create
 * left the role, and may have made the access found by searching all the same.
 */
const SHARED_AT_ANOTHER_ROLE =
  "Google left this access at another role than the approval said. Check who has access to the " +
  "file on Google Drive, then reject this to clear it.";

/** Said when a role change's own answer shows another role or reach than the approval described. */
const ROLE_SET_OTHERWISE =
  "Google changed this access otherwise than the approval said: its role, or whether it can be " +
  "found by searching, is not what was approved. Check who has access to the file on Google " +
  "Drive, then reject this to clear it.";

/** Said when a look is refused the file's permissions, or cannot read them all. */
const SHARING_NOT_SHOWN =
  "Google Drive no longer shows this file's sharing to the connected account, so whether this " +
  "change was made can't be checked, and it won't be sent again. Reject it to clear it.";

/** Said when Drive leaves open whether a send made its change. */
const UNCONFIRMED_CHANGE =
  "Google Drive did not confirm whether this change was made, and it may have been. Approving " +
  "it again first checks the file, so it is not made twice; rejecting it leaves anything " +
  "already changed as it is.";

/** Said for a refusal of Drive's that no row below knows. */
const SHARING_REFUSED = "Google Drive refused this sharing change.";

/** Drive's refusals of any sharing change, by status and reason, in our words. */
const SHARING_REFUSALS: readonly RefusalRow[] = [
  {
    status: 403, reason: "cannotModifyInheritedPermission",
    message: "That access comes from a parent folder, and access given on the file cannot be " +
      "set below it.",
  },
  {
    status: 403, reason: "cannotDeletePermission",
    message: "Google does not let the connected account remove that access. Access that comes " +
      "from a parent folder is removed on that folder.",
  },
  { status: 403, reason: "cannotRemoveOwner", message: "The owner's access cannot be changed." },
  {
    status: 404, reason: "notFound",
    message: "Google Drive no longer shows that file or that access to the connected account.",
  },
  { status: 403, reason: "insufficientFilePermissions", message: CANNOT_SHARE },
  {
    status: 403, reason: "shareOutNotPermitted",
    message: "Your organization does not allow sharing this outside the organization.",
  },
  {
    status: 403, reason: "shareInNotPermitted",
    message: "The recipient's organization does not accept files shared from outside it.",
  },
  {
    status: 403, reason: "publishOutNotPermitted",
    message: "Your organization does not allow sharing this with anyone who has the link.",
  },
  {
    status: 403, reason: "teamDriveDomainUsersOnlyRestriction",
    message: "This shared drive allows sharing only inside its organization.",
  },
  {
    status: 403, reason: "teamDriveTeamMembersOnlyRestriction",
    message: "This shared drive allows sharing only with its members.",
  },
  {
    status: 403, reason: "cannotShareTeamDriveWithNonGoogleAccounts",
    message: "This shared drive cannot be shared with an address that has no Google account.",
  },
  {
    status: 403, reason: "abusiveContentRestriction",
    message: "Google does not allow this file to be shared.",
  },
  {
    status: 403, reason: "cannotSetExpiration",
    message: "Google does not allow an expiry date on this access.",
  },
];

/** What Drive's 400 `invalid` means for a share, by the kind of grantee it was sent as. */
const INVALID_GRANTEE: Partial<Record<DriveGrantee["type"], string>> = {
  // What Google records for a group's address sent as a person's is not known, so the group is
  // named as what to try. A person's address sent as a group's is accepted, so a group's refusal
  // names nothing to try.
  user: "Google does not accept that address as a person's. If it is a group's address, share " +
    "with it as one.",
  group: "Google does not accept that address.",
  domain: "Google does not accept that domain: only a Google Workspace organization's domain " +
    "can be shared with.",
};

/** Drive's refusals of a send of `action`, in our words: a share's own, then every change's. */
function refusalRows(action: DriveSharingAction): readonly RefusalRow[] {
  if (action.kind !== "createPermission") return SHARING_REFUSALS;
  let invalid = INVALID_GRANTEE[action.payload.grantee.type];
  return [
    ...(invalid === undefined ? [] : [{ status: 400, reason: "invalid", message: invalid }]),
    {
      status: 400, reason: "invalidSharingRequest",
      message: action.payload.notify === false
        ? "Google refused to share with that address without emailing it, which it requires " +
          "for an address that has no Google account. Share again with notify left on."
        : "Google refused this sharing request.",
    },
    ...SHARING_REFUSALS,
  ];
}

/**
 * Whether a domain's or anyone's permission is found by searching, or not, as `reach` recorded.
 * True of a user's and of a group's, which have no such setting.
 */
function sameReach(permission: DrivePermissionRecord, reach: Reach): boolean {
  return isAddressed(permission.type) ||
    (permission.allowFileDiscovery === true) === (reach.discoverable === true);
}

/**
 * The permission a queued role change or removal is about, as the file lists it when the change
 * is applied: a user's or a group's by the ID it had, a domain's or anyone's by its grantee, whose
 * ID Drive may have changed.
 *
 * Anyone's access is one permission whose ID follows its form, and whether a domain's does is not
 * known. Looked up by ID alone, a link made searchable since would read as gone while the file is
 * public; found by its grantee it is on the file, and is judged as it stands.
 */
function accessNow(
  permissions: readonly DrivePermissionRecord[],
  payload: { permissionId: string; grantee: GranteeSnapshot },
): DrivePermissionRecord | undefined {
  let { permissionId, grantee } = payload;
  let byId = (listed: readonly DrivePermissionRecord[]) =>
    listed.find(permission => permission.id === permissionId);
  if (isAddressed(grantee.type) || (grantee.type === "domain" && grantee.domain === undefined)) {
    return byId(permissions);
  }
  // Under each answer to whether a domain's ID follows its form, a permission of that domain
  // that is on the file is found, and never read as gone.
  let matches = matchGrantee(permissions, grantee);
  return byId(matches) ?? matches[0];
}

/**
 * Removes what a permission gives on the file itself. With a parent's access at a lower role that
 * can be given, Drive drops the direct part only when the role is set to exactly the parent's, so
 * that update is sent first, and the answer decides whether a delete must follow.
 *
 * In every other case the delete is sent and Google answers it: an update to a role at or above
 * the one on the file would leave the grant as it is or raise it.
 */
async function dropDirect(
  api: Pick<DriveApi, "updatePermission" | "deletePermission">, fileId: string,
  permission: DrivePermissionRecord,
): Promise<void> {
  let { direct, inherited } = accessOf(permission);
  let below = direct !== undefined && inherited !== undefined && isShareRole(inherited) &&
    ROLE_RANK[inherited] < ROLE_RANK[direct] ? inherited : undefined;
  if (below === undefined) {
    await api.deletePermission(fileId, permission.id);
    return;
  }
  let answered = await api.updatePermission(fileId, permission.id, below);
  if (accessOf(answered).direct === undefined) return;
  // The list can show a parent's grant that is already gone, and the update then only lowered
  // what is given on the file.
  try {
    await api.deletePermission(fileId, permission.id);
  } catch (error) {
    // The update has changed the role, so no answer to this request means nothing changed: the
    // outcome is open whatever its status, and the next approval's look decides.
    throw new Error("The request that follows a lowered role was not confirmed.", {
      cause: error,
    });
  }
}

/** How a file's permissions stand to a queued sharing change. */
type Standing<Sent> =
  /** As the approval described: `send` makes the change. */
  | { described: true; send(): Promise<Sent> }
  /**
   * Anything else. `refusal` is what an approval with no send of its own on record is told, and
   * `made` is set when the permissions show what the change was to produce.
   */
  | { described: false; refusal: string; made?: { sent: Sent } };

/** A file's permissions, read to find what an earlier send of a change made. */
async function lookAtSharing(
  api: Pick<DriveApi, "listPermissions">, fileId: string,
): Promise<DrivePermissionRecord[]> {
  try {
    return await readPermissions(api, fileId);
  } catch (error) {
    // Asked first, since the next test matches this answer too. A token without the scope says
    // nothing of the file, and allowing changes again lifts it, so the write waits with its marker.
    if (isInsufficientScope(error)) throw new Error(WRITES_GRANT_MISSING, { cause: error });
    if (error instanceof PermissionListTooLong || isFileInvisible(error)) {
      throw new ActionOutcomeUnknownError(SHARING_NOT_SHOWN, { cause: error });
    }
    throw error;
  }
}

/** What a send answers before the checks have said what to send, which none is. */
async function sentUnchecked(): Promise<never> {
  throw new Error("A sharing change was sent before its checks ran.");
}

/**
 * Makes one approved sharing change, looking first for what an earlier send of it may have made.
 * `standing` judges the file's permissions against the change. Nothing of what Google answered is
 * kept beyond what is returned.
 */
function change<Sent>(
  host: DriveWritesHost, id: number, action: DriveSharingAction,
  standing: (permissions: readonly DrivePermissionRecord[]) => Standing<Sent>,
): Promise<Sent> {
  let { payload } = action;
  // Set by the check, which every send follows.
  let send: () => Promise<Sent> = sentUnchecked;
  return sendOnce<Sent>(host, id, {
    log: logger.with({ actionId: id, actionKind: action.kind, fileId: payload.fileId }),
    events: "drive.sharing",
    look: async () => {
      let stands = standing(await lookAtSharing(host.api, payload.fileId));
      if (stands.described) return { conclusive: true };
      if (stands.made) return { found: stands.made.sent };
      throw new ActionOutcomeUnknownError(CHANGED_AGAIN);
    },
    check: async () => {
      await requireWritable(host);
      let file = await proveTarget(host, payload);
      if (!file) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
      if (file.canShare !== true) throw new ActionApplyError(CANNOT_SHARE);
      let permissions: DrivePermissionRecord[];
      try {
        permissions = await readPermissions(host.api, payload.fileId);
      } catch (error) {
        if (error instanceof PermissionListTooLong) throw new ActionApplyError(error.message);
        throw error;
      }
      // A folder binding reaches a file by where it sits, and reading its permissions took
      // requests of its own: its place is proved again before anything of the list is said or sent.
      if (host.scope().kind === "folder" && !await proveTarget(host, payload)) {
        throw new ActionApplyError(NO_LONGER_IN_SCOPE);
      }
      // With no send of this change on record, a file already in the state it was to produce is
      // someone else's doing, and the approver is told this approval changed nothing.
      let stands = standing(permissions);
      if (!stands.described) throw new ActionApplyError(stands.refusal);
      send = stands.send;
      return {};
    },
    send: () => send(),
    // A grant, a role and a removal can each be sent twice without a second effect.
    repeatable: true,
    refusal: error => driveRefusal(error, refusalRows(action), SHARING_REFUSED),
    unconfirmed: UNCONFIRMED_CHANGE,
  });
}

/** The grant a share sends: to whom, at which role, and whether it can be found by searching. */
function grantOf(payload: DriveSharingActions["createPermission"]): DrivePermissionGrant {
  let { grantee, role } = payload;
  switch (grantee.type) {
    case "user":
    case "group":
      return { type: grantee.type, role, emailAddress: grantee.emailAddress };
    case "domain":
      return {
        type: "domain", role, domain: grantee.domain,
        allowFileDiscovery: payload.discoverable === true,
      };
    case "anyone":
      return { type: "anyone", role, allowFileDiscovery: payload.discoverable === true };
  }
}

/**
 * Gives the access a share's approval described, and holds Google's answer to the kind and the
 * reach the approval said. Resolves with nothing: the permission is read for those two checks
 * and kept nowhere.
 */
async function applyShare(
  host: DriveWritesHost, id: number, payload: DriveSharingActions["createPermission"],
): Promise<void> {
  let { grantee, role } = payload;
  let emailed = isAddressed(grantee.type);
  let permission = await change(host, id, { kind: "createPermission", payload }, permissions => {
    let held = matchGrantee(permissions, grantee)
      .map(listed => ({ listed, ...accessOf(listed) }));
    let given = held.filter(({ direct }) => direct !== undefined);
    let inherits = held.some(({ inherited }) =>
      inherited !== undefined && ROLE_RANK[inherited] >= ROLE_RANK[role]);
    if (!given.length && !inherits) {
      return {
        described: true,
        send: () => host.api.createPermission(payload.fileId, grantOf(payload), {
          // A domain and anyone are never emailed.
          notify: emailed && payload.notify !== false,
          ...(emailed && payload.message !== undefined ? { message: payload.message } : {}),
        }),
      };
    }
    // The grantee had nothing on the file before a send, or its check would have refused, so the
    // approval's role there, in the form the approval said, is what a send made. A higher one was
    // given by someone else: Google's create only raises a role.
    let made = given.find(({ listed, direct }) => direct === role && sameReach(listed, payload));
    return {
      described: false, refusal: GRANTEE_CHANGED,
      ...(made ? { made: { sent: made.listed } } : {}),
    };
  });

  // Held outside the step, so that neither is read as a send that failed: the access exists, and
  // is more than, or other than, what the approver read.
  let asked = grantee.type;
  // Google records a person's address shared as a group's as that person's, which reaches no
  // more than the approval said.
  if (permission.type !== asked && !(asked === "group" && permission.type === "user")) {
    throw new ActionOutcomeUnknownError(
      `Google gave this access to ${AUDIENCE_WORDS[permission.type]}, where the approval said ${
        AUDIENCE_WORDS[asked]}. Check who has access to the file on Google Drive, then reject ` +
      "this to clear it.");
  }
  // Google's create widens a link that exists and never narrows one.
  if (!sameReach(permission, payload)) {
    let found = permission.allowFileDiscovery === true;
    throw new ActionOutcomeUnknownError(
      `Google gave this access so that it ${found ? "can" : "cannot"} be found by searching, ` +
      `where the approval said it ${found ? "could not" : "could"}. Check who has access to ` +
      "the file on Google Drive, then reject this to clear it.");
  }
  // Google's create only raises a role. Access given since the checks read the file, at a higher
  // role or by a parent, is left as it was and answers in place of what the approval said.
  if (accessOf(permission).direct !== role) {
    // A link or a domain asked to be found by searching may have been made so all the same.
    if (!emailed && payload.discoverable === true) {
      throw new ActionOutcomeUnknownError(SHARED_AT_ANOTHER_ROLE);
    }
    // Nothing was changed, so no send is in doubt.
    host.attempts.delete(id);
    throw new ActionApplyError(GRANTEE_CHANGED);
  }
}

/**
 * Sets the role a role change's approval described, and holds Google's answer to the role and the
 * reach the approval said.
 */
async function applyRoleChange(
  host: DriveWritesHost, id: number, payload: DriveSharingActions["updatePermission"],
): Promise<void> {
  let answered = await change<DrivePermissionRecord | undefined>(host, id, {
    kind: "updatePermission", payload,
  }, permissions => {
    let current = accessNow(permissions, payload);
    let { direct, inherited } = current ? accessOf(current) : {};
    if (current === undefined || direct === undefined) {
      // Drive leaves nothing on the file of a role set to exactly what a parent gives, as long as
      // the parent's access is found by searching, or not, as the approval said.
      let made = current !== undefined && inherited === payload.toRole &&
        sameReach(current, payload);
      return {
        described: false, refusal: ACCESS_GONE, ...(made ? { made: { sent: undefined } } : {}),
      };
    }
    let reach = sameReach(current, payload);
    if (direct === payload.fromRole && reach) {
      return {
        described: true,
        send: () =>
          host.api.updatePermission(payload.fileId, payload.permissionId, payload.toRole),
      };
    }
    return {
      described: false, refusal: ACCESS_CHANGED,
      ...(direct === payload.toRole && reach ? { made: { sent: undefined } } : {}),
    };
  });
  // What a look found was judged there. A send's own answer is held outside the step, as a
  // share's is: the role was set, on access other than the approval described.
  if (answered === undefined) return;
  let { direct, inherited } = accessOf(answered);
  // Drive leaves nothing on the file of a role set to exactly what a parent gives.
  let set = direct === payload.toRole || (direct === undefined && inherited === payload.toRole);
  if (!set || !sameReach(answered, payload)) {
    throw new ActionOutcomeUnknownError(ROLE_SET_OTHERWISE);
  }
}

/** Removes the access a removal's approval described. */
async function applyRemoval(
  host: DriveWritesHost, id: number, payload: DriveSharingActions["deletePermission"],
): Promise<void> {
  await change<void>(host, id, { kind: "deletePermission", payload }, permissions => {
    let current = accessNow(permissions, payload);
    if (current === undefined || accessOf(current).direct === undefined) {
      return { described: false, refusal: ACCESS_GONE, made: { sent: undefined } };
    }
    if (accessOf(current).direct !== payload.role || !sameReach(current, payload)) {
      return { described: false, refusal: ACCESS_CHANGED };
    }
    // What a parent gives is read here, when the removal is applied, so a folder shared or
    // unshared since it was queued is followed. The requests go to the ID the approval showed.
    let listed = { ...current, id: payload.permissionId };
    return { described: true, send: () => dropDirect(host.api, payload.fileId, listed) };
  });
}

/** The declared Drive sharing changes, which drive-actions.ts combines with the others. */
export const DRIVE_SHARING_DEFINITIONS: {
  [K in keyof DriveSharingActions]: ActionDefinition<DriveSharingActions[K], DriveWritesHost>;
} = {
  createPermission: {
    kind: DRIVE_SHARING,
    // Rule 7: changes sharing.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    // An activation that dies mid-send leaves an outcome nobody saw, which must not be replayed.
    claimBeforeApply: true,
    describe: payload => {
      let { grantee } = payload;
      let noun = nounOf(payload);
      let loud = loudOpening(grantee, payload.role, payload, noun);
      let builder = buildDescription(firstParagraph(loud.prose,
        `Give ${ROLE_WORDS[payload.role]} access to Google Drive ${noun} ${
          codeSpan(payload.fileId)} as the connected account.`));
      if (payload.isFolder) {
        builder.prose("This is a folder: everything in it is shared too. Access they already " +
          "have to something in it, at this role or a lower one, is merged into the folder's, " +
          "and is gone if the folder's access is later removed.");
      }
      if (isAddressed(grantee.type)) {
        builder.prose(
          payload.notify === false ? "No email is sent." : "Google emails them about it.");
      }
      if (payload.inheritedRole !== undefined) {
        builder.prose(`They already have ${codeSpan(payload.inheritedRole)} access through a ` +
          `parent folder; this gives a higher role on the ${noun} itself.`);
      }
      targetFields(builder, payload);
      if (grantee.type === "user" || grantee.type === "group") {
        builder.inline("Share with", grantee.emailAddress);
      } else if (grantee.type === "domain") {
        builder.inline("Domain", grantee.domain);
      }
      builder.inline("Role", payload.role);
      if (payload.message !== undefined) builder.verbatim("Message", payload.message);
      let title = capitalized(
        `${loud.title}share a Google Drive ${noun} with ${AUDIENCE_WORDS[grantee.type]}`);
      return { title, ...builder.finish(), implementsRevert: false };
    },
    apply: (payload, host, ctx) => applyShare(host, ctx.id, payload),
  },

  updatePermission: {
    kind: DRIVE_SHARING,
    // Rule 7: changes sharing.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let noun = nounOf(payload);
      // Only a role that rises is loud: a lowering reaches nobody it did not reach.
      let raise = ROLE_RANK[payload.toRole] > ROLE_RANK[payload.fromRole];
      let loud = raise
        ? loudOpening(payload.grantee, payload.toRole, payload, noun) : { title: "", prose: "" };
      // Both roles come before the file's ID, inside what a collapsed row shows.
      let builder = buildDescription(firstParagraph(loud.prose,
        `Change the role of access given to ${whomOf(payload.grantee.type)} from ${
          codeSpan(payload.fromRole)} to ${codeSpan(payload.toRole)} on Google Drive ${noun} ${
          codeSpan(payload.fileId)}, as the connected account.`));
      if (payload.isFolder) {
        builder.prose(`This is a folder: the change reaches everything in it.${raise
          ? " Access they already have to something in it, at the new role or a lower one, is " +
            "merged into the folder's, and is gone if the folder's access is later removed."
          : ""}`);
      }
      if (payload.inheritedRole !== undefined) {
        builder.prose(`A parent folder already gives them ${
          codeSpan(payload.inheritedRole)} access, which this does not change.`);
      }
      targetFields(builder, payload);
      accessFields(builder, payload);
      builder.inline("From role", payload.fromRole);
      builder.inline("To role", payload.toRole);
      let title = raise
        ? capitalized(`${loud.title}raise access to a Google Drive ${noun}`)
        : `Lower access to a Google Drive ${noun}`;
      return { title, ...builder.finish(), implementsRevert: false };
    },
    apply: (payload, host, ctx) => applyRoleChange(host, ctx.id, payload),
  },

  deletePermission: {
    kind: DRIVE_SHARING,
    // Rule 7: changes sharing.
    autoApprovable: false,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let noun = nounOf(payload);
      let builder = buildDescription(
        `Remove access given to ${whomOf(payload.grantee.type)} on Google Drive ${noun} ${
          codeSpan(payload.fileId)}, as the connected account.`);
      if (payload.isFolder) {
        builder.prose("This is a folder: everything in it loses the access it had through " +
          "this folder. Access they had to something in it that was merged into the folder's " +
          "goes with it.");
      }
      if (payload.inheritedRole !== undefined) {
        builder.prose(`They keep ${codeSpan(payload.inheritedRole)} access through a parent ` +
          "folder, which this does not change.");
      }
      targetFields(builder, payload);
      accessFields(builder, payload);
      builder.inline("Role", payload.role);
      let title = `Remove access to a Google Drive ${noun}`;
      return { title, ...builder.finish(), implementsRevert: false };
    },
    apply: (payload, host, ctx) => applyRemoval(host, ctx.id, payload),
  },
};
