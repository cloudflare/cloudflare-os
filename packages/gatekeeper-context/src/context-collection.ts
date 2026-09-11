// One collection's metadata and documents. Metadata changes update the private owner library or the
// public domain registry.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary,
  ContextGitTokenCreateResult, ContextGitTokenList,
  DEFAULT_DOCUMENT_CONTENT_TYPE, DEFAULT_GIT_BRANCH, MAX_DOCUMENT_BODY_BYTES,
  contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import { metadataToSummary } from "./collection-kv.js";
import { domainName } from "./domain.js";
import {
  readArtifactRepoDocuments, type ArtifactContextDocument,
} from "./artifact-sync.js";
import {
  isSkillManifestPath, parseSkillManifest, updateSkillManifestName, type SkillIndexEntry,
} from "./agent-skill.js";
import { obsContext } from "./observability.js";
import {
  decodeStoredContextBody, encodeStoredContextBody, truncateContextDescription,
} from "./context-storage.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

const MAX_DOCUMENT_PATH_LENGTH = 1024;
// Git tokens created through the web UI are valid for one year,
// the maximum TTL supported by Artifacts.
const GIT_TOKEN_TTL_SECONDS = 31_536_000;
// Background git refresh happens minutely at most.
const GIT_REFRESH_MIN_INTERVAL_MS = 60_000;
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

// Old records that predate git-based collections won't have `content` set in storage.
// Unset `content` is defaulted to { "source": "web" } at the API layer, which is why
// we have different types for storage vs. API interface.
type StoredContextCollectionMetadata = Omit<ContextCollectionMetadata, "content"> & {
  content?: ContextCollectionContent;
};

function makeContextCollectionStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      documents: collection<ContextRecord>()({ primaryKey: "path" }),
      // Data needed to list skills without loading document bodies.
      skillIndex: collection<SkillIndexEntry>()({ primaryKey: "path" }),
    },
    singletons: {
      // Sharing domain for cross-DO references.
      sharingDomain: "",
      // Private owner account id; empty for public collections.
      ownerAccountId: "",
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

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeContextCollectionStorage(ctx.storage);
  }

  // Sharing domain for all cross-DO/KV references.
  #domain(): string {
    return this.storage.sharingDomain.get();
  }

  // The owner's UserLibraryDurableObject (private collections only), within this collection's domain.
  #ownerLibrary() {
    let ns = this.ctx.exports.UserLibraryDurableObject;
    return ns.get(ns.idFromName(domainName(this.#domain(), this.storage.ownerAccountId.get())));
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

  #parseAgentSkill(record: ContextRecord) {
    if (!isSkillManifestPath(record.path) ||
        !isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE)) {
      return undefined;
    }
    try {
      return parseSkillManifest(
        record.path,
        decodeStoredContextBody(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE, record.body),
      );
    } catch {
      return undefined;
    }
  }

  // Update the skill entry after saving a document.
  #updateSkillIndex(record: ContextRecord): void {
    let manifest = this.#parseAgentSkill(record);
    if (manifest) {
      this.storage.skillIndex.put({
        path: record.path,
        skillName: manifest.name,
        description: manifest.description,
      });
    } else {
      this.storage.skillIndex.delete(record.path);
    }
  }

  // Save a document and update its skill entry together.
  #putDocument(record: ContextRecord): void {
    this.storage.documents.put(record);
    this.#updateSkillIndex(record);
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
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    let options = prefix ? { prefix } : undefined;
    let result: ContextDocumentSummary[] = [];
    for (let record of this.storage.documents.list(options)) {
      let manifest = this.#parseAgentSkill(record);
      result.push({
        path: record.path,
        name: record.name,
        description: manifest?.description ?? record.description,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        ...(manifest ? {skillName: manifest.name} : {}),
        lastUpdated: record.lastUpdated,
      });
    }
    return result;
  }

  /** Lenient read: bad/missing paths return null, not RPC errors. Mutations validate paths. */
  async getContextDocument(path: string): Promise<ContextDocument | null> {
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
    let byteLength = record.body.byteLength + new TextEncoder().encode(
      JSON.stringify({ ...record, body: "" }),
    ).byteLength;
    if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(`Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }

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

  async createGitToken(): Promise<ContextGitTokenCreateResult> {
    let meta = this.getMetadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    let repo = await this.#artifacts().get(meta.id);
    let token = await repo.createToken("write", GIT_TOKEN_TTL_SECONDS);
    return {
      id: token.id,
      plaintext: token.plaintext,
      remote: meta.content.remote,
    };
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
    return repo.revokeToken(tokenId);
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
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();
      for (let doc of documents) {
        this.#putDocument(doc);
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

  async deleteSelf(): Promise<void> {
    let meta = this.getMetadata();
    let id = meta.id;

    if (id) {
      if (meta.visibility === "public") {
        await this.#registry().removePublic(this.#domain(), id);
      } else {
        await this.#ownerLibrary().removeOwnedCollection(id);
      }
    }

    if (meta.content.source === "git" && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(id).catch((err) => {
        logger.warn("failed to delete Artifacts repo for context collection", {
          event: "artifacts.repo.delete.failed",
          collectionId: id,
          error: err,
        });
      });
    }

    await this.ctx.storage.deleteAll();
  }

  /** Account revocation clears the whole user-library index separately; don't update it per item. */
  async deleteForRevokedOwner(): Promise<void> {
    let meta = this.getMetadata();
    if (meta.content.source === "git" && meta.id && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(meta.id).catch((err) => {
        logger.warn("failed to delete Artifacts repo while revoking context collection owner", {
          event: "artifacts.repo.delete.for.revoked.owner.failed",
          collectionId: meta.id,
          error: err,
        });
      });
    }
    await this.ctx.storage.deleteAll();
  }

  // --- Propagation ---

  // Refresh this collection's denormalized summary in its index.
  async #propagate(): Promise<void> {
    let meta = this.getMetadata();
    let summary = metadataToSummary(meta);

    if (meta.visibility === "public") {
      await this.#registry().syncPublic(this.#domain(), summary);
    } else {
      await this.#ownerLibrary().updateOwnedCollection(meta.id, summary);
    }
  }
}
