// Generated from packages/gatekeeper-context/src/context-types.ts (ContextApi, named by its package.json's cloudflareOs.appApi) by
// packages/api-schema/scripts/generate.ts -- do not edit.
// The app UI of the context gatekeeper: the `ui` of getGatekeeperApp("context").
// Change that file and run `pnpm api-schema:generate`.

/** Per-account management API exposed to the gatekeeper app iframe. */
export interface ContextApi {
  /**
   * Creates a collection this account owns. `description` is what agents read to decide whether it
   * is relevant; `icon` is an emoji. `source` is `"web"` (the default: its documents are written
   * through this API) or `"git"`, a Git repository reached with a token from
   * createContextCollectionGitToken(), where getViewerInfo() says the deployment supports it.
   */
  createContextCollection(title: Awaitable<string>, description: Awaitable<string>, visibility: Awaitable<ContextCollectionVisibility>, icon?: Awaitable<string>, source?: Awaitable<"git" | "web">): Promise<ContextCollectionMetadata>;
  createContextCollectionGitToken(collectionId: Awaitable<string>): Promise<ContextGitTokenCreateResult>;
  /**
   * Creates a skill, rejecting the operation if its directory is already occupied. `path` is the
   * skill's manifest, a file named SKILL.md in a new directory: `my-skill/SKILL.md`, or
   * `tools/my-skill/SKILL.md` in an existing directory that is not inside another skill.
   *
   * `doc.body` is the manifest's text. It starts with YAML frontmatter between two `---` lines,
   * holding `name` (at most 64 characters of lowercase letters, digits and single hyphens:
   * `my-skill`) and `description` (1 to 1024 characters: what the skill does and when to use it);
   * the instructions follow it. `doc.description` describes the document in listings, as for any
   * document. Supporting files go in the skill's directory, written with putContextDocument().
   */
  createContextSkill(collectionId: Awaitable<string>, path: Awaitable<string>, doc: Awaitable<{
    body: string;
    contentType?: string;
    description: string;
  }>): Promise<void>;
  deleteContextCollection(collectionId: Awaitable<string>): Promise<void>;
  deleteContextDocument(collectionId: Awaitable<string>, path: Awaitable<string>): Promise<void>;
  /** Atomically deletes a document path and every document below it. */
  deleteContextDocumentTree(collectionId: Awaitable<string>, path: Awaitable<string>): Promise<void>;
  /** Atomically deletes a skill and its supporting files. */
  deleteContextSkill(collectionId: Awaitable<string>, manifestPath: Awaitable<string>): Promise<void>;
  getContextCollectionMetadata(collectionId: Awaitable<string>): Promise<null | ContextCollectionMetadata>;
  /** What the viewer may do with a collection it can read. */
  getContextCollectionPermissions(collectionId: Awaitable<string>): Promise<ContextCollectionPermissions>;
  /** Members and everyone-viewability of a collection the viewer can read. */
  getContextCollectionSharing(collectionId: Awaitable<string>): Promise<ContextCollectionSharing>;
  getContextDocument(collectionId: Awaitable<string>, path: Awaitable<string>): Promise<null | ContextDocument>;
  /** Gates creating/editing public collections and offering Git-backed collections. */
  getViewerInfo(): Promise<{
    isAdmin: boolean;
    supportsGitCollections: boolean;
  }>;
  /** Give up the viewer's own role, whatever it is; the last owner cannot leave. */
  leaveContextCollection(collectionId: Awaitable<string>): Promise<void>;
  listContextCollectionGitTokens(collectionId: Awaitable<string>): Promise<ContextGitTokenList>;
  listContextDocuments(collectionId: Awaitable<string>, prefix?: Awaitable<string>): Promise<ContextDocumentSummary[]>;
  /** Collections this account holds a role on, plus every public one. */
  listEnabledContextCollections(): Promise<EnabledCollectionInfo[]>;
  moveContextDocument(collectionId: Awaitable<string>, fromPath: Awaitable<string>, toPath: Awaitable<string>): Promise<void>;
  /** Atomically moves a skill and its supporting files within its collection. */
  moveContextSkill(collectionId: Awaitable<string>, manifestPath: Awaitable<string>, directoryPath: Awaitable<string>): Promise<void>;
  /** The document's display name is always derived from its path (the file name), so it's not passed. */
  putContextDocument(collectionId: Awaitable<string>, path: Awaitable<string>, doc: Awaitable<{
    body: string;
    contentType?: string;
    description: string;
  }>): Promise<void>;
  /** Remove a member; removing the viewer's own membership leaves the collection. */
  removeContextCollectionMember(collectionId: Awaitable<string>, memberId: Awaitable<string>): Promise<void>;
  /** Atomically renames a skill directory and its manifest name. */
  renameContextSkill(collectionId: Awaitable<string>, manifestPath: Awaitable<string>, newName: Awaitable<string>): Promise<void>;
  revokeContextCollectionGitToken(collectionId: Awaitable<string>, tokenId: Awaitable<string>): Promise<boolean>;
  setContextCollectionEveryoneCanView(collectionId: Awaitable<string>, everyoneCanView: Awaitable<boolean>): Promise<void>;
  setContextCollectionMemberRole(collectionId: Awaitable<string>, memberId: Awaitable<string>, role: Awaitable<ContextCollectionRole>): Promise<void>;
  /**
   * Share with the person a Workshop user-picker ticket names. Resolves once the share is durable;
   * rejects with a message meant for display beside that person.
   */
  shareContextCollection(collectionId: Awaitable<string>, ticket: Awaitable<string>, role: Awaitable<ContextCollectionRole>): Promise<void>;
  syncContextCollectionArtifactSource(collectionId: Awaitable<string>): Promise<void>;
  updateContextCollection(collectionId: Awaitable<string>, options: Awaitable<{
    branch?: string;
    description?: string;
    icon?: string;
    title?: string;
  }>): Promise<void>;
  /** Disposes of this stub, releasing the capability it holds. */
  [Symbol.dispose](): void;
}

export type ContextCollectionContent = {
  branch: string;
  commit?: string;
  lastRefreshedAt: Date;
  remote: string;
  source: "git";
} | {
  source: "web";
};

/** One account holding a role on a private collection. */
export type ContextCollectionMember = {
  /**
   * The Workshop display name snapshotted when they were added. Absent for the account that
   * created the collection before sharing existed. Presentation only.
   */
  displayName?: string;
  /** Whether this member is the viewing account. */
  isViewer: boolean;
  /** Opaque member identifier, passed back to change or remove this member's role. */
  memberId: string;
  role: ContextCollectionRole;
};

export type ContextCollectionMetadata = {
  content: ContextCollectionContent;
  created: Date;
  /** Listed and used by agents to decide relevance. */
  description: string;
  /** Number of documents in this collection. */
  documentCount: number;
  /** Optional emoji icon. */
  icon?: string;
  /** Random hex ID. */
  id: string;
  lastUpdated: Date;
  /** Human-readable title. */
  title: string;
  visibility: ContextCollectionVisibility;
};

/** What the viewing account may do with one collection. */
export type ContextCollectionPermissions = {
  /** Delete the whole collection. */
  canDelete: boolean;
  /**
   * Edit web-managed content and collection details, and manage git mirroring. On a private
   * collection, also share it as viewer or editor and toggle everyone-viewable.
   */
  canEdit: boolean;
  /** Grant `owner`, and demote or remove owners. */
  canManageOwners: boolean;
  /** Open the Share dialog: an editable private collection. */
  canShare: boolean;
};

/**
 * An account's role on a private collection. Every role reads all of its content; see
 * ContextCollectionPermissions for what each may change.
 */
export type ContextCollectionRole = "editor" | "owner" | "viewer";

/** A private collection's sharing state. */
export type ContextCollectionSharing = {
  /** Every account in the sharing domain may read it, without it appearing in their library. */
  everyoneCanView: boolean;
  /** False once the last owner's account was disconnected while others still held access. */
  hasOwner: boolean;
  members: ContextCollectionMember[];
};

/**
 * Collection visibility within a sharing domain, which says who can read a collection: `private`,
 * its members (see ContextApi.shareContextCollection()), or every account in the domain when its
 * `everyoneCanView` is set (see ContextApi.setContextCollectionEveryoneCanView()); or `public`,
 * everyone, which only deployment admins may create or edit.
 */
export type ContextCollectionVisibility = "private" | "public";

/** Stored document. Text bodies are literal text; binary bodies are base64 without a data: prefix. */
export type ContextDocument = {
  /** Literal text for text content types; base64 for binary ones. */
  body: string;
  /** Determines whether `body` is text or base64. */
  contentType: string;
  /** What this document covers and when to use it. Values over 16,000 characters are truncated. */
  description: string;
  lastUpdated: Date;
  /** File name derived from the path. */
  name: string;
  /** Primary key within the collection, using "/" separators. */
  path: string;
  /** Set when this document is a valid skill. */
  skillName?: string;
};

/** Document info without body. */
export type ContextDocumentSummary = {
  contentType: string;
  description: string;
  lastUpdated: Date;
  name: string;
  path: string;
  /** Set when this document is a SKILL.md whose frontmatter fails validation; says why. */
  skillError?: string;
  /** Set when this document is a valid skill. */
  skillName?: string;
};

export type ContextGitTokenCreateResult = {
  id: string;
  plaintext: string;
  remote: string;
};

export type ContextGitTokenInfo = {
  expiresAt: string;
  id: string;
};

export type ContextGitTokenList = {
  tokens: ContextGitTokenInfo[];
};

/** Collections in an account's library: those it holds a role on, plus every public one. */
export type EnabledCollectionInfo = {
  description: string;
  icon?: string;
  id: string;
  lastUpdated: Date;
  /** Private collections only: this account's role, and whether anyone else can read it. */
  membership?: {
    role: ContextCollectionRole;
    shared: boolean;
  };
  source: "private" | "public";
  title: string;
};

/**
 * A value, or a promise of it. What a call accepts for a value parameter: Cap'n Web resolves a
 * promise argument before delivering the call, so one call's result is passed to the next without
 * waiting for it, `root.set(root.get())`. And what a function or a method the caller
 * implements may return: its result as is, or from an `async` function.
 */
export type Awaitable<T> = T | Promise<T>;
