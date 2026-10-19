// The Cloud Identity Groups API, as the Google Groups gatekeeper uses it.
//
// Every call is made as the connected user, who is usually not a Workspace administrator, so this
// uses only what an ordinary user may call: looking a group up by email address, reading it,
// listing and looking up its direct members, searching the groups of the user's own organization,
// and listing the groups someone directly belongs to. The transitive-membership methods are
// deliberately absent, since Google answers them only on premium editions, and nothing here writes.
// Group conversations have no API at all.
//
// Google applies each group's own visibility settings to these calls: a group the user cannot see,
// or whose members it cannot see, fails or is left out rather than being returned.

import { fetchWithAuthRetry, type AccessTokenProvider } from "./auth-retry";
import type { CursorPage } from "./cursor";
import { GoogleApiError, readGoogleJson } from "./google-response";
import type { GoogleGroupInfo, GoogleGroupMember, GoogleGroupRole } from "./groups-types";

const API_BASE = "https://cloudidentity.googleapis.com/v1";
const PROVIDER = "Google Groups";
// A page of 200 groups, each with a description of up to 4,096 characters, even heavily escaped.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 200;
/** Pages of the account's own groups read to find which organization it belongs to. */
const MAX_CUSTOMER_DISCOVERY_PAGES = 5;
/** Groups in the account's own domain read for their owner before giving up. */
const MAX_CUSTOMER_CANDIDATES = 3;
const MAX_SEARCH_TEXT_LENGTH = 100;

/** Every Google Group carries this label; identity-mapped groups synced from elsewhere do not. */
const DISCUSSION_FORUM_LABEL = "cloudidentity.googleapis.com/groups.discussion_forum";
const SECURITY_LABEL = "cloudidentity.googleapis.com/groups.security";
const DYNAMIC_LABEL = "cloudidentity.googleapis.com/groups.dynamic";
const LOCKED_LABEL = "cloudidentity.googleapis.com/groups.locked";

const GROUP_NAME_RE = /^groups\/[A-Za-z0-9_-]{1,128}$/;
const MEMBERSHIP_NAME_RE = /^groups\/[A-Za-z0-9_-]{1,128}\/memberships\/[A-Za-z0-9_-]{1,128}$/;
const CUSTOMER_RE = /^customers\/C[A-Za-z0-9]{1,64}$/;
// Matched before lowercasing, and spelled out rather than case-insensitive, so no non-ASCII letter
// (such as the Kelvin sign, which lowercases to `k`) can fold into an address.
const EMAIL_LOCAL_RE = /^[A-Za-z0-9._%+'-]{1,64}$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

type EntityKeyRaw = { id?: string; namespace?: string };
type MembershipRoleRaw = { name?: string };
type Labels = Record<string, string>;

type GroupRaw = {
  name?: string;
  groupKey?: EntityKeyRaw;
  additionalGroupKeys?: EntityKeyRaw[];
  parent?: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  labels?: Labels;
};

type MembershipRaw = {
  name?: string;
  preferredMemberKey?: EntityKeyRaw;
  roles?: MembershipRoleRaw[];
  type?: string;
  createTime?: string;
};

/** One result of `searchDirectGroups`: a group and the member's direct membership of it. */
type MembershipRelationRaw = {
  group?: string;
  groupKey?: EntityKeyRaw;
  displayName?: string;
  description?: string;
  labels?: Labels;
  roles?: MembershipRoleRaw[];
};

/** A group as read, with the customer that owns it, which callers use only internally. */
export type GroupRecord = { info: GoogleGroupInfo; parent?: string };

/** A group someone directly belongs to, and their role in it. */
export type GroupMembershipRecord = { info: GoogleGroupInfo; role: GoogleGroupRole };

/** Which field a group search matches. */
export type GroupSearchField = "display_name" | "group_key";

/** A group's resource name, `groups/{id}`, checked because it is interpolated into request paths. */
export function validateGroupName(name: string): string {
  if (!GROUP_NAME_RE.test(name)) throw new Error("Not a valid Google Group ID.");
  return name;
}

/** `email` lowercased, refusing anything that is not an email address. */
export function normalizeEmail(email: string): string {
  let address = email.trim();
  let at = address.lastIndexOf("@");
  if (at <= 0 || !EMAIL_LOCAL_RE.test(address.slice(0, at)) || !DOMAIN_RE.test(address.slice(at + 1))) {
    throw new Error("Expected an email address, such as team@example.com.");
  }
  return address.toLowerCase();
}

/** The email address of the group whose groups.google.com page is `/a/{domain}/g/{name}`. */
export function groupEmailFromUrlParts(domain: string, name: string): string {
  return normalizeEmail(`${name}@${domain}`);
}

/** The group's page on groups.google.com, in the canonical form a group binding's URL takes. */
export function groupUrl(email: string): string {
  let at = email.lastIndexOf("@");
  return `https://groups.google.com/a/${email.slice(at + 1)}/g/${encodeURIComponent(email.slice(0, at))}`;
}

/**
 * The email address of the group a groups.google.com link points into, or undefined for any other
 * text. Any page within the group counts, such as its members or a conversation in it.
 */
export function groupEmailFromLink(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "groups.google.com") return undefined;
  let match = /^\/a\/([^/]+)\/g\/([^/]+)(?:\/|$)/.exec(url.pathname);
  if (!match) return undefined;
  try {
    return groupEmailFromUrlParts(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  } catch {
    return undefined;
  }
}

/** The domain of an email address already normalized by {@link normalizeEmail}. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** A CEL string literal holding `value`. Caller text reaches a query only through this. */
export function celString(value: string): string {
  // oxlint-disable-next-line no-control-regex -- caller text is interpolated into a query string
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Text must not contain control characters.");
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Search text, trimmed and checked. */
export function validateSearchText(query: string): string {
  let text = query.trim();
  if (!text) throw new Error("Text to search for is required.");
  if (text.length > MAX_SEARCH_TEXT_LENGTH) {
    throw new Error(`Search text must be at most ${MAX_SEARCH_TEXT_LENGTH} characters.`);
  }
  celString(text);
  return text;
}

/**
 * The query matching `customer`'s Google Groups whose `field` contains `text`. Addresses are
 * lowercase, so the address search is too; Google documents nothing about how names compare.
 */
export function groupSearchQuery(customer: string, field: GroupSearchField, text: string): string {
  if (!CUSTOMER_RE.test(customer)) throw new Error("Not a valid Google Workspace customer.");
  let match = field === "group_key" ? text.toLowerCase() : text;
  return `parent == ${celString(customer)} && '${DISCUSSION_FORUM_LABEL}' in labels && ` +
    `${field}.contains(${celString(match)})`;
}

/** The HTTP status Google answered a failed request with, or undefined for any other failure. */
export function groupsErrorStatus(error: unknown): number | undefined {
  return error instanceof GoogleApiError ? error.httpStatus : undefined;
}

/** Whether a request failed because the deployment's Google Cloud project has not enabled the API. */
export function groupsApiDisabled(error: unknown): boolean {
  return error instanceof GoogleApiError &&
    error.providerReasons.some(reason => reason === "SERVICE_DISABLED" || reason === "accessNotConfigured");
}

function timestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  let date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function hasLabel(labels: Labels | undefined, label: string): boolean {
  return labels !== undefined && Object.hasOwn(labels, label);
}

/** The highest of a membership's roles. Every membership holds at least `MEMBER`. */
function highestRole(roles: MembershipRoleRaw[] | undefined): GoogleGroupRole {
  let names = new Set((roles ?? []).map(role => role.name));
  if (names.has("OWNER")) return "owner";
  if (names.has("MANAGER")) return "manager";
  return "member";
}

const MEMBER_KINDS: Record<string, GoogleGroupMember["kind"]> = {
  USER: "user", GROUP: "group", SERVICE_ACCOUNT: "serviceAccount",
};

function groupInfo(fields: {
  name?: string;
  key?: EntityKeyRaw;
  aliases?: EntityKeyRaw[];
  displayName?: string;
  description?: string;
  createTime?: string;
  labels?: Labels;
}): GoogleGroupInfo {
  let id = validateGroupName(fields.name ?? "");
  let email = fields.key?.id ? normalizeEmail(fields.key.id) : undefined;
  if (email === undefined) throw new Error("Google Groups returned a group with no email address.");
  let createdAt = timestamp(fields.createTime);
  return {
    id,
    email,
    ...(fields.aliases !== undefined ? {
      aliases: fields.aliases.flatMap(key => typeof key.id === "string" ? [key.id.toLowerCase()] : []),
    } : {}),
    name: fields.displayName || email,
    ...(fields.description ? { description: fields.description } : {}),
    url: groupUrl(email),
    security: hasLabel(fields.labels, SECURITY_LABEL),
    dynamic: hasLabel(fields.labels, DYNAMIC_LABEL),
    locked: hasLabel(fields.labels, LOCKED_LABEL),
    ...(createdAt ? { createdAt } : {}),
  };
}

function groupFromRaw(raw: GroupRaw): GoogleGroupInfo {
  return groupInfo({
    name: raw.name, key: raw.groupKey, aliases: raw.additionalGroupKeys ?? [],
    displayName: raw.displayName, description: raw.description, createTime: raw.createTime,
    labels: raw.labels,
  });
}

/**
 * A membership as the agent sees it. One keyed by a namespace rather than an email address belongs
 * to an identity-mapped group synced from another directory, and has no address to report. Only
 * addresses are lowercased: an `other` member, such as a shared drive, is keyed by Google's own ID.
 */
function memberFromRaw(raw: MembershipRaw): GoogleGroupMember[] {
  let key = raw.preferredMemberKey;
  if (!key?.id || key.namespace) return [];
  let kind = MEMBER_KINDS[raw.type ?? ""] ?? "other";
  let addedAt = timestamp(raw.createTime);
  return [{
    email: kind === "other" ? key.id : key.id.toLowerCase(),
    kind,
    role: highestRole(raw.roles),
    ...(addedAt ? { addedAt } : {}),
  }];
}

function page<T>(items: T[], nextPageToken: string | undefined): CursorPage<T> {
  return { items, ...(nextPageToken ? { nextPageToken } : {}) };
}

/** The Cloud Identity Groups API, as far as the gatekeeper uses it. */
export class GoogleGroupsApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  async #get<T>(path: string, params: Record<string, string | undefined>, operation: string): Promise<T> {
    let url = new URL(`${API_BASE}/${path}`);
    for (let [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    let response = await fetchWithAuthRetry(
      url.toString(), { headers: { Accept: "application/json" } }, this.getAccessToken,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    return readGoogleJson<T>(response, { provider: PROVIDER, operation, maxBytes: MAX_RESPONSE_BYTES });
  }

  /** The ID of the group whose email address is `email`. */
  async lookupGroup(email: string): Promise<string> {
    let raw = await this.#get<{ name?: string }>(
      "groups:lookup", { "groupKey.id": normalizeEmail(email) }, "group lookup");
    return validateGroupName(raw.name ?? "");
  }

  async getGroup(group: string): Promise<GroupRecord> {
    let raw = await this.#get<GroupRaw>(validateGroupName(group), {}, "group read");
    return { info: groupFromRaw(raw), ...(raw.parent ? { parent: raw.parent } : {}) };
  }

  /** One page of the groups a {@link groupSearchQuery} matches. */
  async searchGroups(query: string, pageToken?: string): Promise<CursorPage<GoogleGroupInfo>> {
    let raw = await this.#get<{ groups?: GroupRaw[]; nextPageToken?: string }>(
      "groups:search",
      { query, view: "FULL", pageSize: String(PAGE_SIZE), pageToken },
      "group search");
    return page((raw.groups ?? []).map(groupFromRaw), raw.nextPageToken);
  }

  /** One page of a group's direct members. */
  async listMembers(
    group: string, pageToken?: string, pageSize = PAGE_SIZE,
  ): Promise<CursorPage<GoogleGroupMember>> {
    let raw = await this.#get<{ memberships?: MembershipRaw[]; nextPageToken?: string }>(
      `${validateGroupName(group)}/memberships`,
      { view: "FULL", pageSize: String(pageSize), pageToken },
      "member list");
    return page((raw.memberships ?? []).flatMap(memberFromRaw), raw.nextPageToken);
  }

  /** `email`'s direct membership of a group, or null when it has none. */
  async findMember(group: string, email: string): Promise<GoogleGroupMember | null> {
    let lookup: { name?: string };
    try {
      lookup = await this.#get<{ name?: string }>(
        `${validateGroupName(group)}/memberships:lookup`,
        { "memberKey.id": normalizeEmail(email) },
        "member lookup");
    } catch (error) {
      // Google answers a lookup for someone who is not a direct member with "not found", but a
      // group that has gone, or hidden its members, might answer the same way. Only a member list
      // that can still be read makes the "not found" mean "not a member"; otherwise that throws.
      if (groupsErrorStatus(error) !== 404) throw error;
      await this.listMembers(group, undefined, 1);
      return null;
    }
    let name = lookup.name ?? "";
    if (!MEMBERSHIP_NAME_RE.test(name) || !name.startsWith(`${group}/`)) {
      throw new Error("Google Groups returned an unexpected membership.");
    }
    let raw = await this.#get<MembershipRaw>(name, {}, "member read");
    return memberFromRaw(raw)[0] ?? null;
  }

  /**
   * One page of the groups `email` directly belongs to. Google leaves out groups whose members the
   * caller cannot see.
   */
  async listGroupsOf(email: string, pageToken?: string): Promise<CursorPage<GroupMembershipRecord>> {
    let query = `member_key_id == ${celString(normalizeEmail(email))} && '${DISCUSSION_FORUM_LABEL}' in labels`;
    let raw = await this.#get<{ memberships?: MembershipRelationRaw[]; nextPageToken?: string }>(
      "groups/-/memberships:searchDirectGroups",
      { query, pageSize: String(PAGE_SIZE), pageToken },
      "direct group search");
    return page((raw.memberships ?? []).map(relation => ({
      info: groupInfo({
        name: relation.group, key: relation.groupKey, displayName: relation.displayName,
        description: relation.description, labels: relation.labels,
      }),
      role: highestRole(relation.roles),
    })), raw.nextPageToken);
  }

  /**
   * The customer, `customers/{id}`, owning the organization `email` belongs to, or null when that
   * cannot be told.
   *
   * Search is confined to one customer, and Google documents no way for someone who is not an
   * administrator to name their own: it is only the owner of each group. So this reads the account's
   * own groups for one in its own domain, which therefore belongs to its own organization, and takes
   * that group's owner.
   */
  async findCustomer(email: string): Promise<string | null> {
    let address = normalizeEmail(email);
    let domain = emailDomain(address);
    let candidates = 0;
    let pageToken: string | undefined;
    for (let pages = 0; pages < MAX_CUSTOMER_DISCOVERY_PAGES; pages++) {
      let { items, nextPageToken } = await this.listGroupsOf(address, pageToken);
      for (let { info } of items) {
        if (emailDomain(info.email) !== domain) continue;
        if (++candidates > MAX_CUSTOMER_CANDIDATES) return null;
        let parent: string | undefined;
        try {
          ({ parent } = await this.getGroup(info.id));
        } catch (error) {
          // A group can stop being visible between listing it and reading it; try the next one.
          let status = groupsErrorStatus(error);
          if (status === 403 || status === 404) continue;
          throw error;
        }
        if (parent !== undefined && CUSTOMER_RE.test(parent)) return parent;
      }
      if (!nextPageToken) break;
      pageToken = nextPageToken;
    }
    return null;
  }
}
