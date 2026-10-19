import type { RpcTarget } from "cloudflare:workers";

/**
 * A pagination cursor.
 *
 * Call `next()` repeatedly on the same RPC object and dispose it when finished. Drain it until
 * `next()` returns `null`; an empty array means only that this call made no visible progress.
 */
export interface Cursor<T> extends RpcTarget {
  /** The next batch, `[]` when more work remains, or `null` once exhausted. */
  next(): Promise<T[] | null>;
}

/** A member's role in a group. Owners and managers usually manage the group's members. */
export type GoogleGroupRole = "owner" | "manager" | "member";

/** Metadata about a Google Group. */
export type GoogleGroupInfo = {
  /** Stable ID, such as `groups/01abcd2e3fgh4ij`. Unlike the email address, it never changes. */
  id: string;
  /** The group's email address, such as `team@example.com`. */
  email: string;
  /**
   * Other email addresses that also reach the group. Results of `listGroupsOf()` leave this out;
   * call the entry's `group.getInfo()` for it.
   */
  aliases?: string[];
  /** Display name, or the email address when the group has none. */
  name: string;
  /** Description, when one is set. */
  description?: string;
  /** Browser URL on groups.google.com. */
  url: string;
  /** Whether this is a security group, which can grant access to resources such as Cloud projects. */
  security: boolean;
  /** Whether membership follows a query rather than being managed directly. */
  dynamic: boolean;
  /** Whether only administrators can change the group's members. */
  locked: boolean;
  /** When the group was created, when Google returns it. */
  createdAt?: Date;
};

/** One direct member of a group. */
export type GoogleGroupMember = {
  /**
   * The member's email address, lowercase. For an `other` member, such as a shared drive, Google's
   * own identifier for it instead.
   */
  email: string;
  /** What the member is. A nested `group` is listed as one member; its own members are not. */
  kind: "user" | "group" | "serviceAccount" | "other";
  /** The member's highest role in this group. */
  role: GoogleGroupRole;
  /** When the member was added, when Google returns it. */
  addedAt?: Date;
};

/** A result: group metadata plus a capability for that group. */
export type GoogleGroupEntry = {
  /** Metadata for this result. */
  info: GoogleGroupInfo;
  /** Capability for reading this group. */
  group: GoogleGroup;
};

/** A group someone directly belongs to, with their role in it. */
export type GoogleGroupMembershipEntry = GoogleGroupEntry & {
  /** Their role in this group. */
  role: GoogleGroupRole;
};

/**
 * Every Google Group the connected account can see. Find groups and see who belongs where, then
 * use the returned `GoogleGroup` capabilities to read one group.
 *
 * Only Google Workspace groups are available, not groups at googlegroups.com, and group
 * conversations are not available at all. Messages the connected account received from a group
 * can be found in Gmail by searching for `list:<group email>`.
 */
export interface GoogleGroupsSession extends RpcTarget {
  /**
   * Find groups in the connected account's own organization whose name or email address contains
   * `query`, such as `oncall` or `eng-`: groups matching by name first, then the rest matching by
   * email address. Addresses match in any case; names may match only in the case given, so pass
   * a name as it is likely capitalized. Only groups the connected account can see are returned.
   * Throws when the connected account's organization cannot be determined, which needs the
   * account to belong to a group under its own email domain.
   */
  searchGroups(query: string): Promise<Cursor<GoogleGroupEntry>>;

  /**
   * List the groups `email` (a person, group, or service account) directly belongs to, defaulting
   * to the connected account, including groups of other organizations. Groups it reaches only
   * through a nested group are not included, nor are groups whose members the connected account
   * cannot see.
   */
  listGroupsOf(email?: string): Promise<Cursor<GoogleGroupMembershipEntry>>;

  /**
   * Open a group by email address, ID (`groups/...`), or a link to any page in it of the form
   * `https://groups.google.com/a/<domain>/g/<name>`. Throws when it does not exist or the
   * connected account cannot see it.
   */
  getGroup(emailOrId: string): Promise<GoogleGroupEntry>;
}

/** One Google Group: its metadata and direct members. */
export interface GoogleGroup extends RpcTarget {
  /** Return the group's current metadata. */
  getInfo(): Promise<GoogleGroupInfo>;

  /**
   * List the group's direct members. The cursor's `next()` throws when the connected account
   * cannot see them.
   */
  listMembers(): Promise<Cursor<GoogleGroupMember>>;

  /**
   * Look up a direct member by email address. Returns `null` when the address is not a direct
   * member, including when it belongs only through a nested group.
   */
  findMember(email: string): Promise<GoogleGroupMember | null>;
}
