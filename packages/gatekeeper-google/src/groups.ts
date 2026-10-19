// Google Groups gatekeeper: read-only access to the Google Groups the connected account can see.
//
// Two resource granularities share this Durable Object class, distinguished by `props.groupEmail`:
//
//   - Whole account (`GoogleGroupsSession`). Searches the organization's groups, lists the groups
//     someone directly belongs to, and opens any group the account can see. Observers: strategy A.
//     Google decides who can see a group, and who can see its members, per group and per person:
//     a hidden group shows up only for its members, and a member list can be limited to a group's
//     members or managers. This binding reaches every group the owner can see, so there is no one
//     a collaborator could be verified against, and addObserver() always throws.
//   - One group (`GoogleGroup`). Its metadata and direct members. Observers: strategy B: a
//     collaborator may observe if their own account can see the group and list its members.
//
// Nothing here writes, so the gatekeeper queues no actions. Every read authorizes an observation
// before returning anything; the reads it makes for itself (resolving a bound group, finding the
// account's organization) return nothing to the caller and are not observations.

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { codeSpan, plainInline } from "@gadgets/gatekeeper-kit/action-description";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache } from "./auth-retry";
import { CursorPager, type CursorPagerOptions } from "./cursor";
import { getGoogleAccountProfile } from "./google-api";
import type { GoogleVerifierApi } from "./google-verifier-types";
import {
  GoogleGroupsApi, groupEmailFromLink, groupSearchQuery, groupsApiDisabled, groupsErrorStatus,
  normalizeEmail, validateGroupName, validateSearchText, type GroupMembershipRecord,
  type GroupSearchField,
} from "./groups-api";
import type {
  Cursor, GoogleGroup, GoogleGroupEntry, GoogleGroupInfo, GoogleGroupMember,
  GoogleGroupMembershipEntry, GoogleGroupsSession,
} from "./groups-types";
import { ApprovalQueueRpcTarget, RpcCursor, SharedApprovalQueue } from "./shared-approval-queue";
import GROUPS_TYPES_CODE from "./groups-types.txt";

type Env = Cloudflare.Env;

export type GoogleGroupsGatekeeperImplProps = {
  userObjectId: string;
  /** The bound group's email address, for a single-group binding; absent for the whole account. */
  groupEmail?: string;
};

/** A group as reads address it, by ID, and as observations name it, by email address. */
type GroupRef = { id: string; email: string };

/** Where a single-group binding keeps the group its email address resolved to. */
const BOUND_GROUP_KEY = "groups:boundGroup";
/** Where the account's organization is kept once found, with the account it was found for. */
const CUSTOMER_KEY = "groups:customer";

/** The fields a search matches, in the order their results are returned. */
const SEARCH_FIELDS: readonly GroupSearchField[] = ["display_name", "group_key"];

const READ_ONLY = "Google Groups connections are read-only and queue no changes.";

/** What every capability of one session shares. */
export type GroupsContext = {
  api: GoogleGroupsApi;
  queue: SharedApprovalQueue;
  /** The connected account's own email address. */
  selfEmail(): Promise<string>;
  /** The customer whose groups a search covers: the connected account's organization. */
  customer(): Promise<string>;
};

async function observe(ctx: GroupsContext, title: string, description: string): Promise<void> {
  await ctx.queue.authorizeObservation({ title, description });
}

function groupLabel(info: GoogleGroupInfo): string {
  return info.name === info.email
    ? codeSpan(info.email) : `"${plainInline(info.name)}" (${codeSpan(info.email)})`;
}

/**
 * How a member read names its group. The ID is what was read: a single-group binding's address is
 * the one it was connected with, which may since have moved to another group.
 */
function refLabel(group: GroupRef): string {
  return `${codeSpan(group.email)} (${codeSpan(group.id)})`;
}

/**
 * A failed read, explained where the cause is known. Google refuses a group that does not exist and
 * one this account cannot see alike, so `refused` names both.
 */
function explained(error: unknown, refused?: string): unknown {
  if (groupsApiDisabled(error)) {
    return new Error(
      "The Cloud Identity API, which Google Groups needs, is not enabled in this deployment's " +
      "Google Cloud project.", { cause: error });
  }
  let status = groupsErrorStatus(error);
  if (refused === undefined || (status !== 403 && status !== 404)) return error;
  return new Error(refused, { cause: error });
}

function cannotSeeGroup(error: unknown, group: string): unknown {
  return explained(error, `No Google Group ${group} exists that this account can see.`);
}

function cannotSeeMembers(error: unknown, group: string): unknown {
  return explained(error, `This account cannot see the members of the Google Group ${group}.`);
}

function groupsCursor<Item, Entry>(
  ctx: GroupsContext, options: Omit<CursorPagerOptions<Item, Entry>, "provider">,
): Cursor<Entry> {
  return new RpcCursor(new CursorPager({ provider: "Google Groups", ...options }), ctx.queue);
}

function disposeGroups(entries: { group: GoogleGroup }[]): void {
  for (let entry of entries) (entry.group as GoogleGroupImpl)[Symbol.dispose]();
}

/**
 * Where a search cursor is: which search it is running and that search's own page token. The
 * token never leaves the gatekeeper.
 */
function parseSearchToken(token: string | undefined): { index: number; providerToken?: string } {
  if (token === undefined) return { index: 0 };
  let colon = token.indexOf(":");
  let index = Number(token.slice(0, colon));
  if (colon < 0 || !Number.isInteger(index) || index < 0 || index >= SEARCH_FIELDS.length) {
    throw new Error("Google Groups search lost its place.");
  }
  let providerToken = token.slice(colon + 1);
  return { index, ...(providerToken ? { providerToken } : {}) };
}

// ── Group capability ────────────────────────────────────────────────

/** One group's metadata and direct members, as either kind of binding hands it out. */
@validateRpc()
export class GoogleGroupImpl extends ApprovalQueueRpcTarget implements GoogleGroup {
  #ctx: GroupsContext;
  #group: GroupRef;

  constructor(ctx: GroupsContext, group: GroupRef) {
    super(ctx.queue);
    this.#ctx = ctx;
    this.#group = group;
  }

  async getInfo(): Promise<GoogleGroupInfo> {
    let { id, email } = this.#group;
    let { info } = await this.#ctx.api.getGroup(id).catch((error: unknown) => {
      throw cannotSeeGroup(error, email);
    });
    await observe(this.#ctx, "Read a Google Group",
      `Read the name, email addresses, description and type of ${groupLabel(info)}.`);
    return info;
  }

  async listMembers(): Promise<Cursor<GoogleGroupMember>> {
    let { id, email } = this.#group;
    return groupsCursor<GoogleGroupMember, GoogleGroupMember>(this.#ctx, {
      fetchPage: pageToken => this.#ctx.api.listMembers(id, pageToken).catch((error: unknown) => {
        throw cannotSeeMembers(error, email);
      }),
      buildEntries: async members => members,
      authorize: members => observe(this.#ctx, "List Google Group members",
        `Read the email addresses and roles of ${members.length} direct member(s) of ` +
        `${refLabel(this.#group)}.`),
    });
  }

  async findMember(email: string): Promise<GoogleGroupMember | null> {
    let address = normalizeEmail(email);
    let { id, email: group } = this.#group;
    let member = await this.#ctx.api.findMember(id, address).catch((error: unknown) => {
      throw cannotSeeMembers(error, group);
    });
    let label = refLabel(this.#group);
    await observe(this.#ctx, "Look up a Google Group member", member
      ? `Found that ${codeSpan(address)} is a direct ${member.role} of ${label}.`
      : `Found that ${codeSpan(address)} is not a direct member of ${label}.`);
    return member;
  }
}

// ── Account session ─────────────────────────────────────────────────

@validateRpc()
export class GoogleGroupsSessionImpl extends ApprovalQueueRpcTarget implements GoogleGroupsSession {
  #ctx: GroupsContext;

  constructor(ctx: GroupsContext) {
    super(ctx.queue);
    this.#ctx = ctx;
  }

  #capability(info: GoogleGroupInfo): GoogleGroupImpl {
    return new GoogleGroupImpl(this.#ctx, { id: info.id, email: info.email });
  }

  async searchGroups(query: string): Promise<Cursor<GoogleGroupEntry>> {
    let text = validateSearchText(query);
    let customer = await this.#ctx.customer();
    // Google documents no way to match either field in one query, so the name search runs to the
    // end and then the email search does, skipping the groups the name search already returned.
    let returned = new Set<string>();
    return groupsCursor<GoogleGroupInfo, GoogleGroupEntry>(this.#ctx, {
      fetchPage: async token => {
        let { index, providerToken } = parseSearchToken(token);
        let page = await this.#ctx.api.searchGroups(
          groupSearchQuery(customer, SEARCH_FIELDS[index], text), providerToken,
        ).catch((error: unknown) => {
          throw explained(error);
        });
        let following = page.nextPageToken !== undefined ? `${index}:${page.nextPageToken}`
          : index + 1 < SEARCH_FIELDS.length ? `${index + 1}:` : undefined;
        return { items: page.items, ...(following !== undefined ? { nextPageToken: following } : {}) };
      },
      buildEntries: async groups => groups
        .filter(info => !returned.has(info.id))
        .map(info => ({ info, group: this.#capability(info) })),
      authorize: async entries => {
        await observe(this.#ctx, "Search Google Groups",
          `Read the names, email addresses, descriptions and types of ${entries.length} group(s) ` +
          "matching a search of the organization's groups.");
        // Only once disclosed: a refused page is offered again, and must not be skipped as seen.
        for (let entry of entries) returned.add(entry.info.id);
      },
      disposeEntries: disposeGroups,
    });
  }

  async listGroupsOf(email?: string): Promise<Cursor<GoogleGroupMembershipEntry>> {
    let member = email === undefined ? await this.#ctx.selfEmail() : normalizeEmail(email);
    return groupsCursor<GroupMembershipRecord, GoogleGroupMembershipEntry>(this.#ctx, {
      fetchPage: pageToken => this.#ctx.api.listGroupsOf(member, pageToken).catch((error: unknown) => {
        throw explained(error);
      }),
      buildEntries: async records => records.map(({ info, role }) => ({
        info, role, group: this.#capability(info),
      })),
      authorize: entries => observe(this.#ctx, "List the Google Groups someone belongs to",
        `Read ${entries.length} group(s) that ${codeSpan(member)} directly belongs to, with ` +
        "their role in each."),
      disposeEntries: disposeGroups,
    });
  }

  async getGroup(emailOrId: string): Promise<GoogleGroupEntry> {
    let reference = emailOrId.trim();
    let id: string;
    let shown = reference;
    if (reference.startsWith("groups/")) {
      id = validateGroupName(reference);
    } else {
      try {
        shown = groupEmailFromLink(reference) ?? normalizeEmail(reference);
      } catch {
        throw new Error(
          "Expected a group's email address, its ID (groups/...), or a link into it of the form " +
          "https://groups.google.com/a/<domain>/g/<name>.");
      }
      let email = shown;
      id = await this.#ctx.api.lookupGroup(email).catch((error: unknown) => {
        throw cannotSeeGroup(error, email);
      });
    }
    let { info } = await this.#ctx.api.getGroup(id).catch((error: unknown) => {
      throw cannotSeeGroup(error, shown);
    });
    await observe(this.#ctx, "Open a Google Group",
      `Read the name, email addresses, description and type of ${groupLabel(info)}.`);
    return { info, group: this.#capability(info) };
  }
}

// ── Gatekeeper Durable Object ───────────────────────────────────────

@validateRpc()
export class GoogleGroupsGatekeeperImpl
    extends DurableObject<Env, GoogleGroupsGatekeeperImplProps>
    implements Gatekeeper<GoogleGroupsSession | GoogleGroup> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });
  #api = new GoogleGroupsApi(opts => this.#tokens.get(opts));

  /**
   * The bound group, for a single-group binding: resolved from its email address on first use and
   * kept by ID from then on, so the binding cannot move to another group if this one's address is
   * later changed or given to a new group.
   */
  async #boundGroup(): Promise<GroupRef | undefined> {
    let { groupEmail } = this.ctx.props;
    if (groupEmail === undefined) return undefined;
    let email = normalizeEmail(groupEmail);
    // Recorded with the address it was resolved from; a facet always serves the same binding, so
    // a different address would mean the record is not this binding's.
    let pinned = this.ctx.storage.kv.get<GroupRef>(BOUND_GROUP_KEY);
    if (pinned?.email === email) return pinned;
    let id = await this.#api.lookupGroup(email).catch((error: unknown) => {
      throw cannotSeeGroup(error, email);
    });
    let bound = { id, email };
    this.ctx.storage.kv.put(BOUND_GROUP_KEY, bound);
    return bound;
  }

  async #profile() {
    return getGoogleAccountProfile(opts => this.#tokens.get(opts));
  }

  async #selfEmail(): Promise<string> {
    let { email } = await this.#profile();
    if (!email) throw new Error("The connected Google account did not report an email address.");
    return normalizeEmail(email);
  }

  /**
   * The connected account's organization, found once per Google account. A reconnect to a different
   * account finds it again, rather than searching the first account's organization.
   */
  async #customer(): Promise<string> {
    let { sub, email } = await this.#profile();
    let cached = this.ctx.storage.kv.get<{ sub: string; customer: string }>(CUSTOMER_KEY);
    if (cached?.sub === sub) return cached.customer;
    if (!email) throw new Error("The connected Google account did not report an email address.");
    let customer = await this.#api.findCustomer(email).catch((error: unknown) => {
      throw explained(error);
    });
    if (customer === null) {
      throw new Error(
        "Could not tell which organization the connected account belongs to, which searching " +
        "needs: the account must belong to a group under its own email domain. listGroupsOf() " +
        "and getGroup() work without that.");
    }
    this.ctx.storage.kv.put(CUSTOMER_KEY, { sub, customer });
    return customer;
  }

  async describe(): Promise<ResourceDescription> {
    let bound = await this.#boundGroup();
    if (bound === undefined) {
      return {
        url: "https://groups.google.com/",
        title: "Google Groups",
        snippet: "Find groups and read their members as the connected account. Read-only.",
        suggestedBindingName: "GOOGLE_GROUPS",
        tsType: "GoogleGroupsSession",
      };
    }
    let { id, email } = bound;
    let { info } = await this.#api.getGroup(id).catch((error: unknown) => {
      throw cannotSeeGroup(error, email);
    });
    return {
      url: info.url,
      title: info.name,
      snippet: `Google Group ${info.email}`,
      suggestedBindingName: "GOOGLE_GROUP",
      tsType: "GoogleGroup",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return GROUPS_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<GoogleGroupsSession | GoogleGroup> {
    let bound = await this.#boundGroup();
    let ctx: GroupsContext = {
      api: this.#api,
      queue: new SharedApprovalQueue(approvalQueue.dup()),
      selfEmail: () => this.#selfEmail(),
      customer: () => this.#customer(),
    };
    return bound === undefined ? new GoogleGroupsSessionImpl(ctx) : new GoogleGroupImpl(ctx, bound);
  }

  async applyAction(_actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async rejectAction(_actionId: number): Promise<void> {
    throw new Error(READ_ONLY);
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error(READ_ONLY);
  }

  /**
   * Observer tracking. A whole-account binding is strategy A: it reaches every group the owner can
   * see, and Google decides who can see each group, and its members, per group and per person, so
   * no collaborator can be verified against it. A single-group binding is strategy B: the
   * collaborator's own account must be able to see the group and list its members, as the binding
   * does. The overseer re-runs this on every open, catching revoked access.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let bound = await this.#boundGroup();
    if (bound === undefined) {
      throw new Error(
        "A whole-account Google Groups connection covers every group the owner can see, including " +
        "hidden groups and member lists only a group's members or managers can view, so it cannot " +
        "be shared with collaborators. Connect a single group instead.");
    }
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasGroupMembersAccess(bound.id))) {
      throw new Error(
        "This collaborator cannot see the bound Google Group and its members, so they cannot " +
        "observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}
