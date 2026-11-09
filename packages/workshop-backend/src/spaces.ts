// Spaces: a space is an id, a display name, a member list and a listing of the workspaces that
// belong to it (see docs/spaces.md).
//
// Each space is one Durable Object (`SpaceDurableObject`), and the space's id is that object's:
// a unique id made when a team space is created, the id derived from its owner's profile id for
// a personal one. Nothing lists every space, and an id is not a capability: the object's member
// list, with those of the spaces it is inside, is the only authority on who belongs to the
// space, and is consulted on every call. Every member's User DO keeps a presentation-only mirror
// of the roles they were given, which the space pushes to.
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
// A space may hold sub-spaces. Each is a space of its own, whose record holds the ids of the
// spaces it is inside, nearest first: its ancestors, written once by the space that creates it
// and never changed. A member of a space is a member of every space below it in at least the
// same role, so a sub-space asks each of its ancestors, directly and all at once, which role
// that ancestor's own member list gives a profile (`SpaceDurableObject.roleFor`), and takes the
// highest. An ancestor asks nobody in turn, so the chain of calls behind a decision is one call
// longer than in a space inside no other, however deep the sub-space is. Each such answer is a
// lease as well, whose revocation goes to the sub-space that was answered, which takes back the
// roles it gave that profile on its workspaces.
//
// Trust: every method `SpaceDurableObject` exposes takes the acting user as a plain parameter,
// exactly like `OverseerDurableObject.open(userId, profileId, ...)`. Its only callers are
// `AuthenticatedApiImpl` (server.ts), `UserDurableObject` (user.ts) and another
// `SpaceDurableObject`, which states its own id -- never a client, gadget, gatekeeper or
// agent -- so the parameters are authoritative. A client only ever holds a
// `SpaceClientInterface`, which closes over the caller fixed at open time.
//
// The rules live in `SpaceModel`, pure logic over typed storage so it is unit-testable; the
// Durable Object is a thin shell adding the account lookup, the mirror pushes, the question to
// the ancestors and the alarm that delivers the revocations.

import { DurableObject } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  AiChatAuthorInfo, CollaboratorRole, Space, SpaceInfo, SpaceMemberInfo, SpaceMemberRole,
  SpaceWorkspaceInfo, SubspaceInfo,
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
 * How many levels of sub-spaces a root, a space inside no other, can have below it: the most
 * ancestors a space has, each of which it asks directly.
 */
export const MAX_SPACE_DEPTH = 5;

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

/** The name `createSpace` or `createSubspace` gives a team space: trimmed, or refused. */
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

// How high a role is: "admin" over "build" over "use" over none, which a stored role that is
// none of the three counts as.
function rank(role: SpaceMemberRole | null | undefined): number {
  return ["use", "build", "admin"].indexOf(role!);
}

/**
 * The rules of one space, over its typed storage: who its members are, which workspaces it
 * lists, and the role each member holds on them. No RPC and no knowledge of other Durable
 * Objects. Every method that acts for a user takes who they are as a parameter and looks their
 * membership up at that moment, so nothing here trusts an earlier answer. In a sub-space such a
 * method also takes `inherited`, the highest role its ancestors give that user, which the
 * Durable Object asks them for within the call (see `SpaceDurableObject.roleFor`).
 */
export class SpaceModel {
  /** `id` is the space's id, which the model reports and never stores. */
  constructor(private storage: SpaceStorage, private id: string) {}

  /** The space, or undefined if it was never created. */
  get info(): SpaceRecord | undefined {
    return this.storage.info.get();
  }

  /**
   * The role `profileId` holds in the space: the higher of the one they were given in it, if
   * any, and `inherited`.
   */
  roleOf(profileId: string, inherited?: SpaceMemberRole): SpaceMemberRole | undefined {
    let own = this.storage.members.get(profileId)?.role;
    return rank(own) >= rank(inherited) ? own : inherited;
  }

  /**
   * Create the space for `creator`, who becomes its first admin and, if it is personal, its
   * owner. A sub-space, whose record holds its `ancestors`, takes none and starts with no
   * member of its own; any other space needs one. Creating a space that exists changes nothing,
   * so it can never take one over, nor change which spaces one is inside. Returns whether the
   * space is the one created for `creator`: by this call, or by an earlier one as the personal
   * space they own. That is what lets a User DO create its personal space on first use and any
   * number of times after.
   */
  create(space: Pick<SpaceRecord, "name" | "kind" | "ancestors">, creator?: AiChatAuthorInfo)
      : boolean {
    let existing = this.info;
    if (existing) return !!creator && existing.owner?.id === creator.id;
    if (!creator && !space.ancestors) throw new Error("A space inside no other needs a creator.");
    // One transaction: a creation that fails part way must leave no space, not a root with no
    // admin.
    this.storage.transaction(() => {
      this.storage.info.put({ ...space, ...(space.kind === "personal" && { owner: creator }) });
      if (creator) this.storage.members.put({ profile: creator, role: "admin", added: new Date() });
    });
    return true;
  }

  /**
   * The space as `profileId` sees it, or undefined if they cannot: it was never created or they
   * are not a member, which callers must not tell apart (see `noSuchSpace`). They are told its
   * `parent`, the nearest of its ancestors, only with an `inherited` role, which is what makes
   * them a member of that space.
   */
  infoFor(profileId: string, inherited?: SpaceMemberRole): SpaceInfo | undefined {
    let role = this.roleOf(profileId, inherited);
    if (!this.info || !role) return undefined;
    let { ancestors, ...info } = this.info;
    return { id: this.id, ...info, ...(inherited && { parent: ancestors?.[0] }), role };
  }

  /** Space.listMembers: any member, and only those the space has of its own. */
  listMembers(caller: string, inherited?: SpaceMemberRole): SpaceMemberInfo[] {
    this.#requireMember(caller, inherited);
    return [...this.storage.members.list()];
  }

  /**
   * Refuses a `caller` who may not set members' roles: anyone but an admin, and everyone in a
   * personal space, which has no members besides its owner. Callers check this before resolving
   * a username, so that only an admin of a team space learns whether an account exists.
   */
  requireMembershipAdmin(caller: string, inherited?: SpaceMemberRole): void {
    if (this.#requireMember(caller, inherited) !== "admin") {
      throw new Error("Only an admin of this space can change its members.");
    }
    if (this.info!.kind === "personal") throw new Error("A personal space has no members.");
  }

  /**
   * Space.setMemberRole, once the username has been resolved to the existing account `profile`:
   * makes them a member in exactly `role`, whether that adds, raises or lowers them. Lowering
   * them to a role that gives less on the space's workspaces revokes their leases. Refused in a
   * personal space, whoever the target (see `requireMembershipAdmin`). `inherited` is `caller`'s.
   */
  setMemberRole(caller: string, profile: AiChatAuthorInfo, role: SpaceMemberRole,
                inherited?: SpaceMemberRole): SpaceMemberInfo {
    this.requireMembershipAdmin(caller, inherited);
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
   * whether `profileId` was a member of the space itself, whose leases are then revoked: one
   * who only inherits a role loses nothing here. `inherited` is `caller`'s.
   */
  removeMember(caller: string, profileId: string, inherited?: SpaceMemberRole): boolean {
    if (this.#requireMember(caller, inherited) !== "admin" && caller !== profileId) {
      throw new Error("Only an admin of this space can remove other members.");
    }
    this.#keepAnAdmin(profileId);
    if (!this.storage.members.delete(profileId)) return false;
    this.#revoke(this.storage.leases.byProfile.get(profileId));
    return true;
  }

  /**
   * Whether `profileId` may add workspaces they own to the space: only its owner if it is
   * personal, any member whatever their role if it is a team space.
   */
  canAddWorkspaces(profileId: string, inherited?: SpaceMemberRole): boolean {
    let info = this.info;
    return info?.kind === "personal" ? info.owner?.id === profileId
        : !!this.roleOf(profileId, inherited);
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
  attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[],
                   inherited?: SpaceMemberRole): boolean {
    let mayAdd = this.canAddWorkspaces(owner.id, inherited);
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
  workspaceRole(id: string, ownerId: string, profileId: string, inherited?: SpaceMemberRole)
      : CollaboratorRole | undefined {
    let member = this.roleOf(profileId, inherited);
    let role = member && workspaceRoleOf(member);
    if (!role || this.storage.workspaces.get(id)?.owner.id !== ownerId) return undefined;
    this.storage.leases.put({ workspace: id, profile: profileId });
    return role;
  }

  /**
   * The role `profileId` was given in the space itself, for `descendant`, a space below this
   * one, to count towards the one they inherit there. Undefined for anyone given none.
   *
   * An answer with a role is remembered as a lease, so that the descendant is told when it no
   * longer holds (see `#revoke`).
   */
  lend(descendant: string, profileId: string): SpaceMemberRole | undefined {
    let role = this.roleOf(profileId);
    if (role) this.storage.leases.put({ space: descendant, profile: profileId });
    return role;
  }

  /**
   * An ancestor took back a role it said `profileId` holds there. Every role the space gave
   * them on a workspace may have rested on it, so each of those leases is taken back; what they
   * still hold is found by whoever asks again. What the space told its own descendants stands:
   * it answered from its own members, and each ancestor tells every space it answered itself.
   */
  revokeInherited(profileId: string): void {
    this.#revoke([...this.storage.leases.byProfile.get(profileId)]
        .filter(lease => "workspace" in lease));
  }

  /**
   * The record to create a sub-space of this space with, whose ancestors are this space and
   * then its own. Refuses a `caller` who may not create one: anyone but a "build" member or an
   * admin, and everyone in a space `MAX_SPACE_DEPTH` levels below its root. Callers check this
   * before they create anything.
   */
  newSubspace(caller: string, name: string, inherited?: SpaceMemberRole): SpaceRecord {
    if (rank(this.#requireMember(caller, inherited)) < rank("build")) {
      throw new Error("Only an admin or a build member of this space can create a sub-space.");
    }
    let ancestors = [this.id, ...this.info!.ancestors ?? []];
    if (ancestors.length > MAX_SPACE_DEPTH) {
      throw new Error(`A space can be nested at most ${MAX_SPACE_DEPTH} levels deep.`);
    }
    return { name, kind: "team", ancestors };
  }

  /** Lists `child`, a sub-space created with a record from `newSubspace`, in the space. */
  addSubspace(child: SubspaceInfo): SubspaceInfo {
    this.storage.children.put(child);
    return child;
  }

  /** Space.listSubspaces: any member, by name. */
  listSubspaces(caller: string, inherited?: SpaceMemberRole): SubspaceInfo[] {
    this.#requireMember(caller, inherited);
    return [...this.storage.children.list()].toSorted((a, b) => a.name.localeCompare(b.name));
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

  /** Takes `revocation` off the queue, once its workspace or sub-space has answered it. */
  delivered(revocation: SpaceRevocation): void {
    this.storage.revocations.delete(revocation.seq);
  }

  /**
   * Keeps `revocation`, whose attempt at `now` its workspace or sub-space did not answer, for
   * another after a wait twice as long as its last, within `REVOCATION_RETRY_MS`.
   */
  deferred(revocation: SpaceRevocation, now: number): void {
    let { first, longest } = REVOCATION_RETRY_MS;
    let retryMs = Math.min(longest, revocation.retryMs * 2 || first);
    this.storage.revocations.put({ ...revocation, due: now + retryMs, retryMs });
  }

  /** Space.listWorkspaces: any member, newest first. */
  listWorkspaces(caller: string, inherited?: SpaceMemberRole): SpaceWorkspaceInfo[] {
    this.#requireMember(caller, inherited);
    return [...this.storage.workspaces.list()]
        .toSorted((a, b) => b.created.getTime() - a.created.getTime());
  }

  // Takes `leases` back: each leaves the leases and joins the queue of revocations, for its
  // workspace's Overseer to end whatever session it gave the role to, or for the sub-space it
  // answered to take back what rested on the answer. A lease given out again before that is
  // delivered is a new lease, and the revocation still goes out.
  #revoke(leases: Iterable<SpaceLease>): void {
    // Collected before any write, which would end a live listing.
    let revoked = [...leases];
    for (let lease of revoked) {
      this.storage.leases.deleteRecord(lease);
      this.#queue(lease);
    }
  }

  // Queues a revocation of `lease`, due at once.
  #queue(lease: SpaceLease): void {
    let seq = this.storage.nextRevocation.get();
    this.storage.nextRevocation.put(seq + 1);
    this.storage.revocations.put({ ...lease, seq, due: 0, retryMs: 0 });
  }

  #requireMember(caller: string, inherited?: SpaceMemberRole): SpaceMemberRole {
    let role = this.roleOf(caller, inherited);
    if (!role) throw noSuchSpace();
    return role;
  }

  // Refuses to take the admin role from `profileId` if they are the space's last admin. A
  // personal space's owner is its only member, and so its only admin: this is also what keeps
  // the owner from leaving it or being removed. A sub-space needs no admin of its own: it always
  // has those it inherits.
  #keepAnAdmin(profileId: string): void {
    if (this.info?.ancestors || this.roleOf(profileId) !== "admin") return;
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

  // The questions to this space's ancestors that are in flight, each with the profile it is
  // about. revokeInherited() marks those about its profile, whose answers may predate it.
  #asking = new Set<{ profileId: string; overtaken: boolean }>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#model = new SpaceModel(makeSpaceStorage(ctx.storage), ctx.id.toString());
  }

  /**
   * `SpaceModel.create`. Pushes nothing to the creator's mirror: a User DO creating its personal
   * space records it itself, and the creator of a team space gets it by opening the space. A
   * sub-space is created by its parent, with no creator and with the ancestors the parent
   * states (see `createSubspace`): no other caller passes any, so no client chooses them.
   */
  async create(space: Parameters<SpaceModel["create"]>[0], creator?: AiChatAuthorInfo)
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
    let role = this.#model.roleOf(caller, await this.#inherited(caller, "use"));
    return role ? new SpaceClientInterface(this, caller) : null;
  }

  /**
   * Space.getInfo, as `caller`. The ancestors are asked whatever role they hold here, since the
   * answer also decides whether they are told `parent`.
   */
  async getInfo(caller: string): Promise<SpaceInfo> {
    let info = this.#model.infoFor(caller, await this.#inherited(caller));
    if (!info) throw noSuchSpace();
    return info;
  }

  /** Space.listMembers, as `caller`. */
  async listMembers(caller: string): Promise<SpaceMemberInfo[]> {
    return this.#model.listMembers(caller, await this.#inherited(caller, "use"));
  }

  /** Space.setMemberRole, as `caller`. */
  async setMemberRole(caller: string, username: string, role: SpaceMemberRole)
      : Promise<SpaceMemberInfo | null> {
    // Authorize before the lookup, so a caller who is not an admin learns nothing about which
    // accounts exist.
    this.#model.requireMembershipAdmin(caller, await this.#inherited(caller, "admin"));
    let profile = await this.ctx.exports.UserDurableObject.getByName(username).whoamiIfExists();
    if (!profile) return null;
    // The ancestors are asked again: the role that allowed the lookup may have ended during it.
    let member = this.#model.setMemberRole(
        caller, profile, role, await this.#inherited(caller, "admin"));
    await this.#deliverRevocations();
    await this.#mirror(profile.id);
    return member;
  }

  /** Space.removeMember, as `caller`. */
  async removeMember(caller: string, profileId: string): Promise<void> {
    // Anyone leaves; only an admin removes another.
    let inherited = await this.#inherited(caller, caller === profileId ? "use" : "admin");
    let removed = this.#model.removeMember(caller, profileId, inherited);
    await this.#deliverRevocations();
    if (removed) await this.#mirror(profileId);
  }

  /** Space.listWorkspaces, as `caller`. */
  async listWorkspaces(caller: string): Promise<SpaceWorkspaceInfo[]> {
    return this.#model.listWorkspaces(caller, await this.#inherited(caller, "use"));
  }

  /** Space.listSubspaces, as `caller`. */
  async listSubspaces(caller: string): Promise<SubspaceInfo[]> {
    return this.#model.listSubspaces(caller, await this.#inherited(caller, "use"));
  }

  /**
   * Space.createSubspace, as `caller`. The sub-space exists before this space lists it, so that
   * a creation which fails part way leaves a space nothing reaches, never an entry that opens
   * nothing. The ancestors are not asked again for the listing: the entry of an empty sub-space
   * gives nobody a role. Nor is the sub-space returned opened: every call on a capability
   * minted through this object would pass through it.
   */
  async createSubspace(caller: string, name: string): Promise<SubspaceInfo> {
    name = teamSpaceName(name);
    let record = this.#model.newSubspace(caller, name, await this.#inherited(caller, "build"));
    let spaces = this.ctx.exports.SpaceDurableObject;
    let id = spaces.newUniqueId();
    await spaces.get(id).create(record);
    return this.#model.addSubspace({ id: id.toString(), name });
  }

  /**
   * `SpaceModel.attachWorkspaces`. Called only by the User DO of `owner`, which states its own
   * user's profile, so every workspace it registers is one that user owns.
   */
  async attachWorkspaces(owner: AiChatAuthorInfo, registrations: WorkspaceRegistration[])
      : Promise<boolean> {
    return this.#model.attachWorkspaces(
        owner, registrations, await this.#inherited(owner.id, "use"));
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
    // "build" is the most a role gives on a workspace, so an own "build" settles it.
    return this.#model.workspaceRole(
        id, ownerId, profileId, await this.#inherited(profileId, "build")) ?? null;
  }

  /**
   * `SpaceModel.lend`, for `descendant`, a space below this one, which is the only caller and
   * states its own id: that is where the revocation of the answer goes. It answers from this
   * space's own member list and calls no other space, since a descendant asks each of its
   * ancestors itself (see `#inherited`). Whoever asks is answered: nothing here says which
   * spaces are below this one, and only kernel code can ask.
   */
  async roleFor(descendant: string, profileId: string): Promise<SpaceMemberRole | null> {
    return this.#model.lend(descendant, profileId) ?? null;
  }

  /**
   * `SpaceModel.revokeInherited`. Called only by an ancestor, whose alarm repeats the call
   * until it returns. It can only end sessions: a question to the ancestors that is in flight
   * for `profileId` may carry an answer given before this, and is not trusted (see `#inherited`).
   */
  async revokeInherited(profileId: string): Promise<void> {
    for (let asked of this.#asking) {
      if (asked.profileId === profileId) asked.overtaken = true;
    }
    this.#model.revokeInherited(profileId);
    await this.#deliverRevocations();
  }

  // The role `profileId` inherits here: the highest that this space's ancestors give them. Each
  // ancestor is asked directly, all at once, and answers from its own member list without
  // calling a space (see roleFor()). So the chain of calls behind a decision is one call longer
  // here than in a root, however deep this space is; it must not grow with the depth, since the
  // platform bounds how long a chain of calls may be. Nobody is asked in a root, nor about a
  // profile whose own role here is at least `enough`, which settles what the caller is asking.
  // A call that fails is not caught, since "no role" must never be the answer for someone who
  // may hold one. Nor are answers trusted that a revocation for the same profile overtook (see
  // revokeInherited()): the ancestors are asked once more, and if those answers are overtaken
  // too, this throws.
  async #inherited(profileId: string, enough?: SpaceMemberRole, askAgain = true)
      : Promise<SpaceMemberRole | undefined> {
    let ancestors = this.#model.info?.ancestors;
    if (!ancestors || (enough && rank(this.#model.roleOf(profileId)) >= rank(enough))) {
      return undefined;
    }
    let spaces = this.ctx.exports.SpaceDurableObject;
    let asked = { profileId, overtaken: false };
    this.#asking.add(asked);
    let roles: (SpaceMemberRole | null)[];
    try {
      roles = await Promise.all(ancestors.map(ancestor =>
          spaces.get(spaces.idFromString(ancestor)).roleFor(this.ctx.id.toString(), profileId)));
    } finally {
      this.#asking.delete(asked);
    }
    if (!asked.overtaken) return roles.toSorted((a, b) => rank(b) - rank(a))[0] ?? undefined;
    if (!askAgain) {
      throw new Error("This space's inherited roles changed while one was being looked up.");
    }
    return this.#inherited(profileId, enough, false);
  }

  /**
   * Delivers the queued revocations that are due, so many in a run: tells each one's workspace
   * that the profile no longer holds a role through this space
   * (`OverseerDurableObject.revokeSpaceAccess`), or the sub-space it answered that the role it
   * was told they hold here has ended (`revokeInherited`), and takes it off the queue only once
   * that call has returned. One whose call fails is kept for a later run
   * (`SpaceModel.deferred`), which holds up no other. While any remain the alarm is set again,
   * for when the next is due.
   */
  async alarm(): Promise<void> {
    let { OverseerDurableObject: overseers, SpaceDurableObject: spaces } = this.ctx.exports;
    let due = this.#model.dueRevocations(Date.now(), REVOCATION_BATCH);
    await Promise.all(due.map(async revocation => {
      try {
        await ("space" in revocation
            ? spaces.get(spaces.idFromString(revocation.space)).revokeInherited(revocation.profile)
            : overseers.get(overseers.idFromString(revocation.workspace))
                .revokeSpaceAccess(revocation.profile));
        this.#model.delivered(revocation);
      } catch (error) {
        this.#model.deferred(revocation, Date.now());
        logger.warn("failed to deliver a space revocation", {
          event: "space.revocation.deliver.failed", durableObjectId: this.ctx.id.toString(), error,
          ...("space" in revocation ? { spaceId: revocation.space }
              : { gadgetId: revocation.workspace }),
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
  // fails to reach is corrected the next time its user opens the space. Only a role given in
  // this space is mirrored, so a mirror lists the spaces its user was added to.
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

  listSubspaces(): Promise<SubspaceInfo[]> {
    return this.space.listSubspaces(this.caller);
  }

  createSubspace(name: string): Promise<SubspaceInfo> {
    return this.space.createSubspace(this.caller, name);
  }

  setMemberRole(username: string, role: SpaceMemberRole): Promise<SpaceMemberInfo | null> {
    return this.space.setMemberRole(this.caller, username, role);
  }

  removeMember(profileId: string): Promise<void> {
    return this.space.removeMember(this.caller, profileId);
  }
}
