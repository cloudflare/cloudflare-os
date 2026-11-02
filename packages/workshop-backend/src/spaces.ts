// Spaces: a space is a key, a display name, a member list and a listing of the workspaces that
// belong to it (see docs/spaces.md).
//
// Each space is one Durable Object (`SpaceDurableObject`), addressed by the space's key. Nothing
// else holds keys: a key is taken once the object under it has been claimed, and that object's
// member list is the only authority on who belongs to the space. Every member's User DO keeps a
// presentation-only mirror of their memberships, which the space pushes to.
//
// The listing of workspaces runs the other way. Which space a workspace belongs to is recorded by
// its owner's User DO, which registers the workspace here and keeps the entry current; the space
// decides whether that owner may add to it. An entry of the listing is held by the owner it is
// listed under: nobody else updates or drops it. Where a workspace belongs is never decided from
// the listing, which only follows its owner's record. An entry's address within the space, its
// slug, is the space's alone: the space gives it, and no other object knows it.
//
// The listing is a tree: an entry sits at the top or under another entry of the same listing, in
// an order among its siblings. That place is the space's alone too, like the slug: the owner or
// an admin moves the entry (see `SpaceModel.moveWorkspace`), and a registration places only an
// entry that is new, where its owner asks. When an entry leaves the listing, the entries directly
// under it take its place.
//
// A member's role applies to the workspaces the space lists. The owner's User DO asks, for a
// workspace whose record points here, which role a profile's membership gives them on it (see
// `SpaceModel.workspaceRole`), and the space answers with one only for a workspace it lists
// under that owner, so both sides have to agree. The workspace's Overseer combines the answer
// with its own sharing. Each role given out is remembered as a lease. When a member is removed
// or lowered, or a workspace leaves the listing, the leases that no longer hold are queued as
// revocations, which the space's alarm delivers to each workspace's Overseer, so that no open
// session outlives the membership or the listing it was opened through.
//
// A space is never published, but a workspace can be, to everyone signed in to the deployment,
// and its entry says so (`SpaceWorkspaceInfo.published`, which its owner's User DO registers
// with the rest). Someone who is not a member may open the space while such an entry sits at
// the top of its tree, as a visitor: they see its info and the published entries with no
// unpublished entry above them, and nothing else of it. A visitor holds no role in the space,
// so the space gives them none on a workspace and no lease. While it is open to visitors, the
// space is listed in the space directory (`SpaceDirectoryDurableObject`), a presentation-only
// mirror for finding it, which the space pushes to (see `SpaceModel.listed`).
//
// Those same entries are the visible ones, and a workspace's publication admits anyone only
// while it is visible, which its Overseer asks through its owner's User DO and the space
// remembers as a publication lease (see `SpaceModel.workspaceVisible`).
//
// Trust: every method `SpaceDurableObject` exposes takes the acting user as a plain parameter,
// exactly like `OverseerDurableObject.open(userId, profileId, ...)`. Its only callers are
// `AuthenticatedApiImpl` (server.ts) and `UserDurableObject` (user.ts) -- never a client, gadget,
// gatekeeper or agent -- so the parameter is authoritative. A client only ever holds a
// `SpaceClientInterface`, which closes over the caller fixed at open time.
//
// The rules live in `SpaceModel`, pure logic over typed storage so it is unit-testable; the
// Durable Object is a thin shell adding the account lookup, the mirror pushes and the alarm that
// delivers the revocations and the pushes to the space directory.

import { DurableObject } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  MAX_SLUG_LENGTH, PERSONAL_SPACE_PREFIX, isValidSpaceKey, isValidTeamSpaceKey, slugify,
  type AiChatAuthorInfo, type CollaboratorRole, type Space, type SpaceInfo, type SpaceMemberInfo,
  type SpaceMemberRole, type SpaceWorkspaceInfo, type SpaceWorkspaceResolution,
} from "@gadgets/workshop-shared/api";
import {
  makeSpaceStorage, migrateSpaceStorage, PUBLICATION_LEASE, SPACE_STORAGE_VERSION,
  type SpaceDirectoryState, type SpaceLease, type SpaceRecord, type SpaceRevocation,
  type SpaceStorage, type SpaceWorkspaceRecord,
} from "./storage-schema/space-storage.js";
import { PLACEHOLDER_TITLES } from "./storage-schema/overseer-storage.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.spaces");

// The longest key the grammar allows after a personal key's prefix, and the longest name a team
// space can be created with.
const MAX_KEY_LENGTH = 32;
const MAX_SPACE_NAME_LENGTH = 100;

// The former slugs an entry keeps; the oldest fall off. Bounds the record of a workspace whose
// slug is changed over and over, at the cost of its oldest links.
const MAX_FORMER_SLUGS = 32;

// The revocations one run of the alarm attempts, and the bounds of the wait before a revocation
// or a push to the space directory is attempted again, which doubles each time its attempt fails.
const REVOCATION_BATCH = 16;
const RETRY_MS = { first: 1_000, longest: 5 * 60_000 };

// The longest the alarm waits on the space directory to take a push, after which it counts the
// push as not taken, so that a directory which does not answer holds up the revocations no longer.
const DIRECTORY_PUSH_TIMEOUT_MS = 5_000;

// The most steps a walk up the tree takes before taking it for a cycle, which only corrupt
// storage holds: the space refuses every move that would close one.
const MAX_TREE_HOPS = 10_000;

/**
 * The space a claim asks for. Whoever claims it becomes its first admin and, if it is personal,
 * its owner (see `SpaceModel.claim`).
 */
export type SpaceClaim = Pick<SpaceRecord, "key" | "name" | "kind">;

/**
 * What the owner of a workspace registers with a space: the workspace's entry in the listing,
 * less the owner, whom the registering User DO states once for all of them, and the slug and the
 * place in the tree, which are the space's to give. Its `placement` asks the space to place the
 * workspace at the end of the entries under `parentId`, or at the top of the tree, which the
 * space heeds only when it first lists the workspace. A new entry registered without one gets no
 * position, and so sorts with the entries the space has never positioned (see `inOrder`).
 */
export type WorkspaceRegistration =
    Omit<SpaceWorkspaceInfo, "owner" | "slug" | "parentId" | "position">
    & { placement?: { parentId?: string } };

/** Refuses a key that cannot name a space, before a Durable Object is addressed by it. */
export function checkSpaceKey(key: string): void {
  if (!isValidSpaceKey(key)) throw new Error("Invalid space key.");
}

/**
 * Refuses a key that cannot name a team space: the only kind a user creates, and the only kind
 * a workspace is placed in by key.
 */
export function checkTeamSpaceKey(key: string): void {
  if (!isValidTeamSpaceKey(key)) {
    throw new Error(
        "A space key is 2 to 32 lowercase letters, digits and dashes, and cannot start with a dash.");
  }
}

/** The claim `AuthenticatedApi.createSpace(key, name)` makes; refuses a malformed key or name. */
export function teamSpaceClaim(key: string, name: string): SpaceClaim {
  checkTeamSpaceKey(key);
  name = name.trim();
  if (name === "" || name.length > MAX_SPACE_NAME_LENGTH) {
    throw new Error(`A space name is 1 to ${MAX_SPACE_NAME_LENGTH} characters.`);
  }
  return { key, name, kind: "team" };
}

/**
 * The claim to make on the given attempt (1, 2, 3, ...) at a personal space for `owner`: key
 * `~base`, then `~base-2`, `~base-3`, ... where the base is the local part of their profile id
 * (what precedes any `@`; the whole id if that is empty) reduced to the key alphabet and cut so
 * that the suffix still fits the grammar. Deterministic in the profile id, so an allocation that
 * starts over tries the same keys in the same order.
 */
export function personalSpaceClaim(owner: AiChatAuthorInfo, attempt: number): SpaceClaim {
  let suffix = attempt > 1 ? `-${attempt}` : "";
  let base = (owner.id.split("@")[0] || owner.id)
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-/, "")
      .slice(0, MAX_KEY_LENGTH - suffix.length).replace(/-$/, "");
  let key = PERSONAL_SPACE_PREFIX + base.padEnd(2, "0") + suffix;
  return { key, name: owner.name, kind: "personal" };
}

/**
 * The one refusal given both for a key nobody has claimed and for a space the caller is not a
 * member of, so that it does not tell the two apart.
 */
export function noSuchSpace(): Error {
  return new Error("No such space, or you are not a member of it.");
}

// The role a member in `role` holds on each workspace the space lists. A role that is none of
// the three gives none.
function workspaceRoleOf(role: SpaceMemberRole): CollaboratorRole | undefined {
  switch (role) {
    case "admin":
    case "build": return "build";
    case "use": return "use";
    default: return undefined;
  }
}

// An entry of the listing as a member or a visitor is shown it: without the slugs it used to have.
function listed({ formerSlugs: _formerSlugs, ...workspace }: SpaceWorkspaceRecord)
    : SpaceWorkspaceInfo {
  return workspace;
}

// The order of siblings in the tree: by position, then the entries the space has never
// positioned, newest first. Two entries without a position compare as Infinity - Infinity, NaN,
// which falls through to `created` as a tie does.
function inOrder(a: SpaceWorkspaceRecord, b: SpaceWorkspaceRecord): number {
  return (a.position ?? Infinity) - (b.position ?? Infinity)
      || b.created.getTime() - a.created.getTime();
}

// `delivery`, whose attempt at `now` failed, due again after a wait twice as long as its last,
// within `RETRY_MS`.
function retried<T extends { due: number; retryMs: number }>(delivery: T, now: number): T {
  let retryMs = Math.min(RETRY_MS.longest, delivery.retryMs * 2 || RETRY_MS.first);
  return { ...delivery, due: now + retryMs, retryMs };
}

// Puts `entry` under `parentId`, or at the top of the tree when it is undefined, in the record
// alone: the caller writes it.
function setParent(entry: SpaceWorkspaceRecord, parentId: string | undefined): void {
  if (parentId === undefined) delete entry.parentId; else entry.parentId = parentId;
}

/**
 * The rules of one space, over its typed storage: who its members are, which workspaces it
 * lists, the slug each is addressed by, and the role each member holds on them. No RPC and no
 * knowledge of other Durable Objects.
 * Every method that acts for a user takes who they are as a parameter and looks their membership
 * up at that moment, so nothing here trusts an earlier answer.
 */
export class SpaceModel {
  constructor(private storage: SpaceStorage) {}

  /** The space, or undefined while its key is unclaimed. */
  get info(): SpaceRecord | undefined {
    return this.storage.info.get();
  }

  /**
   * The role `profileId` holds in the space, if they are a member of it. A personal space has no
   * members besides its owner, whatever else its member list holds (see `pruneNonOwnerMembers`).
   */
  roleOf(profileId: string): SpaceMemberRole | undefined {
    let info = this.info;
    if (info?.kind === "personal" && info.owner?.id !== profileId) return undefined;
    return this.storage.members.get(profileId)?.role;
  }

  /**
   * Create the space for `creator`, who becomes its first admin and, if it is personal, its
   * owner. Returns whether `creator` now holds the key in the way they asked for. The first
   * claim wins. After that only the owner of a personal space claiming it again gets true, and
   * nothing changes: that is what lets their User DO retry an allocation it could not finish
   * recording. Every other claim of a claimed key gets false and changes nothing either, so a
   * claim can never take a space over.
   */
  claim(claim: SpaceClaim, creator: AiChatAuthorInfo): boolean {
    let existing = this.info;
    if (existing) {
      return claim.kind === "personal" && existing.kind === "personal"
          && existing.owner?.id === creator.id;
    }
    let { key, name, kind } = claim;
    // One transaction: a claim that fails part way must leave the key unclaimed, not held by a
    // space with no admin. A new space's storage is already of the current version.
    this.storage.transaction(() => {
      this.storage.info.put({ key, name, kind, ...(kind === "personal" && { owner: creator }) });
      this.storage.members.put({ profile: creator, role: "admin", added: new Date() });
      this.storage.version.put(SPACE_STORAGE_VERSION);
    });
    return true;
  }

  /**
   * The space as `profileId` sees it: with their role if they are a member, without one if they
   * are a visitor, someone who is not a member of a space with a published workspace at the top
   * of its tree. Undefined if they cannot see it: the key is unclaimed, or they are not a member
   * and no published workspace sits at the top of the tree, so none is visible to them, which
   * callers must not tell apart (see `noSuchSpace`).
   */
  infoFor(profileId: string): SpaceInfo | undefined {
    let info = this.info;
    let role = this.roleOf(profileId);
    if (role) return info && { ...info, role };
    return this.listed ? info : undefined;
  }

  /**
   * Whether the space is open to visitors, because a published workspace sits at the top of its
   * tree (see `infoFor`), and so belongs in the space directory. Every change that can flip it
   * records the new answer for the directory (see `#relist`).
   */
  get listed(): boolean {
    let [publishedRoot] = this.storage.workspaces.byPublishedRoot.list({ limit: 1 });
    return publishedRoot !== undefined;
  }

  /** Space.listMembers: any member. A personal space lists its owner alone (see `roleOf`). */
  listMembers(caller: string): SpaceMemberInfo[] {
    this.#requireMember(caller);
    let { kind, owner } = this.info!;
    let members = [...this.storage.members.list()];
    return kind === "team" ? members : members.filter(m => m.profile.id === owner?.id);
  }

  /**
   * Refuses a `caller` who may not set members' roles: anyone but an admin, and everyone in a
   * personal space, which has no members besides its owner (who may still `removeMember` one
   * left there). Callers check this before resolving a username, so that only an admin of a team
   * space learns whether an account exists.
   */
  requireMembershipAdmin(caller: string): void {
    if (this.#requireMember(caller) !== "admin") {
      throw new Error("Only an admin of this space can change its members.");
    }
    if (this.info!.kind === "personal") throw new Error("A personal space has no members.");
  }

  /**
   * Space.setMemberRole, once the username has been resolved to the existing account `profile`:
   * makes them a member in exactly `role`, whether that adds, raises or lowers them. Lowering
   * them to a role that gives less on the space's workspaces revokes their leases. Refused in a
   * personal space, whoever the target (see `requireMembershipAdmin`).
   */
  setMemberRole(caller: string, profile: AiChatAuthorInfo, role: SpaceMemberRole): SpaceMemberInfo {
    this.requireMembershipAdmin(caller);
    if (role !== "admin") this.#keepAnAdmin(profile.id);
    let existing = this.storage.members.get(profile.id);
    let member: SpaceMemberInfo = { profile, role, added: existing?.added ?? new Date() };
    this.storage.members.put(member);
    if (existing && workspaceRoleOf(existing.role) === "build" && workspaceRoleOf(role) === "use") {
      this.#revoke(this.storage.leases.byProfile.get(profile.id));
    }
    return member;
  }

  /**
   * Space.removeMember: an admin removes anyone, any other member only themself. Returns
   * whether `profileId` was a member. Their leases are revoked: only a member's, so that no
   * other id, `PUBLICATION_LEASE` among them, revokes anything.
   */
  removeMember(caller: string, profileId: string): boolean {
    if (this.#requireMember(caller) !== "admin" && caller !== profileId) {
      throw new Error("Only an admin of this space can remove other members.");
    }
    this.#keepAnAdmin(profileId);
    if (!this.storage.members.delete(profileId)) return false;
    this.#revoke(this.storage.leases.byProfile.get(profileId));
    return true;
  }

  /**
   * Removes every member a personal space holds besides its owner, who hold no role there (see
   * `roleOf`), as the owner removing them would: their leases are revoked. Returns their profile
   * ids, whose mirrors may still list the space. A team space has none to remove.
   */
  pruneNonOwnerMembers(): string[] {
    let info = this.info;
    let owner = info?.kind === "personal" ? info.owner : undefined;
    if (!owner) return [];
    let others = [...this.storage.members.list()]
        .map(({ profile }) => profile.id).filter(id => id !== owner.id);
    for (let id of others) this.removeMember(owner.id, id);
    return others;
  }

  /**
   * Whether `profileId` may add workspaces they own to the space: only its owner if it is
   * personal, any member whatever their role if it is a team space.
   */
  canAddWorkspaces(profileId: string): boolean {
    let info = this.info;
    return info?.kind === "personal" ? info.owner?.id === profileId : !!this.roleOf(profileId);
  }

  /**
   * List `owner`'s workspaces in the space, or bring the entries it already holds for them up to
   * date. Returns false, having changed nothing, if any of them is refused, so that a caller
   * handles a refusal without matching an error's text.
   *
   * A workspace the space does not list yet needs `canAddWorkspaces(owner.id)`. One it lists
   * under this owner is updated whether or not they may still add, which is what lets a
   * workspace keep its place after its owner leaves the space. One it lists under someone else
   * is refused.
   *
   * An entry keeps its slug and former slugs through an update, so no later title moves a slug.
   * One that has no slug is given one (see `#deriveSlug`) the first time it is written with a
   * title that is not one of `PLACEHOLDER_TITLES`. Its place in the tree is kept likewise, so
   * only a new entry is placed, and only if it is registered with a `placement`: under the
   * `parentId` that asks for if the space lists that one, and otherwise at the top of the tree,
   * at a position that counts its siblings there, which puts it after every one the space has
   * positioned (see `inOrder`).
   *
   * An entry that stops being published hides the entries under it, whose publication leases
   * are revoked with its own (see `workspaceVisible`). One that is published in a lower role
   * hides nothing: an entry is visible whatever role the entries above it are published with.
   */
  attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[]): boolean {
    let mayAdd = this.canAddWorkspaces(owner.id);
    for (let { id } of registrations) {
      let entry = this.storage.workspaces.get(id);
      if (entry ? entry.owner.id !== owner.id : !mayAdd) return false;
    }
    let unpublished = false;
    for (let { id, title, created, published, placement } of registrations) {
      let existing = this.storage.workspaces.get(id);
      unpublished ||= !!existing?.published && !published;
      let entry: SpaceWorkspaceRecord = { ...existing, id, title, owner, created, published };
      // A registration says whether the workspace is published, so one that does not ends it.
      if (!published) delete entry.published;
      if (entry.slug === undefined && !PLACEHOLDER_TITLES.includes(title)) {
        entry.slug = this.#deriveSlug(title);
      }
      // A new entry is not stored yet, so a parent the space lists is another entry.
      if (!existing && placement) {
        let { parentId } = placement;
        let parentListed = parentId !== undefined && !!this.storage.workspaces.get(parentId);
        setParent(entry, parentListed ? parentId : undefined);
        entry.position = this.#siblings(entry.parentId).length;
      }
      this.storage.workspaces.put(entry);
    }
    if (unpublished) this.#revokeHidden();
    this.#relist();
    return true;
  }

  /**
   * Drop workspace `id` from the listing if `ownerId` is who it is listed under. Its slug and
   * former slugs go with the entry, and are free again, and every lease on it is revoked, its
   * publication lease among them. The entries directly under it take its place in the tree:
   * they move under its parent, in their order, where it stood among its siblings, so none of
   * them is hidden by the move.
   */
  detachWorkspace(id: string, ownerId: string): void {
    let entry = this.storage.workspaces.get(id);
    if (entry?.owner.id !== ownerId) return;
    let children = this.#siblings(id);
    let siblings = this.#siblings(entry.parentId)
        .flatMap(sibling => sibling.id === id ? children : [sibling]);
    // Every child changes parent, so each is written; the renumbering writes what else changes.
    for (let child of children) {
      setParent(child, entry.parentId);
      this.storage.workspaces.put(child);
    }
    this.storage.workspaces.delete(id);
    this.#renumber(siblings);
    this.#revoke(this.storage.leases.list({ prefix: `${id}:` }));
    this.#relist();
  }

  /**
   * The role `profileId` holds on workspace `id` as a member of the space, if the space lists
   * that workspace under owner `ownerId`: "build" for an admin or a "build" member, "use" for a
   * "use" member. Undefined for anyone who is not a member, and for a workspace the space does
   * not list or lists under another owner.
   *
   * An answer with a role is remembered as a lease, so that the workspace is told when it no
   * longer holds (see `#revoke`).
   */
  workspaceRole(id: string, ownerId: string, profileId: string): CollaboratorRole | undefined {
    let member = this.roleOf(profileId);
    let role = member && workspaceRoleOf(member);
    if (!role || this.storage.workspaces.get(id)?.owner.id !== ownerId) return undefined;
    this.storage.leases.put({ workspace: id, profile: profileId });
    return role;
  }

  /**
   * Whether workspace `id` is visible: listed under owner `ownerId`, and published, as is every
   * entry above it in the tree, which is what a visitor is shown (see `listWorkspaces`). Only
   * while it is does its publication admit anyone.
   *
   * An answer that it is visible is remembered as a publication lease, which is taken back,
   * like a member's, once the answer may no longer hold: when an entry on the workspace's chain
   * stops being published or a move puts it under one that is not (`#revokeHidden`), and when
   * it leaves the listing (`detachWorkspace`).
   */
  workspaceVisible(id: string, ownerId: string): boolean {
    let entry = this.storage.workspaces.get(id);
    if (entry?.owner.id !== ownerId || this.#unpublished(entry)) return false;
    this.storage.leases.put({ workspace: id, profile: PUBLICATION_LEASE });
    return true;
  }

  /**
   * Up to `limit` of the queued revocations that are due at `now`, the longest due first: so
   * one never attempted comes before every one that has failed.
   */
  dueRevocations(now: number, limit: number): SpaceRevocation[] {
    let due: SpaceRevocation[] = [];
    // The index counts its `limit` in due times, and revocations queued together share one.
    for (let revocation of this.storage.revocations.byDue.list({ end: now + 1, limit })) {
      if (due.push(revocation) === limit) break;
    }
    return due;
  }

  /** When the queued revocation to attempt next is due, or undefined if none is queued. */
  nextRevocationDue(): number | undefined {
    let [next] = this.storage.revocations.byDue.list({ limit: 1 });
    return next?.due;
  }

  /** Takes `revocation` off the queue, once its workspace's Overseer has answered it. */
  delivered(revocation: SpaceRevocation): void {
    this.storage.revocations.delete(revocation.seq);
  }

  /**
   * Keeps `revocation`, whose attempt at `now` its workspace's Overseer did not answer, for
   * another after a wait twice as long as its last, within `RETRY_MS`.
   */
  deferred(revocation: SpaceRevocation, now: number): void {
    this.storage.revocations.put(retried(revocation, now));
  }

  /**
   * The state last recorded for the space directory (see `#relist`), while it is still to push:
   * at `due`, which is later than now while it waits out a failed attempt.
   */
  get pendingDirectoryPush(): SpaceDirectoryState | undefined {
    let state = this.storage.directory.get();
    return state?.pushed === false ? state : undefined;
  }

  /**
   * Records that the space directory took `state`, unless a newer state has been recorded since,
   * which is still to push.
   */
  directoryPushed(state: SpaceDirectoryState): void {
    if (this.storage.directory.get()?.rev === state.rev) {
      this.storage.directory.put({ ...state, pushed: true });
    }
  }

  /**
   * Keeps `state`, whose push at `now` the space directory did not take, for another attempt as
   * a revocation is kept (see `deferred`), unless a newer state has been recorded since, which
   * is due at once.
   */
  directoryPushDeferred(state: SpaceDirectoryState, now: number): void {
    if (this.storage.directory.get()?.rev === state.rev) {
      this.storage.directory.put(retried(state, now));
    }
  }

  /**
   * Space.listWorkspaces: any member, and a visitor for the published entries with no
   * unpublished entry above them, each positioned among the siblings they are shown, so that no
   * gap tells of one hidden from them. In depth-first pre-order: each entry before the entries
   * under it, and siblings in their order (see `inOrder`). A published entry with an unpublished
   * one above it, which only a member is shown, names the nearest such one as `hiddenBy`.
   */
  listWorkspaces(caller: string): SpaceWorkspaceInfo[] {
    let visiting = this.#visiting(caller);
    let entries = [...this.storage.workspaces.list()];
    let ids = new Set(entries.map(entry => entry.id));
    // An entry whose parent the listing does not hold, which only corrupt storage leaves, is
    // shown at the top of the tree.
    for (let entry of entries) {
      if (entry.parentId !== undefined && !ids.has(entry.parentId)) delete entry.parentId;
    }
    // An unpublished entry is left out for a visitor, and so is everything under it, which is
    // reached only through it.
    let shown = visiting ? entries.filter(entry => entry.published) : entries;
    let children = Map.groupBy(shown.toSorted(inOrder), entry => entry.parentId);
    // The positioned siblings sort first, so each one's index is its rank among those shown.
    if (visiting) {
      for (let siblings of children.values()) {
        siblings.forEach((entry, index) => {
          if (entry.position !== undefined) entry.position = index;
        });
      }
    }
    // Each entry is reached only through its one parent, so this ends, and leaves out an entry
    // on a cycle, which corrupt storage alone could hold. Each is pending with the nearest
    // unpublished entry above it, if there is one.
    let under = (parentId: string | undefined, hiddenBy?: string) =>
        (children.get(parentId) ?? []).map(entry => ({ entry, hiddenBy })).toReversed();
    let pending = under(undefined);
    let listing: SpaceWorkspaceInfo[] = [];
    while (pending.length > 0) {
      let { entry, hiddenBy } = pending.pop()!;
      listing.push({ ...listed(entry), ...(entry.published && hiddenBy && { hiddenBy }) });
      pending.push(...under(entry.id, entry.published ? hiddenBy : entry.id));
    }
    return listing;
  }

  /**
   * Space.resolveWorkspace: any member, and a visitor for the slugs of the entries the listing
   * shows them, each as the listing shows it.
   */
  resolveWorkspace(caller: string, slug: string): SpaceWorkspaceResolution | null {
    let visiting = this.#visiting(caller);
    let resolution = this.#resolve(slug);
    if (!resolution) return null;
    let { workspace } = resolution;
    if (!visiting) {
      let hiddenBy = workspace.published && this.#unpublished(workspace)?.id;
      return hiddenBy ? { ...resolution, workspace: { ...workspace, hiddenBy } } : resolution;
    }
    let shown = this.listWorkspaces(caller).find(({ id }) => id === workspace.id);
    return shown ? { ...resolution, workspace: shown } : null;
  }

  /**
   * Space.setWorkspaceSlug: a member who is the owner workspace `id` is listed under, or an
   * admin. The slug the entry had stays with it as a former one, the oldest falling off past
   * `MAX_FORMER_SLUGS`. A slug asked for by name is refused while another entry uses it, but is
   * taken from an entry that only used to: whoever asks knows the address they want, and that
   * slug stops resolving to the other workspace.
   */
  setWorkspaceSlug(caller: string, id: string, slug: string): SpaceWorkspaceInfo {
    let entry = this.#editable(caller, id, "change its slug");
    if (entry.slug === slug) return listed(entry);
    // slugify() never returns the empty string, so this refuses one too.
    if (slugify(slug) !== slug) {
      throw new Error(`A slug is 1 to ${MAX_SLUG_LENGTH} lowercase letters and digits, in groups `
          + "joined by single dashes.");
    }
    if (this.storage.workspaces.bySlug.get(slug)) {
      throw new Error("Another workspace of this space already uses that slug.");
    }
    // Collected before any write: a put re-indexes its record, which would end a live listing.
    let holders = [...this.storage.workspaces.byFormerSlug.get(slug)];
    for (let holder of holders) {
      this.storage.workspaces.put(
          { ...holder, formerSlugs: holder.formerSlugs?.filter(former => former !== slug) });
    }
    let formerSlugs = [entry.formerSlugs ?? [], entry.slug ?? []].flat()
        .filter(former => former !== slug).slice(-MAX_FORMER_SLUGS);
    entry = { ...entry, slug, formerSlugs };
    this.storage.workspaces.put(entry);
    return listed(entry);
  }

  /**
   * Space.moveWorkspace: the same callers as `setWorkspaceSlug`. Puts the entry of workspace
   * `id`, and with it the entries under it, under `parentId`, or at the top of the tree when it
   * is null, immediately before its sibling `beforeId`, or after the last of its siblings when
   * `beforeId` is not one of them. Under an entry that is not visible, none of those entries
   * is, and their publication leases are revoked (see `workspaceVisible`).
   */
  moveWorkspace(caller: string, id: string, parentId: string | null, beforeId?: string): void {
    this.#move(this.#editable(caller, id, "move it"), parentId ?? undefined, beforeId);
  }

  // The entry of workspace `id`, for a `caller` who may change its slug and its place in the
  // tree: a member who is the owner it is listed under, or an admin. Anyone else is refused, as
  // someone who may not `act`.
  #editable(caller: string, id: string, act: string): SpaceWorkspaceRecord {
    let role = this.#requireMember(caller);
    let entry = this.storage.workspaces.get(id);
    if (!entry) throw new Error("This space does not list that workspace.");
    if (role !== "admin" && entry.owner.id !== caller) {
      throw new Error(`Only a workspace's owner or an admin of this space can ${act}.`);
    }
    return entry;
  }

  // Puts `entry` under `parentId` (see `moveWorkspace`), positioning the siblings it leaves and
  // the ones it joins.
  #move(entry: SpaceWorkspaceRecord, parentId: string | undefined, beforeId?: string): void {
    this.#checkParent(parentId, entry.id);
    let reparented = entry.parentId !== parentId;
    if (reparented) this.#renumber(this.#siblings(entry.parentId, entry.id));
    let siblings = this.#siblings(parentId, entry.id);
    let before = siblings.findIndex(sibling => sibling.id === beforeId);
    siblings.splice(before < 0 ? siblings.length : before, 0, entry);
    setParent(entry, parentId);
    // Written whether or not the renumbering writes it, which it does only for a new position.
    this.storage.workspaces.put(entry);
    this.#renumber(siblings);
    if (reparented) this.#revokeHidden();
    this.#relist();
  }

  // Refuses `parentId` as the parent of entry `id`: an entry the listing does not hold, and `id`
  // itself or an entry under it, which would close a cycle. The top of the tree, undefined, is
  // never refused.
  #checkParent(parentId: string | undefined, id: string): void {
    if (parentId === undefined) return;
    let parent = this.storage.workspaces.get(parentId);
    if (!parent) throw new Error("No such parent workspace in this space.");
    for (let ancestor of this.#ancestry(parent)) {
      if (ancestor.id === id) throw new Error("A workspace cannot be moved under itself.");
    }
  }

  // The entries directly under `parentId`, or at the top of the tree when it is undefined, in
  // their order, less `excluding`.
  #siblings(parentId: string | undefined, excluding?: string): SpaceWorkspaceRecord[] {
    return [...this.storage.workspaces.byParent.get(parentId ?? "")]
        .filter(entry => entry.id !== excluding).toSorted(inOrder);
  }

  // Positions `siblings`, which are in the order they are to have, from 0, writing each entry
  // whose position that changes and no other. An entry the space never positioned gets one.
  #renumber(siblings: SpaceWorkspaceRecord[]): void {
    siblings.forEach((entry, position) => {
      if (entry.position === position) return;
      entry.position = position;
      this.storage.workspaces.put(entry);
    });
  }

  // The first entry from `entry` up the tree that is not published, if any: while there is one,
  // `entry` is not visible (see `workspaceVisible`).
  #unpublished(entry: SpaceWorkspaceInfo): SpaceWorkspaceInfo | undefined {
    for (let ancestor of this.#ancestry(entry)) {
      if (!ancestor.published) return ancestor;
    }
    return undefined;
  }

  // `entry`, then each entry above it in the tree, up to one at the top. A parent the listing
  // does not hold ends the walk, as if the entry under it sat at the top.
  *#ancestry(entry: SpaceWorkspaceInfo | undefined): Generator<SpaceWorkspaceInfo> {
    for (let hops = 0; entry; hops++) {
      if (hops > MAX_TREE_HOPS) throw new Error("The space's tree is cyclic.");
      yield entry;
      entry = entry.parentId === undefined
          ? undefined : this.storage.workspaces.get(entry.parentId);
    }
  }

  // The slug `title` leads to, or with the first of `-2`, `-3`, ... appended that makes it one no
  // entry has or used to have, cut so that the suffix still fits `MAX_SLUG_LENGTH`: every slug a
  // space gives is one that can be asked for by name. A former slug still resolves to the entry
  // that gave it up, so a derived slug never takes an old link over.
  #deriveSlug(title: string): string {
    let base = slugify(title);
    let slug = base;
    for (let n = 2; this.#resolve(slug); n++) {
      let suffix = `-${n}`;
      slug = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-$/, "") + suffix;
    }
    return slug;
  }

  // The workspace `slug` addresses: the entry that has it now, otherwise the one that used to.
  #resolve(slug: string): SpaceWorkspaceResolution | undefined {
    let current = this.storage.workspaces.bySlug.get(slug);
    if (current) return { workspace: listed(current), canonical: true };
    let [former] = this.storage.workspaces.byFormerSlug.get(slug);
    return former && { workspace: listed(former), canonical: false };
  }

  // Takes `leases` back: each leaves the leases and joins the queue of revocations, for its
  // workspace's Overseer to end whatever session it gave the role to. A lease given out again
  // before that is delivered is a new lease, and the revocation still goes out.
  #revoke(leases: Iterable<SpaceLease>): void {
    // Collected before any write, which would end a live listing.
    let revoked = [...leases];
    for (let lease of revoked) {
      this.storage.leases.deleteRecord(lease);
      this.#queue(lease);
    }
  }

  // Takes back every publication lease whose workspace is no longer visible (see
  // `workspaceVisible`), after a change that may have hidden some.
  #revokeHidden(): void {
    let leases = [...this.storage.leases.byProfile.get(PUBLICATION_LEASE)];
    this.#revoke(leases.filter(({ workspace }) => {
      let entry = this.storage.workspaces.get(workspace);
      return !entry || !!this.#unpublished(entry);
    }));
  }

  // Records whether the space is `listed`, for the space directory, if the state it last recorded
  // says otherwise, or is absent while it is listed: with a higher `rev`, not yet pushed, and due
  // at once. Called after every change that can flip it, which writes an entry's `published` or
  // `parentId`; any other change leaves the state as it is.
  #relist(): void {
    let isListed = this.listed;
    let state = this.storage.directory.get();
    if (isListed === (state?.listed ?? false)) return;
    this.storage.directory.put(
        { listed: isListed, rev: (state?.rev ?? 0) + 1, pushed: false, due: 0, retryMs: 0 });
  }

  // Queues a revocation of `lease`, due at once.
  #queue({ workspace, profile }: SpaceLease): void {
    let seq = this.storage.nextRevocation.get();
    this.storage.nextRevocation.put(seq + 1);
    this.storage.revocations.put({ seq, workspace, profile, due: 0, retryMs: 0 });
  }

  // Refuses a `caller` who is not a member, a visitor included, as an unclaimed key is refused.
  #requireMember(caller: string): SpaceMemberRole {
    let role = this.roleOf(caller);
    if (!role) throw noSuchSpace();
    return role;
  }

  // Refuses a `caller` the space is not open to, and says whether they see it as a visitor,
  // who is shown only the published entries with no unpublished entry above them, and not as a
  // member.
  #visiting(caller: string): boolean {
    let info = this.infoFor(caller);
    if (!info) throw noSuchSpace();
    return info.role === undefined;
  }

  // Refuses to take the admin role from `profileId` if they are the space's last admin. A
  // personal space's owner is its only member, and so its only admin: this is also what keeps
  // the owner from leaving it or being removed.
  #keepAnAdmin(profileId: string): void {
    if (this.roleOf(profileId) !== "admin") return;
    for (let member of this.storage.members.list()) {
      if (member.role === "admin" && member.profile.id !== profileId) return;
    }
    throw new Error("A space must keep at least one admin.");
  }
}

/** One space, addressed by `getByName(spaceKey)`. Reachable from kernel code only (see above). */
export class SpaceDurableObject extends DurableObject<Cloudflare.Env> {
  #model: SpaceModel;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    let storage = makeSpaceStorage(ctx.storage);
    this.#model = new SpaceModel(storage);
    // Before any event is delivered, the storage is brought up to date, and then a personal
    // space's members besides its owner are removed, their mirrors told without waiting
    // (`#mirror` logs a failure, healed on the member's next open), and the alarm is set for what
    // is left to deliver. A failure is logged, not thrown, which would reset the object, and what
    // it leaves undone is done on a later wake.
    // Until then whoever is left in a personal space has no role, and the tree's indexes miss
    // the entries stored before them: none of those opens the space to a non-member (see
    // `SpaceModel.infoFor`), and placing, moving or dropping an entry may misorder its siblings,
    // leave an entry under one that left, or fail.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        migrateSpaceStorage(storage);
        let pruned = this.#model.pruneNonOwnerMembers();
        await this.#setAlarm();
        for (let profileId of pruned) void this.#mirror(profileId);
      } catch (error) {
        logger.error("failed to bring a space up to date as it woke", {
          event: "space.wake.failed", durableObjectId: this.ctx.id.toString(), error,
        });
      }
    });
  }

  /**
   * `SpaceModel.claim`. Pushes nothing to the claimant's mirror: a User DO claiming its personal
   * space records it itself, and the creator of a team space gets it by opening the space.
   */
  async claim(claim: SpaceClaim, creator: AiChatAuthorInfo): Promise<boolean> {
    return this.#model.claim(claim, creator);
  }

  /**
   * Open the space as `caller`, a profile id. Returns the capability handed to their client, or
   * null if they cannot open it: the key is unclaimed, or they are not a member and no published
   * workspace sits at the top of the space's tree, which the answer does not tell apart. The
   * caller's mirror is brought in line first (see `#mirror`), so a push that was lost heals the
   * next time they open the space. A visitor gets the same capability as a member, which decides
   * on each call what its caller may do, and their mirror gets nothing: it holds memberships
   * only.
   */
  async open(caller: string): Promise<Space | null> {
    await this.#mirror(caller);
    return this.#model.infoFor(caller) ? new SpaceClientInterface(this, caller) : null;
  }

  /** Space.getInfo, as `caller`. */
  async getInfo(caller: string): Promise<SpaceInfo> {
    let info = this.#model.infoFor(caller);
    if (!info) throw noSuchSpace();
    return info;
  }

  /** Space.listMembers, as `caller`. */
  async listMembers(caller: string): Promise<SpaceMemberInfo[]> {
    return this.#model.listMembers(caller);
  }

  /** Space.setMemberRole, as `caller`. */
  async setMemberRole(caller: string, username: string, role: SpaceMemberRole)
      : Promise<SpaceMemberInfo | null> {
    // Authorize before the lookup, so a caller who is not an admin learns nothing about which
    // accounts exist.
    this.#model.requireMembershipAdmin(caller);
    let profile = await this.ctx.exports.UserDurableObject.getByName(username).whoamiIfExists();
    if (!profile) return null;
    let member = this.#model.setMemberRole(caller, profile, role);
    await this.#setAlarm();
    await this.#mirror(profile.id);
    return member;
  }

  /** Space.removeMember, as `caller`. */
  async removeMember(caller: string, profileId: string): Promise<void> {
    let removed = this.#model.removeMember(caller, profileId);
    await this.#setAlarm();
    if (removed) await this.#mirror(profileId);
  }

  /** Space.listWorkspaces, as `caller`. */
  async listWorkspaces(caller: string): Promise<SpaceWorkspaceInfo[]> {
    return this.#model.listWorkspaces(caller);
  }

  /** Space.resolveWorkspace, as `caller`. */
  async resolveWorkspace(caller: string, slug: string): Promise<SpaceWorkspaceResolution | null> {
    return this.#model.resolveWorkspace(caller, slug);
  }

  /** Space.setWorkspaceSlug, as `caller`. */
  async setWorkspaceSlug(caller: string, id: string, slug: string): Promise<SpaceWorkspaceInfo> {
    return this.#model.setWorkspaceSlug(caller, id, slug);
  }

  /** Space.moveWorkspace, as `caller`. */
  async moveWorkspace(caller: string, id: string, parentId: string | null, beforeId?: string)
      : Promise<void> {
    this.#model.moveWorkspace(caller, id, parentId, beforeId);
    await this.#setAlarm();
  }

  /**
   * `SpaceModel.attachWorkspaces`. Called only by the User DO of `owner`, which states its own
   * user's profile, so every workspace it registers is one that user owns.
   */
  async attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[])
      : Promise<boolean> {
    let attached = this.#model.attachWorkspaces(owner, registrations);
    await this.#setAlarm();
    return attached;
  }

  /** `SpaceModel.detachWorkspace`. Called only by the User DO of `ownerId`, as above. */
  async detachWorkspace(id: string, ownerId: string): Promise<void> {
    this.#model.detachWorkspace(id, ownerId);
    await this.#setAlarm();
  }

  /**
   * `SpaceModel.workspaceRole`. Called only by the User DO of `ownerId`, as above, for a
   * workspace its record points at this space, on behalf of that workspace's Overseer.
   */
  async workspaceRole(id: string, ownerId: string, profileId: string)
      : Promise<CollaboratorRole | null> {
    return this.#model.workspaceRole(id, ownerId, profileId) ?? null;
  }

  /** `SpaceModel.workspaceVisible`, called like `workspaceRole`. */
  async workspaceVisible(id: string, ownerId: string): Promise<boolean> {
    return this.#model.workspaceVisible(id, ownerId);
  }

  /**
   * Delivers the queued revocations that are due, so many in a run: tells each one's workspace
   * that the profile no longer holds a role through this space, or for a publication lease that
   * the workspace may no longer be visible (`OverseerDurableObject.revokeSpaceAccess`), and takes
   * it off the queue only once that call has returned. One whose call fails is kept for a later
   * run (`SpaceModel.deferred`), which holds up no other. Beside them it pushes the space's
   * state to the space directory, if that is due, waiting on it for a bounded time (see
   * `#pushToDirectory`). While anything remains the alarm is set again, for when the next is due.
   */
  async alarm(): Promise<void> {
    let overseers = this.ctx.exports.OverseerDurableObject;
    let due = this.#model.dueRevocations(Date.now(), REVOCATION_BATCH);
    await Promise.all([this.#pushToDirectory(), ...due.map(async revocation => {
      try {
        await overseers.get(overseers.idFromString(revocation.workspace))
            .revokeSpaceAccess(revocation.profile);
        this.#model.delivered(revocation);
      } catch (error) {
        this.#model.deferred(revocation, Date.now());
        logger.warn("failed to deliver a space revocation to its workspace", {
          event: "space.revocation.deliver.failed", gadgetId: revocation.workspace,
          durableObjectId: this.ctx.id.toString(), error,
        });
      }
    })]);
    await this.#setAlarm();
  }

  // Pushes whether the space is listed to the space directory, if a push is due (see
  // `SpaceModel.pendingDirectoryPush`). Best-effort: the directory is a mirror, and a push it
  // does not take within `DIRECTORY_PUSH_TIMEOUT_MS` is kept for a later run of the alarm, which
  // waits longer each time. One that lands after all is harmless: the directory keeps the newest.
  async #pushToDirectory(): Promise<void> {
    let state = this.#model.pendingDirectoryPush;
    if (!state || state.due > Date.now()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.ctx.exports.SpaceDirectoryDurableObject.getByName("")
            .syncSpace(this.#model.info!, state.listed, state.rev),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("The space directory did not answer in time.")),
              DIRECTORY_PUSH_TIMEOUT_MS);
        }),
      ]);
      this.#model.directoryPushed(state);
    } catch (error) {
      this.#model.directoryPushDeferred(state, Date.now());
      logger.warn("failed to push a space's listing to the space directory", {
        event: "space.directory.push.failed", durableObjectId: this.ctx.id.toString(), error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Sets the alarm for when the next queued revocation or push to the space directory is due,
  // which for one just queued is now. Called in the same turn as the change that may have queued
  // one, so that the two are stored together.
  async #setAlarm(): Promise<void> {
    let due = Math.min(this.#model.nextRevocationDue() ?? Infinity,
        this.#model.pendingDirectoryPush?.due ?? Infinity);
    if (due < Infinity) await this.ctx.storage.setAlarm(Math.max(due, Date.now()));
  }

  // Bring `profileId`'s mirror of this space in line with their membership as it stands now.
  // Best-effort: the member list is already written and is the authority, and a mirror this
  // fails to reach is corrected the next time its user opens the space.
  async #mirror(profileId: string): Promise<void> {
    // An unclaimed key has never had a member, so no mirror holds it.
    let key = this.#model.info?.key;
    if (!key) return;
    let user = this.ctx.exports.UserDurableObject.getByName(profileId);
    // A visitor's info has no role, and is no membership to record.
    let info = this.#model.infoFor(profileId);
    let membership = info?.role ? info : undefined;
    try {
      await (membership ? user.recordSpaceMembership(membership) : user.forgetSpace(key));
    } catch (error) {
      logger.warn("failed to mirror a space membership to its member", {
        event: "space.membership.mirror.failed", operation: membership ? "record" : "forget",
        durableObjectId: this.ctx.id.toString(), error,
      });
    }
  }
}

/**
 * The client-facing capability for one space, minted by `SpaceDurableObject.open()`. It acts as
 * `caller`, the profile id fixed at open time, and holds no permission of its own: every method
 * has the space resolve again whether that user is a member, a visitor or neither.
 */
@validateRpc()
class SpaceClientInterface extends RpcTarget implements Space {
  constructor(private space: SpaceDurableObject, private caller: string) {
    super();
  }

  getInfo(): Promise<SpaceInfo> {
    return this.space.getInfo(this.caller);
  }

  listMembers(): Promise<SpaceMemberInfo[]> {
    return this.space.listMembers(this.caller);
  }

  listWorkspaces(): Promise<SpaceWorkspaceInfo[]> {
    return this.space.listWorkspaces(this.caller);
  }

  resolveWorkspace(slug: string): Promise<SpaceWorkspaceResolution | null> {
    return this.space.resolveWorkspace(this.caller, slug);
  }

  setWorkspaceSlug(id: string, slug: string): Promise<SpaceWorkspaceInfo> {
    return this.space.setWorkspaceSlug(this.caller, id, slug);
  }

  moveWorkspace(id: string, parentId: string | null, beforeId?: string): Promise<void> {
    return this.space.moveWorkspace(this.caller, id, parentId, beforeId);
  }

  setMemberRole(username: string, role: SpaceMemberRole): Promise<SpaceMemberInfo | null> {
    return this.space.setMemberRole(this.caller, username, role);
  }

  removeMember(profileId: string): Promise<void> {
    return this.space.removeMember(this.caller, profileId);
  }
}
