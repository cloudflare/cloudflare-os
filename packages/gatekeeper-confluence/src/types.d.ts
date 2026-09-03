/**
 * Confluence (Cloud) gatekeeper Session API.
 *
 * Confluence organizes content into **sites**, **spaces**, and **content**. A site is a single
 * Confluence Cloud instance (e.g. `https://acme.atlassian.net/wiki`). A space is a container of
 * content (a team area, project, personal space, etc.). Content is a **page** or **blog post**:
 * each has a title, a rich-text **body**, optional **labels**, **comments**, and **attachments**.
 * Pages also form a tree (a page can have child pages); blog posts do not.
 *
 * To keep the API approachable, page/blog bodies are exchanged as **Markdown** rather than
 * Confluence's native "storage format" (an XHTML dialect). The conversion is best-effort: common
 * constructs (headings, emphasis, links, lists, task lists, code blocks, quotes, tables, rules,
 * and info/note/warning panels) round-trip, but Confluence macros, embedded media, and complex
 * layouts degrade to a best-effort text rendering. Do not rely on byte-for-byte fidelity.
 *
 * Three resource granularities are offered, each with its own Session type:
 *  - {@link ConfluenceSite} — a whole Confluence site: search, browse spaces, open any content.
 *  - {@link ConfluenceSpace} — a single space: list/create pages and blog posts within it.
 *  - {@link ConfluenceContent} — a single page or blog post (and, for pages, its child pages).
 */

// ---------------------------------------------------------------------------------------------
// Sessions

/**
 * A whole Confluence site (one Cloud instance). Use this when an agent should be able to roam the
 * site; grant a single {@link ConfluenceSpace} or {@link ConfluenceContent} instead to limit reach.
 */
export interface ConfluenceSite {
  /** Basic info about the connected site (name, base URL, cloud ID). */
  getMetadata(): Promise<SiteMetadata>;

  /**
   * Lists the spaces on the site. Results stream through the returned cursor; call `next()` until
   * it returns `null`.
   */
  listSpaces(options?: ListSpacesOptions): Promise<Cursor<SpaceSummary>>;

  /** Opens a specific space by its key (e.g. `"ENG"`), numeric ID, or Confluence URL. */
  getSpace(keyOrIdOrUrl: string): Promise<ConfluenceSpace>;

  /**
   * Opens a specific page or blog post by its numeric content ID or Confluence URL. Throws if the
   * content isn't visible to this connection.
   */
  getContent(idOrUrl: string): Promise<ConfluenceContent>;

  /**
   * Searches the site's content. Pass `text` for a simple title/body text search, or `cql` for a
   * raw [CQL](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/)
   * query (the two are mutually exclusive; `cql` wins if both are given). Results stream through
   * the returned cursor.
   */
  search(options?: SearchOptions): Promise<Cursor<ContentSummary>>;

  /** Returns the non-email profile fields of the user who authorized this connection. */
  getCurrentUser(): Promise<ConfluenceUser>;
}

/**
 * A single Confluence space: a container of pages and blog posts sharing a {@link SpaceMetadata}.
 */
export interface ConfluenceSpace {
  /** Returns space metadata: key, name, type, description, and homepage ID. */
  getMetadata(): Promise<SpaceMetadata>;

  /**
   * Lists the pages in this space. By default lists top-level pages (those directly under the
   * space, with no page parent); pass `{ depth: "all" }` to list every page in the space. Results
   * stream through the returned cursor.
   */
  listPages(options?: ListPagesOptions): Promise<Cursor<ContentSummary>>;

  /** Lists the blog posts in this space. Results stream through the returned cursor. */
  listBlogPosts(options?: ListOptions): Promise<Cursor<ContentSummary>>;

  /**
   * Opens a specific page or blog post in this space by content ID or URL. Throws if the content
   * is not part of this space.
   */
  getContent(idOrUrl: string): Promise<ConfluenceContent>;

  /** Searches content within this space (see {@link ConfluenceSite.search}). */
  search(options?: SearchOptions): Promise<Cursor<ContentSummary>>;

  /**
   * Creates a new page in this space. Provide a `parentId` to nest it under an existing page;
   * otherwise it is created at the top level of the space. Body content is Markdown (see the
   * module docs for conversion notes).
   */
  createPage(options: CreatePageOptions): Promise<ConfluenceContent>;

  /** Creates a new blog post in this space. Body content is Markdown. */
  createBlogPost(options: CreateBlogPostOptions): Promise<ConfluenceContent>;
}

/**
 * A single piece of Confluence content: a **page** or a **blog post** (distinguished by
 * {@link ContentMetadata.type}).
 *
 * Page-tree methods ({@link listChildPages}, {@link createChildPage}) are only meaningful for
 * pages; on a blog post they throw or return an empty result, as noted on each method.
 */
export interface ConfluenceContent {
  /**
   * Returns content metadata: ID, type, title, space key, URL, status, current version number,
   * parent (for pages), author, and timestamps.
   */
  getMetadata(): Promise<ContentMetadata>;

  /** Returns the body converted to Markdown (best-effort; see the module docs). */
  getContent(): Promise<string>;

  /**
   * Replaces the entire body with the given Markdown, creating a new version. Use
   * {@link appendContent} to add to the existing body instead.
   */
  setContent(markdown: string): Promise<void>;

  /** Appends Markdown to the end of the existing body, creating a new version. */
  appendContent(markdown: string): Promise<void>;

  /** Changes the title, creating a new version. */
  setTitle(title: string): Promise<void>;

  /**
   * Lists this page's direct child pages. Empty for a blog post. Results stream through the
   * returned cursor.
   */
  listChildPages(options?: ListOptions): Promise<Cursor<ContentSummary>>;

  /** Creates a new page nested under this page. Throws if this content is a blog post. */
  createChildPage(options: CreateChildPageOptions): Promise<ConfluenceContent>;

  /** Returns the labels attached to this content. */
  listLabels(): Promise<string[]>;

  /** Adds a label to this content. No-op if the label is already present. */
  addLabel(name: string): Promise<void>;

  /** Removes a label from this content. No-op if the label is absent. */
  removeLabel(name: string): Promise<void>;

  /** Reads the footer comment thread on this content. Results stream through the returned cursor. */
  listComments(options?: ListOptions): Promise<Cursor<Comment>>;

  /** Posts a new footer comment. Body is Markdown (best-effort conversion). */
  addComment(markdown: string): Promise<void>;

  /** Lists the attachments on this content. Results stream through the returned cursor. */
  listAttachments(options?: ListOptions): Promise<Cursor<Attachment>>;

  /**
   * Downloads an attachment's bytes by its attachment ID. Throws if the attachment exceeds the
   * 16 KB download limit — list attachments first and check {@link Attachment.fileSize}.
   */
  downloadAttachment(id: string): Promise<AttachmentDownload>;

  /** Uploads a new attachment to this content. */
  uploadAttachment(options: UploadAttachmentOptions): Promise<Attachment>;

  /** Moves this content to the trash. Reversible via {@link restore} while it remains in the trash. */
  trash(): Promise<void>;

  /** Restores this content from the trash. */
  restore(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Cursors & paging

/**
 * A pagination cursor. This is an RPC object: call `next()` repeatedly on the *same* cursor to
 * fetch successive batches, until it returns `null`. Dispose the cursor when finished.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** Generic paging options for cursor-backed result sets. */
export type ListOptions = {
  /** Items per batch. Clamped to Confluence's supported range (1–100); defaults to 25. */
  pageSize?: number;
};

/** Options for {@link ConfluenceSite.listSpaces}. */
export type ListSpacesOptions = ListOptions & {
  /** Restrict to a space type. Omit to list all visible spaces. */
  type?: SpaceType;
};

/** Options for {@link ConfluenceSpace.listPages}. */
export type ListPagesOptions = ListOptions & {
  /** `"root"` (default) lists only top-level pages; `"all"` lists every page in the space. */
  depth?: "root" | "all";
};

/** Options for content search. */
export type SearchOptions = ListOptions & {
  /** Simple free-text query, matched against title and body. Ignored if `cql` is provided. */
  text?: string;
  /** Raw CQL query. Takes precedence over `text`. */
  cql?: string;
  /** Restrict results to a content type. */
  type?: ContentType;
};

// ---------------------------------------------------------------------------------------------
// Site / space

/** Display metadata for the connected site. */
export type SiteMetadata = {
  /** Site name. */
  name: string;
  /** Site base URL, e.g. `https://acme.atlassian.net/wiki`. */
  url: string;
  /** The Atlassian cloud ID of the site. */
  cloudId: string;
};

/** The kind of a Confluence space. */
export type SpaceType = "global" | "personal" | "collaboration" | "knowledge_base";

/** A compact summary of a space, returned by listing operations. */
export type SpaceSummary = {
  /** Numeric space ID. */
  id: string;
  /** Space key, e.g. `"ENG"`. */
  key: string;
  name: string;
  type: SpaceType;
  url: string;
};

/** Full space metadata. */
export type SpaceMetadata = SpaceSummary & {
  /** Plain-text space description, if any. */
  description?: string;
  /** The content ID of the space's homepage, if it has one. */
  homepageId?: string;
};

// ---------------------------------------------------------------------------------------------
// Content

/** Whether a piece of content is a page or a blog post. */
export type ContentType = "page" | "blogpost";

/** The lifecycle status of a piece of content. */
export type ContentStatus = "current" | "draft" | "trashed" | "archived";

/** A compact summary of a piece of content, returned by search and listing operations. */
export type ContentSummary = {
  id: string;
  type: ContentType;
  title: string;
  /** Key of the space the content lives in. */
  spaceKey?: string;
  url: string;
  status: ContentStatus;
  /** Creation time. Omitted by some lightweight listings (e.g. child pages). */
  createdAt?: Date;
  /** Last-updated time. Omitted by some lightweight listings (e.g. child pages). */
  lastUpdatedAt?: Date;
};

/** Full metadata for a page or blog post. */
export type ContentMetadata = ContentSummary & {
  /** Creation time. */
  createdAt: Date;
  /** Last-updated time. */
  lastUpdatedAt: Date;
  /** The current version number (each edit increments it). */
  version: number;
  /** For a page nested under another page, the parent page's content ID. */
  parentId?: string;
  /** The user who created the content. */
  author: ConfluenceUser | null;
  /** The user who last updated the content. */
  lastUpdatedBy: ConfluenceUser | null;
};

/** Options for {@link ConfluenceSpace.createPage}. */
export type CreatePageOptions = {
  title: string;
  /** Optional initial body content, as Markdown. */
  content?: string;
  /** Optional parent page content ID, to nest the new page under an existing one. */
  parentId?: string;
  /** Create the page as a draft instead of published. Defaults to `"current"` (published). */
  status?: "current" | "draft";
};

/** Options for {@link ConfluenceSpace.createBlogPost}. */
export type CreateBlogPostOptions = {
  title: string;
  /** Optional initial body content, as Markdown. */
  content?: string;
  /** Create the blog post as a draft instead of published. Defaults to `"current"` (published). */
  status?: "current" | "draft";
};

/** Options for {@link ConfluenceContent.createChildPage}. */
export type CreateChildPageOptions = {
  title: string;
  /** Optional initial body content, as Markdown. */
  content?: string;
  status?: "current" | "draft";
};

// ---------------------------------------------------------------------------------------------
// Users, comments, attachments

/** A Confluence user. */
export type ConfluenceUser = {
  /** Atlassian account ID. */
  accountId: string;
  /** Display name, if available. */
  displayName?: string;
  /** Email, only present for users whose email this connection is allowed to see. */
  email?: string;
  /** Avatar image URL, if available. */
  avatarUrl?: string;
};

/** A footer comment on a piece of content. */
export type Comment = {
  id: string;
  /** Comment body, converted to Markdown (best-effort). */
  text: string;
  author: ConfluenceUser | null;
  createdAt: Date;
};

/** Metadata for an attachment on a piece of content. */
export type Attachment = {
  id: string;
  /** File name, e.g. `"diagram.png"`. */
  title: string;
  /** MIME type, e.g. `"image/png"`. */
  mediaType: string;
  /** File size in bytes, if known. */
  fileSize?: number;
  /** The current version number of the attachment. */
  version: number;
  createdAt: Date;
};

/** The result of {@link ConfluenceContent.downloadAttachment}. */
export type AttachmentDownload = {
  filename: string;
  mediaType: string;
  /** The raw file bytes. Limited to a 16 KB download cap. */
  data: Uint8Array;
};

/** Options for {@link ConfluenceContent.uploadAttachment}. */
export type UploadAttachmentOptions = {
  /** File name to store the attachment under. */
  filename: string;
  /** MIME type of the file. */
  mediaType: string;
  /**
   * The raw file bytes. Limited to 25 MiB per attachment, and 50 MiB across all of a connection's
   * pending (not yet approved) uploads.
   */
  data: Uint8Array;
  /** Optional comment describing the attachment/upload. */
  comment?: string;
};
