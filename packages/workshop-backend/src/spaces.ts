// Spaces: a space is a key, a display name and a member list (see docs/spaces.md).
//
// Each space is one Durable Object (`SpaceDurableObject`), addressed by the space's key. There is
// no directory of spaces: a key is taken once the object under it has been claimed, and that
// object's member list is the only authority on who belongs to the space. Every member's User DO
// keeps a presentation-only mirror of their memberships, which the space pushes to.
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
  PERSONAL_SPACE_PREFIX, isValidSpaceKey, isValidTeamSpaceKey,
  type AiChatAuthorInfo, type Space, type SpaceInfo, type SpaceMemberInfo, type SpaceMemberRole,
} from "@gadgets/workshop-shared/api";
import { makeSpaceStorage, type SpaceRecord, type SpaceStorage } from "./storage-schema/space-storage.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.spaces");

// The longest key the grammar allows after a personal key's prefix, and the longest name a team
// space can be created with.
const MAX_KEY_LENGTH = 32;
const MAX_SPACE_NAME_LENGTH = 100;

/**
 * The space a claim asks for. Whoever claims it becomes its first admin and, if it is personal,
 * its owner (see `SpaceModel.claim`).
 */
export type SpaceClaim = Pick<SpaceRecord, "key" | "name" | "kind">;

/** Refuses a key that cannot name a space, before a Durable Object is addressed by it. */
export function checkSpaceKey(key: string): void {
  if (!isValidSpaceKey(key)) throw new Error("Invalid space key.");
}

/** The claim `AuthenticatedApi.createSpace(key, name)` makes; refuses a malformed key or name. */
export function teamSpaceClaim(key: string, name: string): SpaceClaim {
  if (!isValidTeamSpaceKey(key)) {
    throw new Error(
        "A space key is 2 to 32 lowercase letters, digits and dashes, and cannot start with a dash.");
  }
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

/**
 * The membership rules of one space, over its typed storage. No RPC and no knowledge of other
 * Durable Objects. Every method that acts for a user takes their profile id as `caller` and
 * looks their membership up at that moment, so nothing here trusts an earlier answer.
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

  setMemberRole(username: string, role: SpaceMemberRole): Promise<SpaceMemberInfo | null> {
    return this.space.setMemberRole(this.caller, username, role);
  }

  removeMember(profileId: string): Promise<void> {
    return this.space.removeMember(this.caller, profileId);
  }
}
