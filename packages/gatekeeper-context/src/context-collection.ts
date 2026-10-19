// One collection's metadata, documents, and access grants. Metadata changes of a public collection
// update the domain registry; grant changes update the grantee's library.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionContent, ContextCollectionMember, ContextCollectionMetadata,
  ContextCollectionRole, ContextCollectionSharing, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary,
  ContextGitTokenCreateResult, ContextGitTokenList,
  DEFAULT_DOCUMENT_CONTENT_TYPE, DEFAULT_GIT_BRANCH, MAX_DOCUMENT_BODY_BYTES,
  contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import {
  type CollectionAccess, collectionPermissions,
} from "./collection-access.js";
import { metadataToSummary } from "./collection-kv.js";
import { domainName } from "./domain.js";
import {
  readArtifactRepoDocuments, type ArtifactContextDocument,
} from "./artifact-sync.js";
import {
  isSkillManifestPath, parseSkillManifest, updateSkillManifestName, type SkillIndexEntry,
  type SkillManifestMetadata,
} from "./agent-skill.js";
import { obsContext } from "./observability.js";
import {
  decodeStoredContextBody, encodeStoredContextBody, truncateContextDescription,
} from "./context-storage.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

const MAX_DOCUMENT_PATH_LENGTH = 1024;
// Invalid skill manifests named in one sync's warning; the count covers the rest.
const MAX_LOGGED_INVALID_SKILLS = 10;

type AgentSkillParse = { manifest: SkillManifestMetadata } | { error: string };

// Git tokens created through the web UI are valid for one year,
// the maximum TTL supported by Artifacts.
const GIT_TOKEN_TTL_SECONDS = 31_536_000;
// Background git refresh happens minutely at most.
const GIT_REFRESH_MIN_INTERVAL_MS = 60_000;
// Retry a failed git token revocation after 5 minutes, doubling up to a day.
const GIT_TOKEN_REVOKE_RETRY_MS = 5 * 60_000;
const GIT_TOKEN_REVOKE_RETRY_MAX_MS = 24 * 60 * 60_000;
// Allow simple branch names made of alphanumerics, '/', '.', '_', and '-', but not leading/trailing '/'.
const GIT_BRANCH_RE = /^(?!\/)(?!.*\/$)[A-Za-z0-9/._-]{1,255}$/;
// Older collections build this path list on first use. Increase the version when parsing rules
// change.
const SKILL_INDEX_VERSION = 1;

// Validate a document path before using it as a storage key.
function validateDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

// Last path segment; document names derive from paths.
function baseName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// Lowercased file extension (without the dot), or "" if none.
function extOf(path: string): string {
  let b = baseName(path);
  let i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

type ContextRecord = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  // Text is stored as UTF-8 and binary as raw bytes to keep SQLite values close to source size.
  // Legacy records have string bodies: literal text or base64 for binary content.
  body: string | Uint8Array;
  lastUpdated: Date;
};

function contextRecord(document: ContextDocument): ContextRecord & { body: Uint8Array } {
  return {
    ...document,
    description: truncateContextDescription(document.description),
    body: encodeStoredContextBody(document.contentType, document.body),
  };
}

function contextRecordSize(record: ContextRecord): number {
  let bodyBytes = record.body instanceof Uint8Array
    ? record.body.byteLength
    : new TextEncoder().encode(record.body).byteLength;
  return bodyBytes + new TextEncoder().encode(
    JSON.stringify({ ...record, body: "" }),
  ).byteLength;
}

// Old records that predate git-based collections won't have `content` set in storage.
// Unset `content` is defaulted to { "source": "web" } at the API layer, which is why
// we have different types for storage vs. API interface.
type StoredContextCollectionMetadata = Omit<ContextCollectionMetadata, "content"> & {
  content?: ContextCollectionContent;
};

type GrantRecord = {
  accountId: string;
  role: ContextCollectionRole;
  /** Workshop display name when granted; absent for a creator migrated from `ownerAccountId`. */
  displayName?: string;
  grantedAt: Date;
};

// Which account minted a git write token, so losing write access can revoke it. Legacy tokens are
// attributed to the creator and recorded when their first sweep runs.
type GitTokenIssuerRecord = {
  tokenId: string;
  accountId: string;
};

// Bump when grants need rebuilding from older storage.
const ACL_VERSION = 1;

const NOT_FOUND = "Collection not found or you don't have access.";

// Members list owners first, then editors, then viewers.
const ROLE_ORDER: Record<ContextCollectionRole, number> = { owner: 0, editor: 1, viewer: 2 };

function makeContextCollectionStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      documents: collection<ContextRecord>()({ primaryKey: "path" }),
      // Data needed to list skills without loading document bodies.
      skillIndex: collection<SkillIndexEntry>()({ primaryKey: "path" }),
      // Private collections only: every account's role. Authoritative for access.
      grants: collection<GrantRecord>()({ primaryKey: "accountId" }),
      gitTokenIssuers: collection<GitTokenIssuerRecord>()({ primaryKey: "tokenId" }),
    },
    singletons: {
      // Sharing domain for cross-DO references.
      sharingDomain: "",
      // The creating account (its owned index lists this collection); empty for public
      // collections. Authority comes from `grants`, which started with this account as owner.
      ownerAccountId: "",
      everyoneCanView: false,
      aclVersion: 0,
      // Consecutive failed attempts to revoke a token whose issuer lost write access.
      gitTokenRevokeAttempts: 0,
      // Once all pre-sharing tokens have issuer records, later changes need no legacy-token scan.
      legacyGitTokensSwept: false,
      // Keep deletion durable until external cleanup succeeds; pending collections are unreadable.
      deletionPending: false,
      metadata: <StoredContextCollectionMetadata>{
        id: "",
        title: "",
        description: "",
        visibility: "private" as ContextCollectionVisibility,
        created: new Date(0),
        lastUpdated: new Date(0),
        documentCount: 0,
        content: { source: "web" },
      },
      skillIndexVersion: 0,
    },
  });
}

type ContextCollectionStorage = ReturnType<typeof makeContextCollectionStorage>;

export class ContextCollectionDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ContextCollectionStorage;
  // Set when an artifact refresh operation is in flight. Additional refresh requests should
  // await this promise when set instead of kicking off additional concurrent refreshes.
  #artifactRefresh?: Promise<void>;
  // Grant changes and git token minting await other services. They run one at a time, so each sees
  // the grants the previous one left: a share and a removal can't interleave their library and
  // grant writes, and a token can't be minted on access removed while the mint was pending.
  #accessChanges: Promise<unknown> = Promise.resolve();

  #serializeAccessChange<T>(change: () => Promise<T>): Promise<T> {
    let result = this.#accessChanges.then(change);
    this.#accessChanges = result.catch(() => {});
    return result;
  }

  #assertRecordSize(record: ContextRecord): void {
    let byteLength = contextRecordSize(record);
    if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(`Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }
  }

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeContextCollectionStorage(ctx.storage);
  }

  // Sharing domain for all cross-DO/KV references.
  #domain(): string {
    return this.storage.sharingDomain.get();
  }

  // An account's UserLibraryDurableObject, within this collection's domain.
  #library(accountId: string) {
    let ns = this.ctx.exports.UserLibraryDurableObject;
    return ns.get(ns.idFromName(domainName(this.#domain(), accountId)));
  }

  #registry() {
    let ns = this.ctx.exports.LibraryRegistryDurableObject;
    return ns.getByName(this.#domain());
  }

  #artifacts(): Artifacts {
    let artifacts = this.env.ARTIFACTS;
    if (!artifacts) throw new Error("Git-backed Context collections are not enabled.");
    return artifacts;
  }

  async #createArtifactRepo(metadata: ContextCollectionMetadata): Promise<string> {
    // Artifact repo id is always set to collection id.
    let artifacts = this.#artifacts();
    let created = await artifacts.create(metadata.id, {
      setDefaultBranch: DEFAULT_GIT_BRANCH,
    });

    let repo = await artifacts.get(metadata.id);
    // Artifacts auto-creates an initial write token when the repo is first
    // created. We don't want or need this token, so we immediately revoke it.
    await repo.revokeToken(created.token).catch((err) => {
      logger.warn("failed to revoke initial Artifacts token for context collection", {
        event: "artifacts.initial.token.revoke.failed",
        collectionId: metadata.id,
        error: err,
      });
    });
    return created.remote;
  }

  /**
   * Initialize a new collection. Private collections pass an owner; public collections pass "".
   * Rejects re-initialization so a (vanishingly unlikely) id reuse can't clobber existing content.
   */
  async initialize(metadata: ContextCollectionMetadata, sharingDomain: string, ownerAccountId: string): Promise<ContextCollectionMetadata> {
    if (this.getMetadata().id) {
      throw new Error("Collection already exists.");
    }
    this.storage.sharingDomain.put(sharingDomain);
    this.storage.ownerAccountId.put(ownerAccountId);
    if (metadata.visibility === "private" && ownerAccountId) {
      this.storage.grants.put({ accountId: ownerAccountId, role: "owner", grantedAt: metadata.created });
    }
    this.storage.aclVersion.put(ACL_VERSION);
    if (metadata.content.source === "git") {
      metadata.content = {
        source: "git",
        remote: await this.#createArtifactRepo(metadata),
        branch: metadata.content.branch,
        lastRefreshedAt: metadata.created,
      };
    }
    this.storage.metadata.put(metadata);
    // A new collection starts with an up-to-date empty path list.
    this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    return metadata;
  }

  getMetadata(): ContextCollectionMetadata {
    let meta = this.storage.metadata.get();
    // Old storage records won't have `content` set, so we need to default these values in
    // at the API layer.
    return { ...meta, content: meta.content ?? { source: "web" } };
  }

  // --- Access ---

  // Collections created before sharing existed get their creator as sole owner.
  #ensureGrants(): void {
    if (this.storage.aclVersion.get() === ACL_VERSION) return;
    let meta = this.storage.metadata.get();
    // Not a collection (yet): write nothing, so probing an unknown ID creates no storage.
    if (!meta.id) return;
    let creator = this.storage.ownerAccountId.get();
    this.storage.transaction(() => {
      if (meta.visibility === "private" && creator && !this.storage.grants.get(creator)) {
        this.storage.grants.put({ accountId: creator, role: "owner", grantedAt: meta.created });
      }
      this.storage.aclVersion.put(ACL_VERSION);
    });
  }

  /** The account's standing here; `collection-access.ts` interprets it. */
  getAccess(accountId: string): CollectionAccess {
    this.#ensureGrants();
    let meta = this.storage.metadata.get();
    let grants = [...this.storage.grants.list()];
    let everyoneCanView = this.storage.everyoneCanView.get();
    let role = meta.visibility === "private"
      ? grants.find(grant => grant.accountId === accountId)?.role ?? null
      : null;
    return {
      exists: !!meta.id && !this.storage.deletionPending.get(),
      visibility: meta.visibility,
      role,
      everyoneCanView,
      hasOwner: grants.some(grant => grant.role === "owner"),
      shared: everyoneCanView || grants.some(grant => grant.accountId !== accountId),
    };
  }

  /**
   * What a library lists for this collection: its metadata if the account holds a role on it, else
   * null. `access.exists` tells the library whether the collection is gone for good.
   */
  getLibraryEntry(accountId: string):
      { access: CollectionAccess; metadata: ContextCollectionMetadata | null } {
    let access = this.getAccess(accountId);
    let isMember = access.exists && access.role !== null;
    return { access, metadata: isMember ? this.getMetadata() : null };
  }

  /** Members and everyone-viewability, for an account holding a role on this collection. */
  getSharing(accountId: string): ContextCollectionSharing {
    let access = this.getAccess(accountId);
    if (!access.exists || access.role === null) throw new Error(NOT_FOUND);
    let members: ContextCollectionMember[] = [...this.storage.grants.list()]
      .toSorted((left, right) =>
        ROLE_ORDER[left.role] - ROLE_ORDER[right.role]
        || left.grantedAt.valueOf() - right.grantedAt.valueOf())
      .map(grant => ({
        memberId: grant.accountId,
        role: grant.role,
        displayName: grant.displayName,
        isViewer: grant.accountId === accountId,
      }));
    return { members, everyoneCanView: access.everyoneCanView, hasOwner: access.hasOwner };
  }

  // Throws unless `actorId` may give `targetId` the role `role`, or remove them (null).
  #authorizeGrantChange(actorId: string, targetId: string, role: ContextCollectionRole | null): void {
    let access = this.getAccess(actorId);
    if (!access.exists || access.role === null) throw new Error(NOT_FOUND);
    let current = this.storage.grants.get(targetId)?.role;
    // Anyone may leave; every other change needs sharing rights.
    if (actorId !== targetId || role !== null) {
      let permissions = collectionPermissions(access, false);
      if (!permissions.canShare) {
        throw new Error("Only editors and owners can change who has access to this collection.");
      }
      if ((role === "owner" || current === "owner") && !permissions.canManageOwners) {
        throw new Error("Only owners can change who owns this collection.");
      }
    }
    if (current === "owner" && role !== "owner"
        && [...this.storage.grants.list()].filter(grant => grant.role === "owner").length === 1) {
      throw new Error("A collection needs an owner. Make someone else an owner first.");
    }
  }

  /**
   * Give each recipient a role. Every recipient's library records the collection before any grant
   * is written, and the grants are then written together: a failure leaves at most index entries,
   * which confer nothing (every listing re-checks the grant here), and repeating the share
   * completes it.
   */
  async share(
      actorId: string, recipients: { accountId: string; displayName: string }[],
      role: ContextCollectionRole): Promise<void> {
    await this.#serializeAccessChange(async () => {
      for (let { accountId } of recipients) this.#authorizeGrantChange(actorId, accountId, role);
      if (role !== "owner") {
        let recipientIds = new Set(recipients.map(recipient => recipient.accountId));
        let owners = [...this.storage.grants.list()].filter(grant => grant.role === "owner");
        if (owners.length > 0 && owners.every(owner => recipientIds.has(owner.accountId))) {
          throw new Error("A collection needs an owner. Make someone else an owner first.");
        }
      }
      let id = this.getMetadata().id;
      await Promise.all(recipients.map(({ accountId }) =>
        this.#library(accountId).addSharedCollection(id)));
      for (let { accountId, displayName } of recipients) this.#putGrant(accountId, role, displayName);
      let unrevoked = await this.#revokeUnauthorizedGitTokens();
      for (let { accountId } of recipients) this.#assertGitTokensRevoked(unrevoked, accountId);
    });
  }

  async setMemberRole(actorId: string, memberId: string, role: ContextCollectionRole): Promise<void> {
    await this.#serializeAccessChange(async () => {
      if (!this.storage.grants.get(memberId)) throw new Error("That person no longer has access.");
      this.#authorizeGrantChange(actorId, memberId, role);
      this.#putGrant(memberId, role);
      // On every change, so repeating a demotion retries a failed revocation.
      this.#assertGitTokensRevoked(await this.#revokeUnauthorizedGitTokens(), memberId);
    });
  }

  #putGrant(accountId: string, role: ContextCollectionRole, displayName?: string): void {
    let previous = this.storage.grants.get(accountId);
    this.storage.grants.put({
      accountId,
      role,
      displayName: displayName ?? previous?.displayName,
      grantedAt: previous?.grantedAt ?? new Date(),
    });
  }

  /** Remove a member; an account removing itself leaves the collection. */
  async removeMember(actorId: string, memberId: string): Promise<void> {
    await this.#serializeAccessChange(async () => {
      this.#authorizeGrantChange(actorId, memberId, null);
      if (this.storage.grants.get(memberId)) {
        // Library cleanup can outlive this invocation; persist the alarm before removing access.
        if (this.getMetadata().content.source === "git" || [...this.storage.grants.list()].length === 1) {
          await this.#armAccessCleanup();
        }
        this.storage.grants.delete(memberId);
        try {
          await this.#library(memberId).forgetCollection(this.getMetadata().id);
        } catch (err) {
          // Harmless: listings drop an entry whose account holds no role here.
          logger.warn("failed to remove collection from a former member's library", {
            event: "collection.member.library.remove.failed", collectionId: this.getMetadata().id,
            error: err,
          });
        }
      }
      // Also when the grant was already gone, so repeating a removal retries a failed revocation.
      let unrevoked = await this.#revokeUnauthorizedGitTokens();
      if (await this.#deleteIfMemberless()) return;
      this.#assertGitTokensRevoked(unrevoked, memberId);
    });
  }

  /**
   * The account was disconnected: drop its grant. Its library is wiped separately. A collection
   * left with no grants is deleted; one still shared with others survives, without an owner if
   * this was the last.
   */
  async removeAccount(accountId: string): Promise<void> {
    await this.#serializeAccessChange(async () => {
      // A pending deletion already owns its retry alarm.
      if (this.storage.deletionPending.get()) return;
      this.#ensureGrants();
      if (this.storage.grants.get(accountId)) this.storage.grants.delete(accountId);
      // The alarm owns failed credential cleanup once the account is gone.
      await this.#revokeUnauthorizedGitTokens();
      try {
        await this.#deleteIfMemberless();
      } catch (err) {
        logger.warn("collection deletion will retry after account disconnection", {
          event: "collection.disconnect.delete.pending", collectionId: this.getMetadata().id,
          error: err,
        });
      }
    });
  }

  // A private collection with no grants is deleted, even if everyone can view it: nobody could
  // manage it any more. Deleting its repo also ends every token for it.
  async #deleteIfMemberless(): Promise<boolean> {
    let meta = this.getMetadata();
    if (!meta.id || meta.visibility !== "private" || [...this.storage.grants.list()].length > 0) {
      return false;
    }
    await this.#deleteSelf();
    return true;
  }

  async setEveryoneCanView(actorId: string, everyoneCanView: boolean): Promise<void> {
    let access = this.getAccess(actorId);
    if (!access.exists || access.role === null) throw new Error(NOT_FOUND);
    if (!collectionPermissions(access, false).canShare) {
      throw new Error("Only editors and owners can change who has access to this collection.");
    }
    this.storage.everyoneCanView.put(everyoneCanView);
  }

  #canEdit(accountId: string): boolean {
    return collectionPermissions(this.getAccess(accountId), false).canEdit;
  }

  // Grants and issuer records are the alarm's durable work list for revocation and memberless deletion.
  async #armAccessCleanup(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + GIT_TOKEN_REVOKE_RETRY_MS);
    }
  }

  /**
   * Revoke every git token whose issuer no longer has write access, so losing it is not merely
   * hidden. Tokens with no issuer record were minted before sharing existed, when only the creator
   * could mint, so they are the creator's. A failed revocation keeps the token's issuer record and
   * schedules an alarm to retry, whatever becomes of the grant meanwhile. Returns the issuers with
   * tokens still live.
   */
  async #revokeUnauthorizedGitTokens(): Promise<Set<string>> {
    let unrevoked = new Set<string>();
    let meta = this.getMetadata();
    // Public collections have no grants; admins' tokens are not tied to one.
    if (meta.visibility !== "private") return unrevoked;
    // Read the records before deleting from the same storage collection.
    let records = Array.from(this.storage.gitTokenIssuers.list());
    let revocable = records.filter(record => !this.#canEdit(record.accountId));
    let creator = this.storage.ownerAccountId.get();
    let sweepLegacyTokens = meta.content.source === "git" && !!creator && !this.#canEdit(creator)
      && !this.storage.legacyGitTokensSwept.get();

    if (revocable.length > 0 || sweepLegacyTokens) {
      // Rearm retries too, in case the runtime stops while an alarm's external call is pending.
      await this.#armAccessCleanup();
      let repo: ArtifactsRepo | undefined;
      try {
        repo = await this.#artifacts().get(meta.id);
        if (sweepLegacyTokens) {
          let recorded = new Set(records.map(record => record.tokenId));
          let legacy = (await repo.listTokens()).tokens
            .filter(token => token.scope === "write" && token.state === "active" && !recorded.has(token.id))
            .map(token => ({ tokenId: token.id, accountId: creator }));
          // Make the sweep's work durable before revoking; a restart resumes from issuer records.
          this.storage.transaction(() => {
            for (let record of legacy) this.storage.gitTokenIssuers.put(record);
            this.storage.legacyGitTokensSwept.put(true);
          });
          revocable.push(...legacy);
        }
      } catch (err) {
        if (sweepLegacyTokens) unrevoked.add(creator);
        logger.error("failed to list git tokens to revoke", {
          event: "artifacts.issuer.token.list.failed", collectionId: meta.id, error: err,
        });
      }
      for (let record of revocable) {
        try {
          if (!repo) throw new Error("Artifacts repo unavailable.");
          await repo.revokeToken(record.tokenId);
          this.storage.gitTokenIssuers.delete(record.tokenId);
        } catch (err) {
          unrevoked.add(record.accountId);
          logger.error("failed to revoke a git token after its issuer lost write access", {
            event: "artifacts.issuer.token.revoke.failed", collectionId: meta.id, error: err,
          });
        }
      }
    }

    let attempts = this.storage.gitTokenRevokeAttempts.get();
    if (unrevoked.size === 0) {
      if (attempts > 0) this.storage.gitTokenRevokeAttempts.put(0);
    } else {
      this.storage.gitTokenRevokeAttempts.put(attempts + 1);
      await this.ctx.storage.setAlarm(Date.now() + Math.min(
        GIT_TOKEN_REVOKE_RETRY_MS * 2 ** attempts, GIT_TOKEN_REVOKE_RETRY_MAX_MS));
    }
    return unrevoked;
  }

  #assertGitTokensRevoked(unrevoked: Set<string>, accountId: string): void {
    if (unrevoked.has(accountId)) {
      throw new Error("Access was changed, but Git tokens this person created could not be "
        + "revoked yet. Revocation will be retried automatically.");
    }
  }

  /** Resumes credential cleanup and memberless deletion, including interrupted grant changes. */
  async alarm(): Promise<void> {
    await this.#serializeAccessChange(async () => {
      if (this.storage.deletionPending.get()) await this.#deleteSelf();
      else {
        let unrevoked = await this.#revokeUnauthorizedGitTokens();
        if (!await this.#deleteIfMemberless() && unrevoked.size === 0) {
          await this.ctx.storage.deleteAlarm();
        }
      }
    });
  }

  // Undefined for documents that are not text SKILL.md files. The error is one of
  // parseSkillManifest's fixed validation messages, never document content.
  #readAgentSkill(record: ContextRecord): AgentSkillParse | undefined {
    if (!isSkillManifestPath(record.path) ||
        !isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE)) {
      return undefined;
    }
    try {
      return {
        manifest: parseSkillManifest(
          record.path,
          decodeStoredContextBody(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE, record.body),
        ),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Skill manifest is invalid." };
    }
  }

  #parseAgentSkill(record: ContextRecord): SkillManifestMetadata | undefined {
    let parsed = this.#readAgentSkill(record);
    return parsed && "manifest" in parsed ? parsed.manifest : undefined;
  }

  // Update the skill entry after saving a document.
  #updateSkillIndex(record: ContextRecord): AgentSkillParse | undefined {
    let skill = this.#readAgentSkill(record);
    if (skill && "manifest" in skill) {
      this.storage.skillIndex.put({
        path: record.path,
        skillName: skill.manifest.name,
        description: skill.manifest.description,
      });
    } else {
      this.storage.skillIndex.delete(record.path);
    }
    return skill;
  }

  // Save a document and update its skill entry together.
  #putDocument(record: ContextRecord): AgentSkillParse | undefined {
    this.storage.documents.put(record);
    return this.#updateSkillIndex(record);
  }

  // Delete a document and its skill entry together.
  #deleteDocument(path: string): void {
    this.storage.documents.delete(path);
    this.storage.skillIndex.delete(path);
  }

  #clearSkillIndex(): void {
    // Read the entries before deleting from the same storage collection.
    for (let entry of Array.from(this.storage.skillIndex.list())) {
      this.storage.skillIndex.delete(entry.path);
    }
  }

  // Build the index for collections created before it existed.
  #ensureSkillIndex(): void {
    if (this.storage.skillIndexVersion.get() === SKILL_INDEX_VERSION) return;

    let entries: SkillIndexEntry[] = [];
    for (let record of this.storage.documents.list()) {
      let manifest = this.#parseAgentSkill(record);
      if (manifest) {
        entries.push({
          path: record.path,
          skillName: manifest.name,
          description: manifest.description,
        });
      }
    }

    this.storage.transaction(() => {
      this.#clearSkillIndex();
      for (let entry of entries) {
        this.storage.skillIndex.put(entry);
      }
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  listAgentSkills(): SkillIndexEntry[] {
    if (this.storage.deletionPending.get()) return [];
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    this.#ensureSkillIndex();
    return [...this.storage.skillIndex.list()];
  }

  async updateMetadata(options: {
    title?: string;
    description?: string;
    icon?: string;
    branch?: string;
  }): Promise<void> {
    let meta = this.getMetadata();
    let changed = false;

    if (options.title !== undefined && options.title !== meta.title) { meta.title = options.title; changed = true; }
    if (options.description !== undefined && options.description !== meta.description) { meta.description = options.description; changed = true; }
    if (options.icon !== undefined && options.icon !== meta.icon) { meta.icon = options.icon; changed = true; }
    if (options.branch !== undefined) {
      if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
      let branch = options.branch.trim();
      if (!GIT_BRANCH_RE.test(branch)) throw new Error("Git branch is invalid.");
      if (branch !== meta.content.branch) {
        meta.content.branch = branch;
        delete meta.content.commit;
        changed = true;
      }
    }

    if (changed) {
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      await this.#propagate();
    }
  }

  // --- Document CRUD ---

  #assertWebWritable(): void {
    if (this.#isGitBased()) {
      throw new Error("Git-based collections are read-only. All changes must be made through git.");
    }
  }

  async listContextDocuments(prefix?: string): Promise<ContextDocumentSummary[]> {
    if (this.storage.deletionPending.get()) return [];
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    let options = prefix ? { prefix } : undefined;
    let result: ContextDocumentSummary[] = [];
    for (let record of this.storage.documents.list(options)) {
      let skill = this.#readAgentSkill(record);
      let manifest = skill && "manifest" in skill ? skill.manifest : undefined;
      result.push({
        path: record.path,
        name: record.name,
        description: manifest?.description ?? record.description,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        ...(manifest ? {skillName: manifest.name} : {}),
        ...(skill && "error" in skill ? {skillError: skill.error} : {}),
        lastUpdated: record.lastUpdated,
      });
    }
    return result;
  }

  /** Lenient read: bad/missing paths return null, not RPC errors. Mutations validate paths. */
  async getContextDocument(path: string): Promise<ContextDocument | null> {
    if (this.storage.deletionPending.get()) return null;
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let record = this.storage.documents.get(path);
    if (!record) return null;
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    let manifest = this.#parseAgentSkill(record);
    return {
      path: record.path,
      name: record.name,
      description: manifest?.description ?? record.description,
      contentType,
      body: decodeStoredContextBody(contentType, record.body),
      ...(manifest ? {skillName: manifest.name} : {}),
      lastUpdated: record.lastUpdated,
    };
  }

  async #writeContextDocument(
      path: string,
      doc: { description: string; body: string; contentType?: string },
      createOnly: boolean): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(path);
    let contentType = doc.contentType || contentTypeFromPath(path);
    let record = contextRecord({
      path, name: baseName(path), description: doc.description, contentType, body: doc.body,
      lastUpdated: new Date(),
    });
    this.#assertRecordSize(record);

    this.storage.transaction(() => {
      let existing = this.storage.documents.get(path);
      if (createOnly && existing) throw new Error(`Document already exists: ${path}`);
      let isNew = !existing;
      // Use the file name from the path as the display name.
      this.#putDocument(record);

      let meta = this.getMetadata();
      if (isNew) meta.documentCount++;
      meta.lastUpdated = record.lastUpdated;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async putContextDocument(
      path: string,
      doc: { description: string; body: string; contentType?: string }): Promise<void> {
    await this.#writeContextDocument(path, doc, false);
  }

  async createContextSkill(
      path: string,
      doc: { description: string; body: string; contentType?: string }): Promise<void> {
    if (!isSkillManifestPath(path)) throw new Error("Skill manifest filename must be SKILL.md.");
    parseSkillManifest(path, doc.body);
    let directory = dirName(path);
    let directoryOccupied = !!(directory && this.storage.documents.get(directory));
    if (directory && !directoryOccupied) {
      for (let record of this.storage.documents.list({ prefix: directory + "/" })) {
        directoryOccupied = record.path.length > 0;
        break;
      }
    }
    if (directoryOccupied) {
      throw new Error(`Skill directory already exists: ${directory}`);
    }
    let parentDirectory = dirName(directory);
    if (parentDirectory) {
      let parentExists = false;
      for (let record of this.storage.documents.list({ prefix: parentDirectory + "/" })) {
        parentExists = record.path.length > 0;
        break;
      }
      if (!parentExists) throw new Error(`Directory not found: ${parentDirectory}`);
      let ancestor = parentDirectory;
      while (ancestor) {
        if (this.storage.documents.get(joinPath(ancestor, "SKILL.md"))) {
          throw new Error("Cannot create a skill inside another skill.");
        }
        ancestor = dirName(ancestor);
      }
    }
    await this.#writeContextDocument(path, doc, true);
  }

  async deleteContextDocument(path: string): Promise<void> {
    this.#assertWebWritable();
    // Mutations reject invalid paths; reads stay lenient.
    validateDocumentPath(path);
    let existing = this.storage.documents.get(path);
    if (!existing) throw new Error(`Document not found: ${path}`);

    this.storage.transaction(() => {
      this.#deleteDocument(path);

      let meta = this.getMetadata();
      meta.documentCount = Math.max(0, meta.documentCount - 1);
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async deleteContextDocumentTree(path: string): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(path);
    let paths = [...this.storage.documents.list({ prefix: path + "/" })]
      .map(record => record.path);
    if (this.storage.documents.get(path)) paths.unshift(path);
    if (paths.length === 0) throw new Error(`Document not found: ${path}`);

    await this.#deleteContextDocuments(paths);
  }

  async deleteContextSkill(manifestPath: string): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(manifestPath);
    if (!isSkillManifestPath(manifestPath)) throw new Error("Skill manifest filename must be SKILL.md.");
    let manifest = this.storage.documents.get(manifestPath);
    if (!manifest) throw new Error(`Document not found: ${manifestPath}`);

    let directory = dirName(manifestPath);
    let paths = directory
      ? [...this.storage.documents.list({ prefix: directory + "/" })].map(record => record.path)
      : [manifestPath];
    if (!paths.includes(manifestPath)) throw new Error(`Document not found: ${manifestPath}`);
    await this.#deleteContextDocuments(paths);
  }

  async #deleteContextDocuments(paths: string[]): Promise<void> {
    this.storage.transaction(() => {
      for (let documentPath of paths) this.#deleteDocument(documentPath);

      let meta = this.getMetadata();
      meta.documentCount = Math.max(0, meta.documentCount - paths.length);
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async #moveContextDocuments(
      from: string,
      to: string,
      transform?: (record: ContextRecord, newPath: string) => Partial<ContextRecord>): Promise<void> {
    // Reject moving a folder into one of its own descendants.
    if (to.startsWith(from + "/")) {
      throw new Error("Cannot move a folder into itself.");
    }

    let moves: { record: ContextRecord; newPath: string }[] = [];
    let exact = this.storage.documents.get(from);
    if (exact) {
      moves.push({ record: exact, newPath: to });
    } else {
      let fromPrefix = from.endsWith("/") ? from : from + "/";
      let toPrefix = to.endsWith("/") ? to : to + "/";
      for (let record of this.storage.documents.list({ prefix: fromPrefix })) {
        moves.push({ record, newPath: toPrefix + record.path.slice(fromPrefix.length) });
      }
    }

    if (moves.length === 0) throw new Error(`Nothing to move at: ${from}`);

    let movedFrom = new Set(moves.map(m => m.record.path));
    for (let m of moves) {
      if (!movedFrom.has(m.newPath) && this.storage.documents.get(m.newPath)) {
        throw new Error(`Destination already exists: ${m.newPath}`);
      }
    }

    await this.#applyDocumentMoves(moves, transform);
  }

  async #applyDocumentMoves(
      moves: { record: ContextRecord; newPath: string }[],
      transform?: (record: ContextRecord, newPath: string) => Partial<ContextRecord>): Promise<void> {
    this.storage.transaction(() => {
      for (let m of moves) this.#deleteDocument(m.record.path);
      for (let m of moves) {
        let contentType = extOf(m.record.path) !== extOf(m.newPath)
          ? contentTypeFromPath(m.newPath)
          : m.record.contentType;
        let record: ContextRecord = {
          ...m.record,
          path: m.newPath,
          name: baseName(m.newPath),
          contentType,
          lastUpdated: new Date(),
          ...transform?.(m.record, m.newPath),
        };
        this.#putDocument(record);
      }

      let meta = this.getMetadata();
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async #moveContextSkill(
      manifestPath: string,
      destinationDirectory: string,
      updatedBody?: string): Promise<void> {
    let manifest = this.storage.documents.get(manifestPath);
    if (!manifest) throw new Error(`Document not found: ${manifestPath}`);
    let sourceDirectory = dirName(manifestPath);
    let moves: { record: ContextRecord; newPath: string }[] = [];
    if (sourceDirectory) {
      let sourcePrefix = sourceDirectory + "/";
      let destinationPrefix = destinationDirectory + "/";
      for (let record of this.storage.documents.list({ prefix: sourcePrefix })) {
        moves.push({
          record,
          newPath: destinationPrefix + record.path.slice(sourcePrefix.length),
        });
      }
    } else {
      moves.push({ record: manifest, newPath: joinPath(destinationDirectory, "SKILL.md") });
    }
    if (!moves.some(move => move.record.path === manifestPath)) {
      throw new Error(`Document not found: ${manifestPath}`);
    }

    for (let move of moves) {
      validateDocumentPath(move.newPath);
    }

    if (updatedBody !== undefined) {
      let manifestMove = moves.find(move => move.record.path === manifestPath);
      if (manifestMove) {
        let updatedRecord: ContextRecord = {
          ...manifestMove.record,
          path: manifestMove.newPath,
          name: baseName(manifestMove.newPath),
          body: encodeStoredContextBody(manifestMove.record.contentType, updatedBody),
          lastUpdated: new Date(),
        };
        this.#assertRecordSize(updatedRecord);
      }
    }

    let movedFrom = new Set(moves.map(move => move.record.path));
    let occupied = this.storage.documents.get(destinationDirectory);
    if (occupied && !movedFrom.has(occupied.path)) {
      throw new Error(`Destination already exists: ${destinationDirectory}`);
    }
    for (let record of this.storage.documents.list({ prefix: destinationDirectory + "/" })) {
      if (!movedFrom.has(record.path)) {
        throw new Error(`Destination already exists: ${destinationDirectory}`);
      }
    }

    await this.#applyDocumentMoves(moves, (record) =>
      updatedBody !== undefined && record.path === manifestPath
        ? { body: encodeStoredContextBody(record.contentType, updatedBody) }
        : {});
  }

  async moveContextDocument(from: string, to: string): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(from);
    validateDocumentPath(to);
    if (from === to) return;

    await this.#moveContextDocuments(from, to);
  }

  async moveContextSkill(manifestPath: string, directoryPath: string): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(manifestPath);
    if (directoryPath) validateDocumentPath(directoryPath);
    if (!isSkillManifestPath(manifestPath)) throw new Error("Skill manifest filename must be SKILL.md.");

    let manifest = this.storage.documents.get(manifestPath);
    if (!manifest) throw new Error(`Document not found: ${manifestPath}`);
    let body = decodeStoredContextBody(manifest.contentType, manifest.body);
    let skill = parseSkillManifest(manifestPath, body);
    let sourceDirectory = dirName(manifestPath);
    let currentParent = dirName(sourceDirectory);
    if (currentParent === directoryPath) return;
    if (sourceDirectory && (
      directoryPath === sourceDirectory
      || directoryPath.startsWith(sourceDirectory + "/")
    )) {
      throw new Error("Cannot move a skill into itself.");
    }
    if (directoryPath) {
      let targetExists = false;
      for (let record of this.storage.documents.list({ prefix: directoryPath + "/" })) {
        targetExists = record.path.length > 0;
        break;
      }
      if (!targetExists) throw new Error(`Directory not found: ${directoryPath}`);
      let ancestor = directoryPath;
      while (ancestor) {
        if (this.storage.documents.get(joinPath(ancestor, "SKILL.md"))) {
          throw new Error("Cannot move a skill inside another skill.");
        }
        ancestor = dirName(ancestor);
      }
    }
    let destinationDirectory = joinPath(
      directoryPath,
      sourceDirectory ? baseName(sourceDirectory) : skill.name,
    );
    validateDocumentPath(destinationDirectory);
    await this.#moveContextSkill(manifestPath, destinationDirectory);
  }

  async renameContextSkill(manifestPath: string, newName: string): Promise<void> {
    this.#assertWebWritable();
    validateDocumentPath(manifestPath);
    if (!isSkillManifestPath(manifestPath)) throw new Error("Skill manifest filename must be SKILL.md.");

    let manifest = this.storage.documents.get(manifestPath);
    if (!manifest) throw new Error(`Document not found: ${manifestPath}`);
    let body = decodeStoredContextBody(manifest.contentType, manifest.body);
    let updatedBody = updateSkillManifestName(body, newName);
    // Validate the rewritten manifest before mutating storage.
    parseSkillManifest(manifestPath, updatedBody);

    let sourceDirectory = dirName(manifestPath);
    let parentDirectory = dirName(sourceDirectory);
    let destinationDirectory = joinPath(parentDirectory, newName);
    validateDocumentPath(destinationDirectory);
    await this.#moveContextSkill(manifestPath, destinationDirectory, updatedBody);
  }

  // --- Artifact-backed projection ---

  async syncArtifactSource(): Promise<void> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    await this.#refreshArtifactSource();
  }

  /**
   * Mint a mirror write token, recording `issuerId` so losing write access revokes it. The issuer's
   * access is checked among the grant changes, so a removal either precedes the mint and refuses it,
   * or follows it and finds the token recorded.
   */
  async createGitToken(issuerId: string): Promise<ContextGitTokenCreateResult> {
    return this.#serializeAccessChange(async () => {
      let meta = this.getMetadata();
      // A deletion in progress has not yet removed the repo, but its tokens would not outlive it.
      if (!this.getAccess(issuerId).exists) throw new Error(NOT_FOUND);
      if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
      // Public collections are checked by the caller, which knows whether the issuer is an admin.
      if (meta.visibility === "private" && !this.#canEdit(issuerId)) {
        throw new Error("Only editors and owners can create Git tokens.");
      }
      let repo = await this.#artifacts().get(meta.id);
      let token = await repo.createToken("write", GIT_TOKEN_TTL_SECONDS);
      this.storage.gitTokenIssuers.put({ tokenId: token.id, accountId: issuerId });
      return {
        id: token.id,
        plaintext: token.plaintext,
        remote: meta.content.remote,
      };
    });
  }

  async listGitTokens(): Promise<ContextGitTokenList> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.getMetadata();
    let repo = await this.#artifacts().get(meta.id);
    let result = await repo.listTokens();
    return {
      tokens: result.tokens
        // User-created tokens for mirror setup are always write tokens. This DO
        // mints its own read tokens for cloning the repo into memory which we
        // don't want to expose the user.
        .filter(token => token.scope === "write" && token.state === "active")
        .map(token => ({
          id: token.id,
          expiresAt: token.expiresAt,
        })),
    };
  }

  async revokeGitToken(tokenId: string): Promise<boolean> {
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.getMetadata();
    let repo = await this.#artifacts().get(meta.id);
    let revoked = await repo.revokeToken(tokenId);
    this.storage.gitTokenIssuers.delete(tokenId);
    return revoked;
  }

  #isGitBased(): boolean {
    return this.getMetadata().content.source === "git";
  }

  #startBackgroundArtifactRefresh(): void {
    if (!this.env.ARTIFACTS) return;
    let content = this.getMetadata().content;
    if (content.source !== "git") return;
    if (Date.now() - content.lastRefreshedAt.getTime() < GIT_REFRESH_MIN_INTERVAL_MS) return;

    void this.#refreshArtifactSource().catch((err) => {
      logger.warn("failed to refresh git-based context collection in the background", {
        event: "context.collection.git.refresh.failed",
        collectionId: this.getMetadata().id,
        error: err,
      });
    });
  }

  #refreshArtifactSource(): Promise<void> {
    if (this.#artifactRefresh) return this.#artifactRefresh;

    let promise = this.#loadArtifactSnapshot().finally(() => {
      if (this.#artifactRefresh === promise) this.#artifactRefresh = undefined;
    });
    this.#artifactRefresh = promise;
    return promise;
  }

  #replaceArtifactDocuments(commit: string, documents: ArtifactContextDocument[]): void {
    let invalidSkills: Array<{ filepath: string; reason: string }> = [];
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();
      for (let doc of documents) {
        let skill = this.#putDocument(doc);
        if (skill && "error" in skill) invalidSkills.push({ filepath: doc.path, reason: skill.error });
      }

      let meta = this.getMetadata();
      meta.documentCount = documents.length;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
    if (invalidSkills.length > 0) {
      // Git pushes bypass createContextSkill's validation, so a broken manifest would otherwise
      // only surface as a missing skill. One bounded line per sync, not one per manifest.
      logger.warn("git-based context collection has invalid skill manifests", {
        event: "context.skill.manifest.invalid",
        collectionId: this.getMetadata().id,
        commit,
        invalidSkillManifestCount: invalidSkills.length,
        invalidSkillManifests: invalidSkills.slice(0, MAX_LOGGED_INVALID_SKILLS),
      });
    }
  }

  #deleteArtifactDocuments(commit: string): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();

      let meta = this.getMetadata();
      meta.documentCount = 0;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  async #loadArtifactSnapshot(): Promise<void> {
    const meta = this.getMetadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    const result = await readArtifactRepoDocuments(
        this.#artifacts(), meta.id, meta.content.remote, meta.content.branch, meta.content.commit);
    if (!result.changed) {
      // Nothing changed, just bump the refresh timestamp.
      const latestMeta = this.getMetadata();
      if (latestMeta.content.source !== "git") throw new Error("Collection is not git-based.");
      latestMeta.content = { ...latestMeta.content, lastRefreshedAt: new Date() };
      this.storage.metadata.put(latestMeta);
      return;
    }

    if (result.commit) {
      // The repo was updated to a new commit, stored documents need to be updated.
      this.#replaceArtifactDocuments(result.commit, result.documents);
    } else {
      // The repo was updated to an empty state.
      this.#deleteArtifactDocuments(result.commit);
    }
    await this.#propagate();
  }

  // --- Search ---

  /** Linear scan over one collection. Replace with an index if collection size makes it matter. */
  async search(query: string, limit: number = 20): Promise<{ path: string; name: string; description: string; snippet?: string; score: number }[]> {
    if (this.storage.deletionPending.get()) return [];
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];

    let results: { path: string; name: string; description: string; snippet?: string; score: number }[] = [];

    for (let record of this.storage.documents.list()) {
      let score = 0;
      let snippet: string | undefined;

      let isText = isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE);
      let nameLower = record.name.toLowerCase();
      let descLower = record.description.toLowerCase();
      let body = isText
        ? decodeStoredContextBody(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE, record.body)
        : "";
      let bodyLower = body.toLowerCase();

      for (let token of tokens) {
        if (nameLower.includes(token)) score += 10;
        if (descLower.includes(token)) score += 5;
        let bodyIdx = isText ? bodyLower.indexOf(token) : -1;
        if (bodyIdx >= 0) {
          score += 1;
          if (!snippet) {
            let start = Math.max(0, bodyIdx - 40);
            let end = Math.min(body.length, bodyIdx + token.length + 80);
            snippet = (start > 0 ? "..." : "") + body.slice(start, end) + (end < body.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({ path: record.path, name: record.name, description: record.description, snippet, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // --- Deletion ---

  /** Delete only if the actor may still do so when queued grant changes have finished. */
  deleteSelf(actorId: string, isAdmin: boolean): Promise<void> {
    return this.#serializeAccessChange(async () => {
      if (!collectionPermissions(this.getAccess(actorId), isAdmin).canDelete) throw new Error(NOT_FOUND);
      await this.#deleteSelf();
    });
  }

  async #deleteSelf(): Promise<void> {
    let meta = this.getMetadata();
    let id = meta.id;
    // Persist the intent and its retry before any external operation can fail. Never erase the
    // repo identity or issuer records while an external write credential could still be live.
    this.storage.deletionPending.put(true);
    let retryAt = Date.now() + GIT_TOKEN_REVOKE_RETRY_MS;
    let alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > retryAt) await this.ctx.storage.setAlarm(retryAt);

    if (id) {
      if (meta.visibility === "public") {
        await this.#registry().removePublic(this.#domain(), id);
      } else {
        await this.#library(this.storage.ownerAccountId.get()).removeOwnedCollection(id);
        // Best-effort: listings already drop entries for a deleted collection.
        await Promise.all([...this.storage.grants.list()].map(grant =>
          this.#library(grant.accountId).forgetCollection(id).catch((err) => {
            logger.warn("failed to remove deleted collection from a member's library", {
              event: "collection.delete.library.remove.failed", collectionId: id, error: err,
            });
          })));
      }
    }

    if (meta.content.source === "git" && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(id).catch((err) => {
        logger.warn("failed to delete Artifacts repo for context collection", {
          event: "artifacts.repo.delete.failed",
          collectionId: id,
          error: err,
        });
        throw err;
      });
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // --- Propagation ---

  // Refresh a public collection's denormalized summary in the domain registry. Private libraries
  // read metadata live from the collection, so they hold no copy to refresh.
  async #propagate(): Promise<void> {
    let meta = this.getMetadata();
    if (meta.visibility === "public") {
      await this.#registry().syncPublic(this.#domain(), metadataToSummary(meta));
    }
  }
}
