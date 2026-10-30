// Collaborator authorization, sharing, and permission-graph logic for a Gadget's Overseer.
//
// This module owns all manipulation of the `collaborators` and `shareKeys` storage collections
// and the permission graph that links them. It deliberately performs no RPC: anything that
// requires talking to a User DO (resolving a profile from a username, fetching the owner's
// profile, notifying a user that a gadget was opened, etc.) stays in the Overseer, which passes
// resolved values (or, where laziness matters, a callback) into this module.
//
// ACCESS: A collaborator holds "build" access to the whole workspace, or "use" access to some of
// its gadgets (see CollaboratorAccess). Each permission edge or share link confers its own grant
// only while its sharer (a link's creator) holds "build". A collaborator holds the union over all
// their valid edges; "use" access, including legacy access to every gadget, supports no grants.
//
// LAZY REVOCATION MODEL: Access is determined by reachability from the owner in the permission
// graph, recomputed live at every open() (see `getEffectiveAccess`). Revocation is therefore lazy:
// removing a collaborator only severs the edges granting *them* access, and revoking a share link
// only flags the link revoked. Nothing cascades, no records are deleted, and downstream edges are
// never touched -- users who lose their only path to the owner simply become unreachable and are
// denied at open() time. Because the graph is never destructively pruned, revocation is reversible:
// re-adding a removed collaborator with "build" restores their downstream grants (unless
// `ownerInvitesOnly` is set, when only the owner's direct grants count).
// (Records and revoked keys accumulate in storage; a future GC could reclaim long-dead entries.)
//
// NOTE: The sensitive-data (`containsRestrictedData`) policy intentionally does NOT live here; the
// Overseer enforces it. This module only answers questions about the sharing graph. The one
// exception is the `ownerInvitesOnly` flag, which the Overseer supplies as a hook: once it is set,
// only direct grants from the owner count, so it narrows which edges `computeEffectiveAccess`
// follows and must be checked synchronously with each grant's storage write.

import { AiChatAuthorInfo, CollaboratorInfo, PermissionEdge, CollaboratorRole, CollaboratorAccess,
    CollaboratorGrant, AffectedCollaborator, WorkpieceId, createOpenWorkspaceError,
    OPEN_WORKSPACE_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { Collection, NonUniqueIndex } from "@gadgets/typed-storage";
import type { CollaboratorRecord, ShareKeyRecord, ShareLinkRecord }
    from "./storage-schema/overseer-storage";

const BUILD: CollaboratorAccess = {role: "build"};

/**
 * Whether `access` lets its holder open gadget `gadgetId`. Says nothing about whether that gadget
 * exists: a grant naming a gadget that doesn't confers nothing (see SharingManager), but "build"
 * and "all" include every id.
 */
export function accessIncludesGadget(access: CollaboratorAccess, gadgetId: WorkpieceId): boolean {
  return access.role === "build" || access.gadgetIds === "all" ||
      access.gadgetIds.includes(gadgetId);
}

// Whether `a` grants everything `b` does.
function accessCovers(a: CollaboratorAccess, b: CollaboratorAccess): boolean {
  if (a.role === "build") return true;
  if (b.role === "build") return false;
  if (a.gadgetIds === "all") return true;
  if (b.gadgetIds === "all") return false;
  let held = a.gadgetIds;
  return b.gadgetIds.every(id => held.includes(id));
}

// What either `a` or `b` grants.
function unionAccess(a: CollaboratorAccess, b: CollaboratorAccess): CollaboratorAccess {
  if (a.role === "build" || b.role === "build") return BUILD;
  if (a.gadgetIds === "all" || b.gadgetIds === "all") return {role: "use", gadgetIds: "all"};
  return {
    role: "use",
    gadgetIds: [...new Set([...a.gadgetIds, ...b.gadgetIds])].toSorted((x, y) => x - y),
  };
}

// What `prior` grants that `now` does not cover (see accessCovers), as access to restore.
function lostAccess(prior: CollaboratorAccess, now: CollaboratorAccess | undefined)
    : CollaboratorAccess {
  if (!now || now.role === "build" || now.gadgetIds === "all" ||
      prior.role === "build" || prior.gadgetIds === "all") {
    return prior;
  }
  let kept = now.gadgetIds;
  return {role: "use", gadgetIds: prior.gadgetIds.filter(id => !kept.includes(id))};
}

// The fields of a permission edge or share link that say what it grants.
type GrantFields = {role?: CollaboratorRole; gadgetId?: WorkpieceId};

type UserEdge = Extract<PermissionEdge, {type: "user"}>;

// What `record` confers at most: its role (absent on records from before roles, meaning "build"),
// narrowed to the one gadget it names, if any.
function ceilingOf(record: GrantFields): CollaboratorAccess {
  if ((record.role ?? "build") === "build") return BUILD;
  return {role: "use", gadgetIds: record.gadgetId === undefined ? "all" : [record.gadgetId]};
}

// The edges conferring `access`: one per gadget, since an edge names at most one.
function grantFieldsFor(access: CollaboratorAccess): GrantFields[] {
  if (access.role === "build") return [{role: "build"}];
  if (access.gadgetIds === "all") return [{role: "use"}];
  return access.gadgetIds.map(gadgetId => ({role: "use", gadgetId}));
}

// Identifies what an edge or link grants, so what each grant confers is computed once.
function grantKey(record: GrantFields): string {
  return (record.role ?? "build") === "build" ? "build" : `use:${record.gadgetId ?? "all"}`;
}

// Fixed 256-bit key used to domain-separate share key hashes from other hashes in the system.
// Not secret -- it only provides personalization.
const SHARE_KEY_HMAC_KEY = new Uint8Array([
  0x09, 0x2a, 0x64, 0x37, 0xae, 0x8a, 0xce, 0x43,
  0x03, 0x81, 0x17, 0xed, 0x5b, 0x0c, 0x4a, 0xca,
  0x82, 0x23, 0x41, 0x11, 0x0b, 0x28, 0x48, 0x8f,
  0x57, 0x53, 0x25, 0x2a, 0xda, 0xa0, 0xbf, 0xd7,
]);

// Compute the storage ID (HMAC-SHA-256 hex) for a raw share key. The raw key is never stored
// server-side; only this hash is.
async function hashShareKey(rawKey: string): Promise<string> {
  let hmacKey = await crypto.subtle.importKey(
      "raw", SHARE_KEY_HMAC_KEY, { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]);
  let sig = new Uint8Array(await crypto.subtle.sign(
      "HMAC", hmacKey, Uint8Array.fromHex(rawKey)));
  return sig.toHex();
}

/**
 * The slice of Overseer storage this module operates on. Satisfied by the real OverseerStorage
 * and easily constructed over a Map-backed mock DurableObjectStorage in tests.
 */
export interface SharingStorage {
  collaborators: Collection<CollaboratorRecord>;
  shareKeys: Collection<ShareKeyRecord> & {
    /** A link's copies, keyed by the link they alias. */
    byAlias: NonUniqueIndex<ShareKeyRecord, string>;
  };
}

// Narrow a key record to a link, or undefined if it's an alias.
function asLink(record: ShareKeyRecord | undefined): ShareLinkRecord | undefined {
  return record !== undefined && record.alias === undefined ? record : undefined;
}

/**
 * Per-session caller identity. Mirrors the fields the OverseerClientInterface holds for the
 * connected client.
 */
export interface SharingCaller {
  /** The caller's profile.id (username/email). */
  profileId: string;
  /**
   * True if the caller is the gadget owner. The owner can manage anyone's collaborator edges
   * and share keys; non-owners are restricted to edges/keys they created themselves.
   */
  isOwner: boolean;
}

// A hypothetical change to the graph, for previews (see computeEffectiveAccess).
type GraphChange = {
  /** Edges treated as removed: `target` is the collaborator holding `edge`. */
  severed?: (target: string, edge: PermissionEdge) => boolean;
  /** A link treated as revoked. */
  revokedLinkId?: string;
};

export class SharingManager {
  /**
   * `ownerProfileId` is stable for the lifetime of a gadget, so it's supplied once at
   * construction rather than per call.
   *
   * `ownerInvitesOnly` reports the Overseer's `ownerInvitesOnly` flag (see
   * `ObservationDescription.ownerInvitesOnly`). `computeEffectiveAccess` reads it to count only
   * direct owner grants once it is set. Grants call it after their last await, right before the
   * storage write, so an observation that sets the flag mid-call cannot slip a grant through.
   *
   * `gadgetExists` reports whether a gadget can be shared: it exists and is no longer provisional
   * to a chat. A grant naming a gadget that doesn't confers nothing, and none can be made.
   */
  constructor(
      private storage: SharingStorage,
      private ownerProfileId: string,
      private ownerInvitesOnly: () => boolean,
      private gadgetExists: (gadgetId: WorkpieceId) => boolean) {}

  // Throw if share links are disabled by `ownerInvitesOnly`. Redemption refusals surface
  // from open(), so they carry the `shareLinksDisabled` open-workspace code; link management throws
  // the same message uncoded.
  #requireShareLinksAllowed(opts?: { redeeming: boolean }): void {
    if (this.ownerInvitesOnly()) {
      let error = createOpenWorkspaceError(OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled);
      throw opts?.redeeming ? error : new Error(error.message);
    }
  }

  // Every share link, revoked or not. Aliases are skipped.
  *#listLinks(): Generator<ShareLinkRecord> {
    for (let record of this.storage.shareKeys.list()) {
      let link = asLink(record);
      if (link) yield link;
    }
  }

  // What `record` confers now (see ceilingOf): nothing if the one gadget it names can't be shared.
  #liveCeiling(record: GrantFields): CollaboratorAccess | undefined {
    if (record.role === "use" && record.gadgetId !== undefined &&
        !this.gadgetExists(record.gadgetId)) {
      return undefined;
    }
    return ceilingOf(record);
  }

  // The edge fields recording `grant`, throwing if it names a gadget that can't be shared.
  #grantFields(grant: CollaboratorGrant): GrantFields {
    if (grant === "build") return {role: "build"};
    if (!this.gadgetExists(grant.gadgetId)) {
      throw new Error(`No such gadget: ${grant.gadgetId}`);
    }
    return {role: "use", gadgetId: grant.gadgetId};
  }

  // Throw unless `caller` holds "build": only then do the grants they make confer anything (see
  // computeEffectiveAccess).
  #requireCanShare(caller: SharingCaller): void {
    if (!caller.isOwner &&
        this.computeEffectiveAccess().get(caller.profileId)?.role !== "build") {
      throw new Error("You do not have permission to share this workspace.");
    }
  }

  // ---------------------------------------------------------------------------------------
  // Authorization (used by Overseer.open())

  /**
   * True if `profileId` currently has a collaborator record. This only checks membership; use
   * `getEffectiveAccess()` to determine the actual access (and whether the record is still
   * reachable from the owner in the permission graph).
   */
  isCollaborator(profileId: string): boolean {
    return this.storage.collaborators.get(profileId) !== undefined;
  }

  /**
   * The effective access of `profileId` -- everything reachable from the owner through valid
   * permission edges -- or undefined if the user has no access. The owner always has "build".
   */
  getEffectiveAccess(profileId: string): CollaboratorAccess | undefined {
    if (profileId === this.ownerProfileId) return BUILD;
    return this.computeEffectiveAccess().get(profileId);
  }

  /**
   * Redeem a raw share key on behalf of a user opening the gadget. If the key exists, ensures the
   * user is a collaborator with a `shareKey` edge for its link (adding the edge if missing, or
   * creating the collaborator record if they're new). Does nothing if the key is unknown.
   *
   * The raw key is hashed internally; the plaintext is never stored. `fetchProfile` is invoked
   * (an RPC, in production) only when a brand-new collaborator must be created, so existing
   * collaborators are redeemed without any RPC.
   *
   * A key whose link is revoked behaves like an unknown key (it cannot be redeemed), as does one
   * whose link grants a gadget that can no longer be shared. A link granting every gadget, made
   * before gadgets were shared individually, adds no edges either: the people who redeemed it
   * keep the edge they hold, but no one else is given that access anymore.
   *
   * If the workspace has `ownerInvitesOnly` set, a valid key adds nothing: a collaborator the
   * owner added directly is left as they are (so reopening an old link doesn't fail), and anyone
   * else -- including someone who joined through a link before the flag was set -- is refused with
   * a `shareLinksDisabled` exception.
   *
   * TODO: The edge is written before the redeeming open()'s observer verification runs, so a
   * recipient whose verification fails lingers in listCollaborators until removed or the link is
   * revoked.
   */
  async redeemShareKey(opts: {
    rawKey: string;
    profileId: string;
    fetchProfile: () => Promise<AiChatAuthorInfo>;
  }): Promise<void> {
    let hash = await hashShareKey(opts.rawKey);
    let keyRecord = this.storage.shareKeys.get(hash);
    if (!keyRecord) return;

    // Edges point at the link, not the individual key, so a link's keys collapse to one grant.
    // A copy of a link is an alias; follow it to the link that owns the metadata.
    let link = keyRecord.alias === undefined
        ? keyRecord : asLink(this.storage.shareKeys.get(keyRecord.alias));
    if (!link || link.revoked) return;
    let linkId = link.id;

    if (this.ownerInvitesOnly()) {
      // Only direct owner grants count (see computeEffectiveAccess), so the link can grant nothing.
      // Let someone who already has access through the owner re-open with it; refuse anyone else.
      if (!this.getEffectiveAccess(opts.profileId)) {
        this.#requireShareLinksAllowed({ redeeming: true });
      }
      return;
    }

    let ceiling = this.#liveCeiling(link);
    if (!ceiling || (ceiling.role === "use" && ceiling.gadgetIds === "all")) return;

    let edge: PermissionEdge = {
      type: "shareKey",
      keyId: linkId,
      created: new Date(),
      role: link.role ?? "build",
      ...(link.gadgetId !== undefined ? {gadgetId: link.gadgetId} : {}),
    };
    let existing = this.storage.collaborators.get(opts.profileId);
    if (existing) {
      // User is already a collaborator. Only add an edge if they don't already have one for this
      // link (redeeming a second key of the same link is a no-op).
      let alreadyHasEdge = existing.addedBy.some(
          e => e.type === "shareKey" && e.keyId === linkId);
      if (!alreadyHasEdge) {
        existing.addedBy.push(edge);
        this.storage.collaborators.put(existing);
      }
    } else {
      // New collaborator -- need full profile from their user DO. The RPC may race an observation
      // setting ownerInvitesOnly, so check again right before the write.
      let profile = await opts.fetchProfile();
      this.#requireShareLinksAllowed({ redeeming: true });
      this.storage.collaborators.put({ profile, addedBy: [edge] });
    }
  }

  // ---------------------------------------------------------------------------------------
  // Collaborator management

  /**
   * List currently-active collaborators -- those with a live path from the owner. Under the lazy
   * revocation model, removed collaborators linger in storage with no reachable access; they are
   * omitted here (they reappear if re-added).
   */
  listCollaborators(): CollaboratorInfo[] {
    let accesses = this.computeEffectiveAccess();
    let result: CollaboratorInfo[] = [];
    for (let record of this.storage.collaborators.list()) {
      let access = accesses.get(record.profile.id);
      if (!access) continue;  // not currently reachable from the owner
      result.push({
        profile: record.profile,
        addedBy: record.addedBy,
        access,
      });
    }
    return result;
  }

  /**
   * Grant `profile` access with a `user` edge from the caller, adding them as a collaborator if
   * they aren't one. The caller is responsible for resolving `profile` (via RPC) and for any policy
   * checks. The caller must hold "build" (see computeEffectiveAccess). Once `ownerInvitesOnly` is
   * set, only the owner may call this.
   */
  addCollaborator(opts: {
    caller: SharingCaller;
    profile: AiChatAuthorInfo;
    grant: CollaboratorGrant;
    note?: string;
  }): CollaboratorInfo {
    // Don't add the owner as a collaborator.
    if (opts.profile.id === this.ownerProfileId) {
      throw new Error("Cannot add the workspace owner as a collaborator.");
    }

    if (this.ownerInvitesOnly() && !opts.caller.isOwner) {
      throw new Error(
          "Only the workspace owner can add people to a workspace that contains sensitive data.");
    }

    let fields = this.#grantFields(opts.grant);
    this.#requireCanShare(opts.caller);

    let record = this.storage.collaborators.get(opts.profile.id) ??
        {profile: opts.profile, addedBy: []};
    this.#grantEdge(record, opts.caller.profileId, fields, opts.note);
    this.storage.collaborators.put(record);
    return {
      profile: record.profile,
      addedBy: record.addedBy,
      access: this.computeEffectiveAccess().get(record.profile.id) ?? ceilingOf(fields),
    };
  }

  // Give `record` a user edge from `sharer` conferring `fields`, keeping that sharer's edges to it
  // minimal. "build" covers every gadget, and so does a legacy grant of every gadget, so anything
  // else from the same sharer would only repeat it: the one way a sharer holds several edges to one
  // person is several individual gadgets. A grant one of their edges already covers only updates
  // that edge's note -- granting less never narrows anyone. A wider grant takes over the first edge
  // it covers (keeping its note unless given one) and drops the rest.
  #grantEdge(record: CollaboratorRecord, sharer: string, fields: GrantFields, note?: string): void {
    let granted = ceilingOf(fields);
    let own = record.addedBy.filter(
        (edge): edge is UserEdge => edge.type === "user" && edge.sharer === sharer);
    let covering = own.find(edge => accessCovers(ceilingOf(edge), granted));
    if (covering) {
      if (note !== undefined) covering.note = note;
      return;
    }
    let [kept, ...dropped] = own.filter(edge => accessCovers(granted, ceilingOf(edge)));
    if (!kept) {
      record.addedBy.push({type: "user", sharer, created: new Date(), ...fields, note});
      return;
    }
    kept.role = fields.role;
    if (fields.gadgetId === undefined) delete kept.gadgetId;
    else kept.gadgetId = fields.gadgetId;
    if (note !== undefined) kept.note = note;
    let droppedEdges = new Set<PermissionEdge>(dropped);
    record.addedBy = record.addedBy.filter(edge => !droppedEdges.has(edge));
  }

  // The edges a removal by `caller` severs: every edge granting `profileId` access (for the owner)
  // or the caller's own user edges to them, narrowed to grants of `gadgetId` when given.
  #severs(caller: SharingCaller, profileId: string, gadgetId?: WorkpieceId)
      : (target: string, edge: PermissionEdge) => boolean {
    return (target, edge) => target === profileId &&
        (caller.isOwner || (edge.type === "user" && edge.sharer === caller.profileId)) &&
        (gadgetId === undefined || (edge.role === "use" && edge.gadgetId === gadgetId));
  }

  previewRemoveCollaborator(caller: SharingCaller, profileId: string, gadgetId?: WorkpieceId)
      : AffectedCollaborator[] {
    if (!this.storage.collaborators.get(profileId)) return [];
    return this.#computeAffected(this.computeEffectiveAccess(),
        this.computeEffectiveAccess({severed: this.#severs(caller, profileId, gadgetId)}));
  }

  /**
   * Remove a collaborator by severing the edges that grant them access -- with `gadgetId`, only
   * those granting that gadget. This is a *lazy* removal: nothing cascades and no records are
   * deleted. The target's record (and crucially, any edges where the target is the *sharer* of
   * access to others) is left intact, and dependents who lose their only path to the owner simply
   * become unreachable -- they are denied at open() time, not pruned here. This makes the removal
   * trivially reversible: re-adding the target with "build" (see addCollaborator) restores their
   * downstream grants. Re-adding only gadget access leaves those grants inactive.
   *
   *   - The owner severs *all* incoming edges to the target (owner-removal means "gone now").
   *   - A non-owner severs only their own `user` edges to the target; if the target retains other
   *     edges, they keep the access those grant.
   *
   * `keepUsers` is optional re-root sugar: any listed dependent whose access would otherwise narrow
   * is granted fresh edges from the caller restoring what they lost (see `#reRootKeptUsers`).
   * Returns the collaborators whose access actually narrowed, excluding kept users.
   */
  removeCollaborator(caller: SharingCaller, profileId: string, keepUsers: string[],
                     gadgetId?: WorkpieceId): AffectedCollaborator[] {
    let target = this.storage.collaborators.get(profileId);
    if (!target) {
      throw new Error("User is not a collaborator.");
    }

    // Permission check: owner can remove anyone; collaborators can only remove users
    // they themselves added.
    let severed = this.#severs(caller, profileId, gadgetId);
    if (!caller.isOwner && !target.addedBy.some(edge => severed(profileId, edge))) {
      throw new Error("You can only remove users that you added.");
    }

    let baseline = this.computeEffectiveAccess();

    // Sever the edges that grant the target access. The record is retained even if it becomes
    // empty, so the target's own outgoing grants survive and the removal can be undone.
    target.addedBy = target.addedBy.filter(edge => !severed(profileId, edge));
    this.storage.collaborators.put(target);

    this.#reRootKeptUsers(caller, baseline, new Set(keepUsers));

    return this.#computeAffected(baseline, this.computeEffectiveAccess());
  }

  // ---------------------------------------------------------------------------------------
  // Share link management

  // Enforce that `caller` may manage `link`: the owner can manage any link; a collaborator only
  // the links they created. `action` is the user-facing verb (e.g. "revoke", "edit", "copy").
  #requireLinkManager(caller: SharingCaller, link: ShareLinkRecord, action: string): void {
    if (!caller.isOwner && link.createdBy !== caller.profileId) {
      throw new Error(`You can only ${action} share links that you created.`);
    }
  }

  // Look up a link by id, throwing the caller-facing error if the id is unknown or names an alias..
  #requireLink(linkId: string): ShareLinkRecord {
    let link = asLink(this.storage.shareKeys.get(linkId));
    if (!link) {
      throw new Error("Share link not found.");
    }
    return link;
  }

  async createShareLink(
      opts: { caller: SharingCaller; grant: CollaboratorGrant; note?: string })
      : Promise<{ key: string; linkId: string }> {
    let fields = this.#grantFields(opts.grant);
    this.#requireCanShare(opts.caller);

    // The link is stored as its first key: the record is keyed by that key's hash.
    let { key, hash } = await this.#mintKey();
    this.#requireShareLinksAllowed();
    this.storage.shareKeys.put({
      id: hash,
      note: opts.note,
      created: new Date(),
      createdBy: opts.caller.profileId,
      ...fields,
    });
    return { key, linkId: hash };
  }

  /** Mints another key for an existing link. */
  async newShareLinkKey(opts: { caller: SharingCaller; linkId: string }): Promise<{ key: string }> {
    let link = this.#requireLink(opts.linkId);
    let ceiling = this.#liveCeiling(link);
    if (link.revoked || !ceiling) {
      throw new Error("Share link not found.");
    }
    this.#requireLinkManager(opts.caller, link, "copy");
    if (ceiling.role === "use" && ceiling.gadgetIds === "all") {
      throw new Error("This link shares every gadget in the workspace, which links no longer " +
          "do. Create a link to one gadget instead.");
    }

    // The caller may have lost "build" since creating the link, which left it conferring nothing
    // (see computeEffectiveAccess): a fresh key must not hand it out.
    this.#requireCanShare(opts.caller);

    let { key, hash } = await this.#mintKey();
    this.#requireShareLinksAllowed();
    this.storage.shareKeys.put({ id: hash, alias: link.id });
    return { key };
  }

  // Generate a random 128-bit key, returning it along with the hash it is stored under. The caller
  // decides whether that hash keys a link or an alias.
  async #mintKey(): Promise<{ key: string; hash: string }> {
    let rawBytes = new Uint8Array(16);
    crypto.getRandomValues(rawBytes);
    let key = rawBytes.toHex();
    return { key, hash: await hashShareKey(key) };
  }

  /**
   * Active (non-revoked) share links. The Overseer maps each `createdBy` profile.id to a display
   * profile (which may require RPC) to produce `ShareLinkInfo`s; see `getCreatorProfile`.
   */
  listShareLinkRecords(): ShareLinkRecord[] {
    return [...this.#listLinks()].filter(link => !link.revoked);
  }

  /**
   * Resolve the display profile for a share link's creator using only locally-available data
   * (the collaborator table). Returns undefined if the creator is neither a current collaborator
   * nor matched here (e.g. the owner), in which case the Overseer resolves it via RPC. The final
   * fallback (a bare profile from the id) is also the Overseer's responsibility.
   */
  getCreatorProfile(createdBy: string): AiChatAuthorInfo | undefined {
    return this.storage.collaborators.get(createdBy)?.profile;
  }

  updateShareLink(caller: SharingCaller, linkId: string, note?: string): void {
    let link = this.#requireLink(linkId);
    this.#requireLinkManager(caller, link, "edit");

    link.note = note === undefined ? undefined : note.slice(0, 500);
    this.storage.shareKeys.put(link);
  }

  previewRevokeShareLink(caller: SharingCaller, linkId: string): AffectedCollaborator[] {
    let link = asLink(this.storage.shareKeys.get(linkId));
    if (!link) return [];
    this.#requireLinkManager(caller, link, "revoke");
    if (link.revoked) return [];

    return this.#computeAffected(this.computeEffectiveAccess(),
        this.computeEffectiveAccess({ revokedLinkId: linkId }));
  }

  /**
   * Revoke a share link by soft-revoking it (setting the `revoked` flag) rather than deleting it.
   * This is the lazy counterpart to removeCollaborator: the link record and every `shareKey` edge
   * referencing it stay intact (no dangling references), but the link contributes nothing to the
   * permission graph and its keys can no longer be redeemed. Its copies are deleted outright,
   * since no edge ever names an alias. Users who relied solely on it become unreachable and
   * are denied at open() time.
   *
   * `keepUsers` is optional re-root sugar, identical to removeCollaborator. Returns the
   * collaborators whose access actually narrowed, excluding kept users.
   */
  revokeShareLink(
      caller: SharingCaller, linkId: string, keepUsers: string[]): AffectedCollaborator[] {
    let link = this.#requireLink(linkId);
    this.#requireLinkManager(caller, link, "revoke");

    let baseline = this.computeEffectiveAccess();

    link.revoked = true;
    this.storage.shareKeys.put(link);

    // Revoking makes the copies useless, and nothing references them, so delete them.
    this.storage.shareKeys.byAlias.delete(link.id);

    this.#reRootKeptUsers(caller, baseline, new Set(keepUsers));

    return this.#computeAffected(baseline, this.computeEffectiveAccess());
  }

  // ---------------------------------------------------------------------------------------
  // Permission-graph engine

  /**
   * Compute the effective access of every collaborator -- everything reachable from the owner
   * through valid permission edges. A collaborator absent from the returned map has no access.
   *
   * The owner is the implicit root with "build". Each edge confers its grant only while its
   * sharer holds "build", and a collaborator holds the union of what their valid edges grant:
   *   - A "user" edge's sharer is the owner or another collaborator.
   *   - A "shareKey" edge's "sharer" is the link's creator, and what it confers is the link's.
   * A grant naming a gadget that can no longer be shared confers nothing (see `gadgetExists`).
   * The computation is a least fixed point: access only grows across passes, so it converges,
   * and a cycle of grants unreachable from the owner supports nothing.
   *
   * `change` models a hypothetical change, used by the preview methods.
   *
   * Once `ownerInvitesOnly` is set, only direct grants from the owner count: every `shareKey` edge
   * (even for a link the owner created) and every `user` edge from anyone but the owner is
   * skipped. People who reached the workspace any other way lose access, and a collaborator whose
   * owner edges grant less than they reached transitively keeps only what those grant.
   */
  computeEffectiveAccess(change: GraphChange = {}): Map<string, CollaboratorAccess> {
    let ownerGrantsOnly = this.ownerInvitesOnly();

    // Listed up front, so that nothing below reads storage while a listing is open.
    let collaborators = [...this.storage.collaborators.list()];
    let links = [...this.#listLinks()].filter(
        link => !link.revoked && link.id !== change.revokedLinkId);

    // A grant's ceiling depends only on the grant, so each is computed once.
    let ceilings = new Map<string, CollaboratorAccess | undefined>();
    let ceiling = (record: GrantFields): CollaboratorAccess | undefined => {
      let key = grantKey(record);
      if (!ceilings.has(key)) ceilings.set(key, this.#liveCeiling(record));
      return ceilings.get(key);
    };

    // Map linkId → what redeeming it grants and who supports it, excluding revoked links (the
    // persisted `revoked` flag, and the hypothetical `revokedLinkId` used by preview).
    let linkInfo = new Map<string, { creator: string; ceiling: CollaboratorAccess }>();
    for (let link of links) {
      let linkCeiling = ceiling(link);
      if (linkCeiling) linkInfo.set(link.id, { creator: link.createdBy, ceiling: linkCeiling });
    }

    // Access known so far.
    let eff = new Map<string, CollaboratorAccess>();

    // Fixed-point iteration. Access only grows, so this converges.
    let changed = true;
    while (changed) {
      changed = false;
      for (let record of collaborators) {
        let id = record.profile.id;
        let known = eff.get(id);
        let best = known;
        for (let edge of record.addedBy) {
          if (change.severed?.(id, edge)) continue;
          let source: string;
          let conferred: CollaboratorAccess | undefined;
          if (edge.type === "shareKey") {
            if (ownerGrantsOnly) continue;
            let info = linkInfo.get(edge.keyId);
            if (!info) continue;  // link revoked or no longer exists
            source = info.creator;
            conferred = info.ceiling;
          } else {
            if (ownerGrantsOnly && edge.sharer !== this.ownerProfileId) continue;
            source = edge.sharer;
            conferred = ceiling(edge);
          }
          let upstream = source === this.ownerProfileId ? BUILD : eff.get(source);
          let granted = upstream?.role === "build" ? conferred : undefined;
          if (granted) best = best ? unionAccess(best, granted) : granted;
        }
        if (best && !(known && accessCovers(known, best))) {
          eff.set(id, best);
          changed = true;
        }
      }
    }

    return eff;
  }

  /**
   * The collaborators whose access narrowed when `ownerInvitesOnly` was set, given `baseline`,
   * the effective access computed just before the flag was set.
   */
  computeAffectedByOwnerInvitesOnly(
      baseline: Map<string, CollaboratorAccess>): AffectedCollaborator[] {
    return this.#computeAffected(baseline, this.computeEffectiveAccess());
  }

  // Diff two effective-access maps, returning the collaborators whose access narrowed. A user is
  // affected if they had access in `baseline` and `modified` grants them less: nothing at all
  // (newAccess null), or not everything they had. Profiles/edges are read from current storage.
  #computeAffected(
      baseline: Map<string, CollaboratorAccess>,
      modified: Map<string, CollaboratorAccess>): AffectedCollaborator[] {
    let result: AffectedCollaborator[] = [];
    for (let [id, oldAccess] of baseline) {
      let newAccess = modified.get(id) ?? null;
      if (newAccess && accessCovers(newAccess, oldAccess)) {
        continue;  // unchanged or (shouldn't happen) widened
      }
      let record = this.storage.collaborators.get(id);
      if (!record) continue;
      result.push({
        profile: record.profile,
        addedBy: record.addedBy,
        oldAccess,
        newAccess,
      });
    }
    return result;
  }

  // Optional re-root sugar for removeCollaborator/revokeShareLink. Must be called *after* the
  // edge/key has already been severed in storage. `baseline` is the effective-access map from
  // before the severance. Each kept user whose access narrowed is given fresh `user` edges from the
  // caller restoring what they lost, so they retain it independently of the severed path; a caller
  // without "build" keeps no one, since their edges would confer nothing. Restoring access to every
  // gadget writes such a grant again: it is not newly assigned, only kept.
  #reRootKeptUsers(
      caller: SharingCaller, baseline: Map<string, CollaboratorAccess>,
      keepSet: Set<string>): void {
    if (keepSet.size === 0) return;

    let afterSever = this.computeEffectiveAccess();
    if (!caller.isOwner && afterSever.get(caller.profileId)?.role !== "build") return;

    for (let id of keepSet) {
      let prior = baseline.get(id);
      if (!prior) continue;  // had no access to begin with -- nothing to keep

      let now = afterSever.get(id);
      if (now && accessCovers(now, prior)) continue;  // nothing lost -- no edge needed

      let record = this.storage.collaborators.get(id);
      if (!record) continue;

      for (let fields of grantFieldsFor(lostAccess(prior, now))) {
        this.#grantEdge(record, caller.profileId, fields);
      }
      this.storage.collaborators.put(record);
    }
  }
}
