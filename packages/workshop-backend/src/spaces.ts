// Spaces: a space is an id, a display name, a member list and a listing of the workspaces that
// belong to it (see docs/spaces.md).
//
// Each space is one Durable Object (`SpaceDurableObject`), and the space's id is that object's:
// a unique id made when a team space is created, the id derived from its owner's profile id for
// a personal one. Nothing lists the spaces, and an id is not a capability: the object's member
// list is the only authority on who belongs to the space, and is consulted on every call. Every
// member's User DO keeps a presentation-only mirror of their memberships, which the space
// pushes to.
//
// The listing of workspaces runs the other way. Which space a workspace belongs to is recorded by
// its owner's User DO, which registers the workspace here and keeps the entry current; the space
// decides whether that owner may add to it. An entry of the listing is held by the owner it is
// listed under: nobody else updates or drops it. Where a workspace belongs is never decided from
// the listing, which only follows its owner's record.
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
// Trust: every method `SpaceDurableObject` exposes takes the acting user as a plain parameter,
// exactly like `OverseerDurableObject.open(userId, profileId, ...)`. Its only callers are
// `AuthenticatedApiImpl` (server.ts) and `UserDurableObject` (user.ts) -- never a client, gadget,
// gatekeeper or agent -- so the parameter is authoritative. A client only ever holds a
// `SpaceClientInterface`, which closes over the caller fixed at open time.
//
// The rules live in `SpaceModel`, pure logic over typed storage so it is unit-testable; the
// Durable Object is a thin shell adding the account lookup, the mirror pushes and the alarm that
// delivers the revocations.

import { DurableObject } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  AiChatAuthorInfo, CollaboratorRole, Space, SpaceInfo, SpaceMemberInfo, SpaceMemberRole,
  SpaceWorkspaceInfo,
} from "@gadgets/workshop-shared/api";
import {
  makeSpaceStorage, type SpaceLease, type SpaceRecord, type SpaceRevocation, type SpaceStorage,
} from "./storage-schema/space-storage.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.spaces");

// The longest name a team space can be created with.
const MAX_SPACE_NAME_LENGTH = 100;

// The revocations one run of the alarm attempts, and the bounds of the wait before a revocation
// is attempted again, which doubles each time its attempt fails.
const REVOCATION_BATCH = 16;
const REVOCATION_RETRY_MS = { first: 1_000, longest: 5 * 60_000 };

/**
 * What the owner of a workspace registers with a space: the workspace's entry in the listing,
 * less the owner, whom the registering User DO states once for all of them.
 */
export type WorkspaceRegistration = Omit<SpaceWorkspaceInfo, "owner">;

/**
 * The space a client named by `id`. Refuses a string that is not a Durable Object id of
 * `spaces`, before anything is recorded under it or addressed by it. Says nothing about whether
 * such a space was ever created, or whether the caller is a member of it.
 */
export function spaceById(spaces: DurableObjectNamespace<SpaceDurableObject>, id: string)
    : DurableObjectStub<SpaceDurableObject> {
  try {
    return spaces.get(spaces.idFromString(id));
  } catch {
    throw new Error("Invalid space id.");
  }
}

/** The name `AuthenticatedApi.createSpace(name)` gives a team space: trimmed, or refused. */
export function teamSpaceName(name: string): string {
  name = name.trim();
  if (name === "" || name.length > MAX_SPACE_NAME_LENGTH) {
    throw new Error(`A space name is 1 to ${MAX_SPACE_NAME_LENGTH} characters.`);
  }
  return name;
}

/**
 * The one refusal given both for an id that names no space and for a space the caller is not a
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

/**
 * The rules of one space, over its typed storage: who its members are, which workspaces it
 * lists, and the role each member holds on them. No RPC and no knowledge of other Durable
 * Objects. Every method that acts for a user takes who they are as a parameter and looks their
 * membership up at that moment, so nothing here trusts an earlier answer.
 */
export class SpaceModel {
  /** `id` is the space's id, which the model reports and never stores. */
  constructor(private storage: SpaceStorage, private id: string) {}

  /** The space, or undefined if it was never created. */
  get info(): SpaceRecord | undefined {
    return this.storage.info.get();
  }

  /** The role `profileId` holds in the space, if they are a member of it. */
  roleOf(profileId: string): SpaceMemberRole | undefined {
    return this.storage.members.get(profileId)?.role;
  }

  /**
   * Create the space for `creator`, who becomes its first admin and, if it is personal, its
   * owner. Creating a space that exists changes nothing, so it can never take one over. Returns
   * whether the space is the one created for `creator`: by this call, or by an earlier one as
   * the personal space they own. That is what lets a User DO create its personal space on first
   * use and any number of times after.
   */
  create({ name, kind }: Pick<SpaceRecord, "name" | "kind">, creator: AiChatAuthorInfo): boolean {
    let existing = this.info;
    if (existing) return existing.owner?.id === creator.id;
    // One transaction: a creation that fails part way must leave no space, not one with no admin.
    this.storage.transaction(() => {
      this.storage.info.put({ name, kind, ...(kind === "personal" && { owner: creator }) });
      this.storage.members.put({ profile: creator, role: "admin", added: new Date() });
    });
    return true;
  }

  /**
   * The space as `profileId` sees it, or undefined if they cannot: it was never created or they
   * are not a member, which callers must not tell apart (see `noSuchSpace`).
   */
  infoFor(profileId: string): SpaceInfo | undefined {
    let info = this.info;
    let role = this.roleOf(profileId);
    return info && role && { id: this.id, ...info, role };
  }

  /** Space.listMembers: any member. */
  listMembers(caller: string): SpaceMemberInfo[] {
    this.#requireMember(caller);
    return [...this.storage.members.list()];
  }

  /**
   * Refuses a `caller` who may not set members' roles: anyone but an admin, and everyone in a
   * personal space, which has no members besides its owner. Callers check this before resolving
   * a username, so that only an admin of a team space learns whether an account exists.
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
   * whether `profileId` was a member. Their leases are revoked.
   */
  removeMember(caller: string, profileId: string): boolean {
    if (this.#requireMember(caller) !== "admin" && caller !== profileId) {
      throw new Error("Only an admin of this space can remove other members.");
    }
    this.#keepAnAdmin(profileId);
    this.#revoke(this.storage.leases.byProfile.get(profileId));
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
   */
  attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[]): boolean {
    let mayAdd = this.canAddWorkspaces(owner.id);
    for (let { id } of registrations) {
      let listed = this.storage.workspaces.get(id);
      if (listed ? listed.owner.id !== owner.id : !mayAdd) return false;
    }
    for (let { id, title, created } of registrations) {
      this.storage.workspaces.put({ id, title, owner, created });
    }
    return true;
  }

  /**
   * Drop workspace `id` from the listing if `ownerId` is who it is listed under, and revoke
   * every lease on it.
   */
  detachWorkspace(id: string, ownerId: string): void {
    if (this.storage.workspaces.get(id)?.owner.id !== ownerId) return;
    this.storage.workspaces.delete(id);
    this.#revoke(this.storage.leases.list({ prefix: `${id}:` }));
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
   * another after a wait twice as long as its last, within `REVOCATION_RETRY_MS`.
   */
  deferred(revocation: SpaceRevocation, now: number): void {
    let { first, longest } = REVOCATION_RETRY_MS;
    let retryMs = Math.min(longest, revocation.retryMs * 2 || first);
    this.storage.revocations.put({ ...revocation, due: now + retryMs, retryMs });
  }

  /** Space.listWorkspaces: any member, newest first. */
  listWorkspaces(caller: string): SpaceWorkspaceInfo[] {
    this.#requireMember(caller);
    return [...this.storage.workspaces.list()]
        .toSorted((a, b) => b.created.getTime() - a.created.getTime());
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

  // Queues a revocation of `lease`, due at once.
  #queue({ workspace, profile }: SpaceLease): void {
    let seq = this.storage.nextRevocation.get();
    this.storage.nextRevocation.put(seq + 1);
    this.storage.revocations.put({ seq, workspace, profile, due: 0, retryMs: 0 });
  }

  #requireMember(caller: string): SpaceMemberRole {
    let role = this.roleOf(caller);
    if (!role) throw noSuchSpace();
    return role;
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

/**
 * One space, whose id is this object's own (`ctx.id`): no caller tells a space what its id is.
 * A client's id reaches it through `spaceById()`. Reachable from kernel code only (see above).
 */
export class SpaceDurableObject extends DurableObject<Cloudflare.Env> {
  #model: SpaceModel;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#model = new SpaceModel(makeSpaceStorage(ctx.storage), ctx.id.toString());
  }

  /**
   * `SpaceModel.create`. Pushes nothing to the creator's mirror: a User DO creating its personal
   * space records it itself, and the creator of a team space gets it by opening the space.
   */
  async create(space: Pick<SpaceRecord, "name" | "kind">, creator: AiChatAuthorInfo)
      : Promise<boolean> {
    return this.#model.create(space, creator);
  }

  /**
   * Open the space as `caller`, a profile id. Returns the capability handed to their client, or
   * null if they cannot open it: it was never created or they are not a member, which the answer
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
    this.#model.requireMembershipAdmin(caller);
    let profile = await this.ctx.exports.UserDurableObject.getByName(username).whoamiIfExists();
    if (!profile) return null;
    let member = this.#model.setMemberRole(caller, profile, role);
    await this.#deliverRevocations();
    await this.#mirror(profile.id);
    return member;
  }

  /** Space.removeMember, as `caller`. */
  async removeMember(caller: string, profileId: string): Promise<void> {
    let removed = this.#model.removeMember(caller, profileId);
    await this.#deliverRevocations();
    if (removed) await this.#mirror(profileId);
  }

  /** Space.listWorkspaces, as `caller`. */
  async listWorkspaces(caller: string): Promise<SpaceWorkspaceInfo[]> {
    return this.#model.listWorkspaces(caller);
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
    await this.#deliverRevocations();
  }

  /**
   * `SpaceModel.workspaceRole`. Called only by the User DO of `ownerId`, as above, for a
   * workspace its record points at this space, on behalf of that workspace's Overseer.
   */
  async workspaceRole(id: string, ownerId: string, profileId: string)
      : Promise<CollaboratorRole | null> {
    return this.#model.workspaceRole(id, ownerId, profileId) ?? null;
  }

  /**
   * Delivers the queued revocations that are due, so many in a run: tells each one's workspace
   * that the profile no longer holds a role through this space
   * (`OverseerDurableObject.revokeSpaceAccess`), and takes it off the queue only once that call
   * has returned. One whose call fails is kept for a later run (`SpaceModel.deferred`), which
   * holds up no other. While any remain the alarm is set again, for when the next is due.
   */
  async alarm(): Promise<void> {
    let overseers = this.ctx.exports.OverseerDurableObject;
    let due = this.#model.dueRevocations(Date.now(), REVOCATION_BATCH);
    await Promise.all(due.map(async revocation => {
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
    }));
    await this.#deliverRevocations();
  }

  // Sets the alarm for when the next queued revocation is due, which for one just queued is
  // now. Called in the same turn as the change that may have queued one, so that the two are
  // stored together.
  async #deliverRevocations(): Promise<void> {
    let due = this.#model.nextRevocationDue();
    if (due !== undefined) await this.ctx.storage.setAlarm(Math.max(due, Date.now()));
  }

  // Bring `profileId`'s mirror of this space in line with their membership as it stands now.
  // Best-effort: the member list is already written and is the authority, and a mirror this
  // fails to reach is corrected the next time its user opens the space.
  async #mirror(profileId: string): Promise<void> {
    // A space never created has never had a member, so no mirror holds it.
    if (!this.#model.info) return;
    let user = this.ctx.exports.UserDurableObject.getByName(profileId);
    let info = this.#model.infoFor(profileId);
    try {
      await (info ? user.recordSpaceMembership(info) : user.forgetSpace(this.ctx.id.toString()));
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

  setMemberRole(username: string, role: SpaceMemberRole): Promise<SpaceMemberInfo | null> {
    return this.space.setMemberRole(this.caller, username, role);
  }

  removeMember(profileId: string): Promise<void> {
    return this.space.removeMember(this.caller, profileId);
  }
}
