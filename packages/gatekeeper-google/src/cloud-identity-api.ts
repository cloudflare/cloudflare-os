// The Cloud Identity Groups API, for one thing: who belongs to a Google Group.
//
// A group is looked up and listed with its binding owner's token. A membership is looked up with
// the token of the account whose membership it is, and that account's address is the one Google's
// userinfo returned for the same token, so nothing here asserts anyone's identity.

import { type AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

const BASE = "https://cloudidentity.googleapis.com/v1";
/** The label every Google Group with a mailbox carries. */
const DISCUSSION_FORUM = "cloudidentity.googleapis.com/groups.discussion_forum";
/** What every group's resource name starts with, before the id Google gave it. */
export const GROUP_NAME_PREFIX = "groups/";
const GROUP_NAME_RE = /^groups\/[A-Za-z0-9]{1,128}$/;
// Strict enough to quote inside a double-quoted CEL string literal without escaping. Workspace
// allows an apostrophe in a username.
const ADDRESS_RE = /^[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,253}$/;
const MAX_ERROR_BODY_BYTES = 4096;
const MAX_GROUP_PAGES = 10;

/** A Google Group, every address lowercase. */
export type CloudIdentityGroup = {
  /** Its resource name, `groups/<id>`, which no other group ever takes. */
  name: string;
  address: string;
  aliases: string[];
  displayName: string;
};

/** A group as a listing names it, without its aliases. */
export type CloudIdentityGroupSummary = Omit<CloudIdentityGroup, "aliases">;

/** Cloud Identity refused, or the deployment has not enabled the API. Safe to show. */
export class CloudIdentityApiError extends Error {
  constructor(readonly status: number, operation: string, readonly reason?: string) {
    super(reason === "SERVICE_DISABLED"
      ? "Sharing mail with a Google Group needs the Cloud Identity API. Ask whoever set up this " +
        "deployment to turn it on in its Google Cloud project."
      : `Cloud Identity ${operation} failed [http=${status}${reason ? ` ${reason}` : ""}]`);
  }
}

/** Throws unless `address` is one plain lowercase address. */
export function validateGroupMemberAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) throw new Error("Expected one lowercase email address.");
}

export class CloudIdentityApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  /** The group that receives mail at `address`. */
  async lookupGroup(address: string): Promise<CloudIdentityGroup> {
    validateGroupMemberAddress(address);
    const url = new URL(`${BASE}/groups:lookup`);
    url.searchParams.set("groupKey.id", address);
    const {name} = await this.#get(url, "groups.lookup") as {name?: unknown};
    return await this.getGroup(validateGroupName(name));
  }

  async getGroup(name: string): Promise<CloudIdentityGroup> {
    const group = await this.#get(new URL(`${BASE}/${validateGroupName(name)}`), "groups.get") as {
      name?: unknown; groupKey?: {id?: unknown}; additionalGroupKeys?: Array<{id?: unknown}>;
      displayName?: unknown; labels?: Record<string, unknown>;
    };
    if (validateGroupName(group.name) !== name) throw new Error("Cloud Identity returned a different group.");
    if (!group.labels || !(DISCUSSION_FORUM in group.labels)) {
      throw new Error("This Google Group has no mailbox.");
    }
    const address = groupAddress(group.groupKey?.id);
    const aliases = (group.additionalGroupKeys ?? []).map(key => groupAddress(key.id));
    return {
      name,
      address,
      aliases,
      displayName: typeof group.displayName === "string" && group.displayName ? group.displayName : address,
    };
  }

  /**
   * Whether `address` is a direct member of the group named `name`. Membership through a nested
   * group doesn't count. Throws a 403 when the group's "Who can view members" setting excludes
   * the token's account.
   */
  async isDirectMember(name: string, address: string): Promise<boolean> {
    validateGroupMemberAddress(address);
    const lookup = new URL(`${BASE}/${validateGroupName(name)}/memberships:lookup`);
    lookup.searchParams.set("memberKey.id", address);
    try {
      const {name: membership} = await this.#get(lookup, "memberships.lookup") as {name?: unknown};
      if (typeof membership !== "string" || !membership.startsWith(`${name}/memberships/`)) {
        throw new Error("Cloud Identity returned an unexpected membership.");
      }
      return true;
    } catch (error) {
      if (error instanceof CloudIdentityApiError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * The groups with a mailbox that `address` belongs to directly, in address order. Stops after
   * {@link MAX_GROUP_PAGES} pages, which is thousands of groups.
   */
  async listGroupsOf(address: string): Promise<CloudIdentityGroupSummary[]> {
    validateGroupMemberAddress(address);
    const groups: CloudIdentityGroupSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_GROUP_PAGES; page++) {
      const url = new URL(`${BASE}/groups/-/memberships:searchDirectGroups`);
      // Google rejects an `in labels` clause here, so the mailbox label is checked on each result.
      url.searchParams.set("query", `member_key_id == "${address}"`);
      url.searchParams.set("orderBy", "group_key");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const result = await this.#get(url, "memberships.searchDirectGroups") as {
        memberships?: Array<{
          group?: unknown; groupKey?: {id?: unknown}; displayName?: unknown; labels?: Record<string, unknown>;
        }>;
        nextPageToken?: unknown;
      };
      for (const relation of result.memberships ?? []) {
        if (!relation.labels || !(DISCUSSION_FORUM in relation.labels)) continue;
        const group = typeof relation.groupKey?.id === "string" ? relation.groupKey.id.toLowerCase() : "";
        if (!ADDRESS_RE.test(group)) continue;
        groups.push({
          name: validateGroupName(relation.group),
          address: group,
          displayName: typeof relation.displayName === "string" && relation.displayName
            ? relation.displayName : group,
        });
      }
      pageToken = typeof result.nextPageToken === "string" && result.nextPageToken ? result.nextPageToken : undefined;
      if (!pageToken) return groups;
    }
    return groups;
  }

  async #get(url: URL, operation: string): Promise<unknown> {
    const response = await fetchWithAuthRetry(url.toString(), {}, this.getAccessToken);
    if (!response.ok) throw new CloudIdentityApiError(response.status, operation, await errorReason(response));
    return await response.json();
  }
}

/** `value`, when it is a group's resource name, `groups/<id>`; throws otherwise. */
export function validateGroupName(value: unknown): string {
  if (typeof value !== "string" || !GROUP_NAME_RE.test(value)) {
    throw new Error("Not a Google Group resource name.");
  }
  return value;
}

function groupAddress(value: unknown): string {
  const address = typeof value === "string" ? value.toLowerCase() : "";
  validateGroupMemberAddress(address);
  return address;
}

// Google's v1 errors carry the reason in `details`. The message may quote the request, so only the
// reason is kept.
async function errorReason(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_BYTES) return undefined;
    const body = JSON.parse(text) as {error?: {details?: Array<{reason?: unknown}>}};
    const reason = body.error?.details?.find(detail => typeof detail.reason === "string")?.reason;
    return typeof reason === "string" && /^[A-Z_]{1,64}$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}
