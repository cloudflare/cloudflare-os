// Spaces: a space is a key, a display name, a member list and a listing of the workspaces that
// belong to it (see docs/spaces.md).
//
// Each space is one Durable Object (`SpaceDurableObject`), addressed by the space's key. There is
// no directory of spaces: a key is taken once the object under it has been claimed, and that
// object's member list is the only authority on who belongs to the space. Every member's User DO
// keeps a presentation-only mirror of their memberships, which the space pushes to.
//
// The listing of workspaces runs the other way. Which space a workspace belongs to is recorded by
// its owner's User DO, which registers the workspace here and keeps the entry current; the space
// decides whether that owner may add to it. An entry of the listing settles one thing only, that
// nobody but the owner it is listed under updates or drops it: nothing about a workspace, or
// about who can open it, is decided from the listing. An entry's address within the space, its
// slug, is the space's alone: the space gives it, and no other object knows it.
//
// Trust: every method `SpaceDurableObject` exposes takes the acting user as a plain parameter,
// exactly like `OverseerDurableObject.open(userId, profileId, ...)`. Its only callers are
// `AuthenticatedApiImpl` (server.ts) and `UserDurableObject` (user.ts) -- never a client, gadget,
// gatekeeper or agent -- so the parameter is authoritative. A client only ever holds a
// `SpaceClientInterface`, which closes over the caller fixed at open time.
//
// The rules live in `SpaceModel`, pure logic over typed storage so it is unit-testable; the
// Durable Object is a thin shell adding the account lookup and the mirror pushes.

import { DurableObject } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  MAX_SLUG_LENGTH, PERSONAL_SPACE_PREFIX, isValidSpaceKey, isValidTeamSpaceKey, slugify,
  type AiChatAuthorInfo, type Space, type SpaceInfo, type SpaceMemberInfo, type SpaceMemberRole,
  type SpaceWorkspaceInfo, type SpaceWorkspaceResolution,
} from "@gadgets/workshop-shared/api";
import {
  makeSpaceStorage, type SpaceRecord, type SpaceStorage, type SpaceWorkspaceRecord,
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

/**
 * The space a claim asks for. Whoever claims it becomes its first admin and, if it is personal,
 * its owner (see `SpaceModel.claim`).
 */
export type SpaceClaim = Pick<SpaceRecord, "key" | "name" | "kind">;

/**
 * What the owner of a workspace registers with a space: the workspace's entry in the listing,
 * less the owner, whom the registering User DO states once for all of them, and the slug, which
 * is the space's to give.
 */
export type WorkspaceRegistration = Omit<SpaceWorkspaceInfo, "owner" | "slug">;

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

// An entry of the listing as a member is shown it: without the slugs it used to have.
function listed({ formerSlugs: _formerSlugs, ...workspace }: SpaceWorkspaceRecord)
    : SpaceWorkspaceInfo {
  return workspace;
}

/**
 * The rules of one space, over its typed storage: who its members are, which workspaces it
 * lists, and the slug each is addressed by. No RPC and no knowledge of other Durable Objects.
 * Every method that acts for a user takes who they are as a parameter and looks their membership
 * up at that moment, so nothing here trusts an earlier answer.
 */
export class SpaceModel {
  constructor(private storage: SpaceStorage) {}

  /** The space, or undefined while its key is unclaimed. */
  get info(): SpaceRecord | undefined {
    return this.storage.info.get();
  }

  /** The role `profileId` holds in the space, if they are a member of it. */
  roleOf(profileId: string): SpaceMemberRole | undefined {
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
    // space with no admin.
    this.storage.transaction(() => {
      this.storage.info.put({ key, name, kind, ...(kind === "personal" && { owner: creator }) });
      this.storage.members.put({ profile: creator, role: "admin", added: new Date() });
    });
    return true;
  }

  /**
   * The space as `profileId` sees it, or undefined if they cannot: the key is unclaimed or they
   * are not a member, which callers must not tell apart (see `noSuchSpace`).
   */
  infoFor(profileId: string): SpaceInfo | undefined {
    let info = this.info;
    let role = this.roleOf(profileId);
    return info && role && { ...info, role };
  }

  /** Space.listMembers: any member. */
  listMembers(caller: string): SpaceMemberInfo[] {
    this.#requireMember(caller);
    return [...this.storage.members.list()];
  }

  /**
   * Refuses a `caller` who may not change other members: anyone but an admin. Callers check
   * this before resolving a username, so that only an admin learns whether an account exists.
   */
  requireAdmin(caller: string): void {
    if (this.#requireMember(caller) !== "admin") {
      throw new Error("Only an admin of this space can change its members.");
    }
  }

  /**
   * Space.setMemberRole, once the username has been resolved to the existing account `profile`:
   * makes them a member in exactly `role`, whether that adds, raises or lowers them.
   */
  setMemberRole(caller: string, profile: AiChatAuthorInfo, role: SpaceMemberRole): SpaceMemberInfo {
    this.requireAdmin(caller);
    let info = this.info!;
    if (role !== "admin") {
      this.#keepAnAdmin(profile.id);
    } else if (info.kind === "personal" && info.owner?.id !== profile.id) {
      throw new Error("The owner of a personal space is its only admin.");
    }
    let added = this.storage.members.get(profile.id)?.added ?? new Date();
    let member: SpaceMemberInfo = { profile, role, added };
    this.storage.members.put(member);
    return member;
  }

  /**
   * Space.removeMember: an admin removes anyone, any other member only themself. Returns
   * whether `profileId` was a member.
   */
  removeMember(caller: string, profileId: string): boolean {
    if (this.#requireMember(caller) !== "admin" && caller !== profileId) {
      throw new Error("Only an admin of this space can remove other members.");
    }
    this.#keepAnAdmin(profileId);
    return this.storage.members.delete(profileId);
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
   * title that is not one of `PLACEHOLDER_TITLES`.
   */
  attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[]): boolean {
    let mayAdd = this.canAddWorkspaces(owner.id);
    for (let { id } of registrations) {
      let entry = this.storage.workspaces.get(id);
      if (entry ? entry.owner.id !== owner.id : !mayAdd) return false;
    }
    for (let { id, title, created } of registrations) {
      let entry: SpaceWorkspaceRecord =
          { ...this.storage.workspaces.get(id), id, title, owner, created };
      if (entry.slug === undefined && !PLACEHOLDER_TITLES.includes(title)) {
        entry.slug = this.#deriveSlug(title);
      }
      this.storage.workspaces.put(entry);
    }
    return true;
  }

  /**
   * Drop workspace `id` from the listing if `ownerId` is who it is listed under. Its slug and
   * former slugs go with the entry, and are free again.
   */
  detachWorkspace(id: string, ownerId: string): void {
    if (this.storage.workspaces.get(id)?.owner.id === ownerId) this.storage.workspaces.delete(id);
  }

  /** Space.listWorkspaces: any member, newest first. */
  listWorkspaces(caller: string): SpaceWorkspaceInfo[] {
    this.#requireMember(caller);
    return [...this.storage.workspaces.list()].map(listed)
        .toSorted((a, b) => b.created.getTime() - a.created.getTime());
  }

  /** Space.resolveWorkspace: any member. */
  resolveWorkspace(caller: string, slug: string): SpaceWorkspaceResolution | null {
    this.#requireMember(caller);
    return this.#resolve(slug) ?? null;
  }

  /**
   * Space.setWorkspaceSlug: a member who is the owner workspace `id` is listed under, or an
   * admin. The slug the entry had stays with it as a former one, the oldest falling off past
   * `MAX_FORMER_SLUGS`. A slug asked for by name is refused while another entry uses it, but is
   * taken from an entry that only used to: whoever asks knows the address they want, and that
   * slug stops resolving to the other workspace.
   */
  setWorkspaceSlug(caller: string, id: string, slug: string): SpaceWorkspaceInfo {
    let role = this.#requireMember(caller);
    let entry = this.storage.workspaces.get(id);
    if (!entry) throw new Error("This space does not list that workspace.");
    if (role !== "admin" && entry.owner.id !== caller) {
      throw new Error("Only a workspace's owner or an admin of this space can change its slug.");
    }
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

  #requireMember(caller: string): SpaceMemberRole {
    let role = this.roleOf(caller);
    if (!role) throw noSuchSpace();
    return role;
  }

  // Refuses to take the admin role from `profileId` if they are the space's last admin. A
  // personal space's owner is always its only admin, so this is also what keeps the owner in.
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
    this.#model = new SpaceModel(makeSpaceStorage(ctx.storage));
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
   * null if they cannot open it: the key is unclaimed or they are not a member, which the answer
   * does not tell apart. The caller's mirror is brought in line first (see `#mirror`), so a push
   * that was lost heals the next time they open the space.
   */
  async open(caller: string): Promise<Space | null> {
    await this.#mirror(caller);
    return this.#model.roleOf(caller) ? new SpaceClientInterface(this, caller) : null;
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
    this.#model.requireAdmin(caller);
    let profile = await this.ctx.exports.UserDurableObject.getByName(username).whoamiIfExists();
    if (!profile) return null;
    let member = this.#model.setMemberRole(caller, profile, role);
    await this.#mirror(profile.id);
    return member;
  }

  /** Space.removeMember, as `caller`. */
  async removeMember(caller: string, profileId: string): Promise<void> {
    if (this.#model.removeMember(caller, profileId)) await this.#mirror(profileId);
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

  /**
   * `SpaceModel.attachWorkspaces`. Called only by the User DO of `owner`, which states its own
   * user's profile, so every workspace it registers is one that user owns.
   */
  async attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[])
      : Promise<boolean> {
    return this.#model.attachWorkspaces(owner, registrations);
  }

  /** `SpaceModel.detachWorkspace`. Called only by the User DO of `ownerId`, as above. */
  async detachWorkspace(id: string, ownerId: string): Promise<void> {
    this.#model.detachWorkspace(id, ownerId);
  }

  // Bring `profileId`'s mirror of this space in line with their membership as it stands now.
  // Best-effort: the member list is already written and is the authority, and a mirror this
  // fails to reach is corrected the next time its user opens the space.
  async #mirror(profileId: string): Promise<void> {
    // An unclaimed key has never had a member, so no mirror holds it.
    let key = this.#model.info?.key;
    if (!key) return;
    let user = this.ctx.exports.UserDurableObject.getByName(profileId);
    let info = this.#model.infoFor(profileId);
    try {
      await (info ? user.recordSpaceMembership(info) : user.forgetSpace(key));
    } catch (error) {
      logger.warn("failed to mirror a space membership to its member", {
        event: "space.membership.mirror.failed", operation: info ? "record" : "forget",
        durableObjectId: this.ctx.id.toString(), error,
      });
    }
  }
}

/**
 * The client-facing capability for one space, minted by `SpaceDurableObject.open()`. It acts as
 * `caller`, the profile id fixed at open time, and holds no permission of its own: every method
 * has the space resolve that user's membership again.
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

  setMemberRole(username: string, role: SpaceMemberRole): Promise<SpaceMemberInfo | null> {
    return this.space.setMemberRole(this.caller, username, role);
  }

  removeMember(profileId: string): Promise<void> {
    return this.space.removeMember(this.caller, profileId);
  }
}
