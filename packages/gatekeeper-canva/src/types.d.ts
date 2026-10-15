// TypeScript API exposed to Gadgets by the Canva gatekeeper.
//
// One resource granularity is offered (see getGatekeeperClassFor / getSupportedResources):
//
//   1. Canva Account (whole-instance, `https://*`) -> `CanvaAccountSession`.
//      Access to the connected account via the Canva Connect API: the user's profile, their
//      designs (search, metadata), their folders, and creating new designs.
//
// Reads are observations: they are logged and may be blocked by policy, but need no approval.
// Writes are actions: they are queued for the user's approval and nothing reaches Canva until the
// action is approved. There are three, `createDesign()`, `generateDesign()` and `transformImage()`,
// and none is simulated — each returns once queued, and nothing exists until the user approves it
// and Canva has done the work. The harness pauses the agent until the user decides, so after an
// action resolves the agent should read back: `listDesigns()` for a created design,
// `listGeneratedDesigns()` for a generated one, and `listImageTransformations()` for a transformed
// image (the last two are asynchronous jobs on Canva's side).
//
// Pagination follows Canva's own model: a page returns an opaque `continuation` token when more
// results exist, and the caller passes it back to fetch the next page. A page may contain fewer
// items than the requested maximum even when more exist, so paginate until `continuation` is
// absent, never on page length.

// ---------------------------------------------------------------------------
// Shared value types

/** A thumbnail image for a design, folder, or asset. */
export type CanvaThumbnail = {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /**
   * Temporary URL of the image. Canva thumbnail URLs expire (typically within 15 minutes), so
   * fetch the parent object again rather than storing this URL.
   */
  url: string;
};

/** Identifies a Canva user within a team. */
export type CanvaUserRef = {
  /** Canva user ID. */
  userId: string;
  /** ID of the team the user belongs to. */
  teamId: string;
};

/** The connected user's profile. */
export type CanvaProfile = {
  /** Canva user ID of the connected user. */
  userId: string;
  /** ID of the team the connected user is acting in. */
  teamId: string;
  /** The user's display name, as shown in Canva. */
  displayName: string;
  /**
   * Whether this user's plan and team settings allow AI design generation. When false,
   * `generateDesign()` will be refused by Canva at apply time, so check this before offering it.
   */
  canGenerateDesigns: boolean;
  /**
   * Whether this user's plan allows background removal (a premium feature). When false, a
   * `transformImage()` with a "background_removal" step will be refused by Canva at apply time.
   */
  canRemoveBackgrounds: boolean;
};

/** Metadata for a Canva design. */
export type CanvaDesign = {
  /** Canva design ID, e.g. "DAFVztcvd9z". */
  id: string;
  /** Design title. Untitled designs have no title. */
  title: string | null;
  /** The design's owner. Null when Canva omits it, as it does for a freshly generated design. */
  owner: CanvaUserRef | null;
  /** Thumbnail of the first page, if Canva has rendered one. */
  thumbnail: CanvaThumbnail | null;
  /** URL that opens the design in the Canva editor (requires the viewer to have edit access). */
  editUrl: string;
  /** URL that opens a read-only view of the design. */
  viewUrl: string;
  /** Number of pages, if known. */
  pageCount: number | null;
  /** ISO 8601 timestamp of when the design was created. */
  createdAt: string;
  /** ISO 8601 timestamp of when the design was last modified. */
  updatedAt: string;
};

/** Metadata for a Canva folder. */
export type CanvaFolder = {
  /**
   * Folder ID. Canva reserves a few well-known IDs: "root" (the user's Projects root), "uploads"
   * (the Uploads folder), and "projects" (same as "root" for most purposes).
   */
  id: string;
  /** Folder name. */
  name: string;
  /** Thumbnail, if Canva has rendered one. */
  thumbnail: CanvaThumbnail | null;
  /** ISO 8601 timestamp of when the folder was created. */
  createdAt: string;
  /** ISO 8601 timestamp of when the folder was last modified. */
  updatedAt: string;
};

/** Metadata for an image asset in the user's Canva account. */
export type CanvaImageAsset = {
  /** Asset ID, e.g. "Msd59349ff". */
  id: string;
  /** Asset name. */
  name: string;
  /** Tags the user has applied to the asset. */
  tags: string[];
  /** The asset's owner. Null when Canva omits it, as it does in folder listings. */
  owner: CanvaUserRef | null;
  /** Pixel dimensions, when Canva reports them (folder listings omit them). */
  dimensions: { width: number; height: number } | null;
  /** Thumbnail, if Canva has rendered one. */
  thumbnail: CanvaThumbnail | null;
  /** ISO 8601 timestamp of when the asset was created. */
  createdAt: string;
  /** ISO 8601 timestamp of when the asset was last modified. */
  updatedAt: string;
};

/** One entry in a folder: a nested folder, a design, or an image asset. Discriminated on `type`. */
export type CanvaFolderItem =
  | { type: "folder"; folder: CanvaFolder }
  | { type: "design"; design: CanvaDesign }
  | { type: "image"; image: CanvaImageAsset };

/** A single page of results plus the token for the next page, if any. */
export type CanvaPage<T> = {
  /** The items on this page. May be shorter than the requested maximum even when more exist. */
  items: T[];
  /**
   * Opaque token for the next page. Pass it back as `continuation` to fetch more. Absent when this
   * is the last page.
   */
  continuation?: string;
};

/** Which designs to include when listing. */
export type CanvaDesignOwnership = "owned" | "shared" | "any";

/** Sort order for design listings. */
export type CanvaDesignSort =
  | "relevance"
  | "modified_descending"
  | "modified_ascending"
  | "title_descending"
  | "title_ascending";

/** Options for `listDesigns()`. */
export type CanvaListDesignsOptions = {
  /** Free-text search over design titles. Omit to list all designs. */
  query?: string;
  /** Restrict to designs the user owns, designs shared with them, or both (default "any"). */
  ownership?: CanvaDesignOwnership;
  /** Sort order (default "relevance" when `query` is set, otherwise "modified_descending"). */
  sortBy?: CanvaDesignSort;
  /** Token from a previous page's `continuation` to fetch the next page. */
  continuation?: string;
};

/** Which kinds of items to include when listing a folder. Defaults to all three. */
export type CanvaFolderItemType = "folder" | "design" | "image";

/** Sort order for folder listings. */
export type CanvaFolderItemSort =
  | "created_ascending"
  | "created_descending"
  | "modified_ascending"
  | "modified_descending"
  | "title_ascending"
  | "title_descending";

/** Options for `listFolderItems()`. */
export type CanvaListFolderItemsOptions = {
  /** Restrict to these item kinds (default: folders, designs, and images). */
  itemTypes?: CanvaFolderItemType[];
  /** Sort order (default "modified_descending"). */
  sortBy?: CanvaFolderItemSort;
  /** Token from a previous page's `continuation` to fetch the next page. */
  continuation?: string;
};

/**
 * The kind of design to create. Either one of Canva's preset types, or custom pixel dimensions.
 */
export type CanvaDesignType =
  | { type: "preset"; name: "doc" | "whiteboard" | "presentation" }
  | { type: "custom"; width: number; height: number };

/** Options for `createDesign()`. */
export type CanvaCreateDesignOptions = {
  /** Title for the new design. Untitled if omitted. */
  title?: string;
  /**
   * ID of an existing image asset to place on the first page. The asset must already be in the
   * user's Canva account (see `listFolderItems()` with `itemTypes: ["image"]`).
   */
  assetId?: string;
};

/** The kinds of design Canva can generate from a brief. Only these two presets are supported. */
export type CanvaGenerationDesignType = { type: "preset"; name: "doc" | "presentation" };

/** One slide of a presentation outline. */
export type CanvaGenerationSection = {
  /** Slide title, 1 to 255 characters. */
  title: string;
  /** What the slide should cover, up to 2000 characters. */
  description?: string;
  /** Bullet points for the slide, up to 50. */
  points?: string[];
};

/** Options for `generateDesign()`. */
export type CanvaGenerateDesignOptions = {
  /**
   * A slide-by-slide outline, 1 to 100 sections. Only valid when the design type is
   * "presentation"; Canva rejects it for docs.
   */
  outline?: { sections: CanvaGenerationSection[] };
};

/**
 * One step of an image transformation. Only background removal exists today; it takes no
 * parameters, keeps the foreground subject, and makes the background transparent. Output is capped
 * at 10 megapixels (larger sources are scaled down).
 */
export type CanvaImageTransformation = { type: "background_removal" };

/** Options for `transformImage()`. */
export type CanvaTransformImageOptions = {
  /**
   * Name for the new asset, 1 to 255 characters. Defaults to the source asset's name. Not
   * localised, so write it in the user's language.
   */
  name?: string;
};

/** One image transformation job started from this connection, as returned by `listImageTransformations()`. */
export type CanvaImageTransformationJob = {
  /** Canva's job ID. Null when the job finished during creation and Canva issued no ID. */
  id: string | null;
  /** The source asset. It is never modified; the result is a new asset. */
  sourceAssetId: string;
  /** The transformations requested, in order. */
  transformations: CanvaImageTransformation[];
  /** ISO 8601 timestamp of when the job was started on Canva. */
  startedAt: string;
  /** "in_progress" while Canva is working; "success" once the new asset exists; "failed" otherwise. */
  status: "in_progress" | "success" | "failed";
  /** The new image asset. Present only when `status` is "success". */
  asset: CanvaImageAsset | null;
  /**
   * Why the transformation failed. Present only when `status` is "failed". `code` is
   * "no_foreground_found" when the image has no subject to keep, "quota_exceeded" when the user's AI
   * credits ran out, "internal_error" when Canva could not complete the job, or "expired" when the
   * job aged out before completing.
   */
  error: { code: string; message: string } | null;
};

/** One design generation job started from this connection, as returned by `listGeneratedDesigns()`. */
export type CanvaGenerationJob = {
  /** Canva's job ID. */
  id: string;
  /** The brief the design was generated from. */
  brief: string;
  /** The kind of design requested. */
  designType: CanvaGenerationDesignType;
  /** ISO 8601 timestamp of when the job was started on Canva. */
  startedAt: string;
  /**
   * "in_progress" while Canva is still generating; "success" once the design exists; "failed" when
   * Canva could not or would not generate it. Jobs expire on Canva 24 hours after they start, so a
   * job still in progress after that is reported as failed with code "expired".
   */
  status: "in_progress" | "success" | "failed";
  /** The generated design. Present only when `status` is "success". */
  design: CanvaDesign | null;
  /**
   * Why generation failed. Present only when `status` is "failed". `code` is "content_not_allowed"
   * when the brief or output failed Canva's content-safety checks, "generation_failed" when Canva
   * could not complete the job, or "expired" when the job aged out before completing.
   */
  error: { code: string; message: string } | null;
};

// ---------------------------------------------------------------------------
// Session

/**
 * Access to the connected Canva account. All methods are RPC calls to the gatekeeper.
 *
 * The session is a *read mostly* view of the account: every read is an observation that is logged
 * and may be blocked by policy, and the single write (`createDesign`) is an action that waits for
 * the user's approval.
 */
export interface CanvaAccountSession {
  /** Read the connected user's profile. Observation. */
  getProfile(): Promise<CanvaProfile>;

  // --- Designs ---

  /**
   * List or search the user's designs. Observation.
   *
   * Returns one page at a time. Pass the returned `continuation` back in `options.continuation`
   * to fetch the next page; stop when it is absent. Canva chooses the page size.
   */
  listDesigns(options?: CanvaListDesignsOptions): Promise<CanvaPage<CanvaDesign>>;

  /**
   * Get metadata for a single design by ID. Observation.
   *
   * Accepts a bare design ID ("DAFVztcvd9z") or a Canva design URL
   * ("https://www.canva.com/design/DAFVztcvd9z/..."). Throws if the design does not exist or the
   * connected user cannot access it.
   */
  getDesign(designIdOrUrl: string): Promise<CanvaDesign>;

  /**
   * Queue the creation of a new, empty design. Action.
   *
   * Resolves as soon as the request is queued for the user's approval, not when the design exists.
   * This action is not simulated: until the user approves it and Canva creates the design, it does
   * not appear in `listDesigns()` or `listFolderItems()`. The harness pauses the agent until the
   * user decides; once approved, call `listDesigns({ sortBy: "modified_descending" })` to find the
   * new design and its edit URL.
   */
  createDesign(designType: CanvaDesignType, options?: CanvaCreateDesignOptions): Promise<void>;

  // --- AI generation ---

  /**
   * Queue the generation of a doc or presentation from a text brief, using Canva's AI. Action.
   *
   * This spends the user's Canva AI credit allowance, so it always requires approval and the
   * approval shows the full brief. Resolves as soon as the request is queued, not when the design
   * exists: once the user approves, the gatekeeper starts the job on Canva, and generation then
   * takes anywhere from seconds to a few minutes. Call `listGeneratedDesigns()` to follow it and
   * get the resulting design's edit URL. Check `getProfile().canGenerateDesigns` first; Canva
   * refuses the job for users whose plan or team settings don't allow generation.
   *
   * @param brief What to make: subject, purpose, required wording, tone, and visual direction.
   *   1 to 5000 characters. A specific brief produces a far better design than a vague one.
   * @param designType "doc" or "presentation".
   * @param options An optional slide outline, for presentations only.
   */
  generateDesign(
    brief: string,
    designType: CanvaGenerationDesignType,
    options?: CanvaGenerateDesignOptions,
  ): Promise<void>;

  /**
   * The design generation jobs started from this connection, newest first. Observation.
   *
   * Refreshes the status of any job still in progress before returning, so calling this a few
   * times, a few seconds apart, is how to wait for a generation to finish. Jobs the user rejected
   * before they started are not included.
   */
  listGeneratedDesigns(): Promise<CanvaGenerationJob[]>;

  // --- Image assets ---

  /**
   * Get metadata for an image asset by ID. Observation.
   *
   * Asset IDs come from `listFolderItems()` entries of type "image", or from a finished
   * `listImageTransformations()` job. Throws if the asset does not exist, is not an image (Canva
   * also stores videos as assets), or the connected user cannot access it.
   */
  getImageAsset(assetId: string): Promise<CanvaImageAsset>;

  /**
   * Queue one or more transformations of an image asset, producing a new asset. Action.
   *
   * This spends the user's Canva AI credit allowance, so it always requires approval. The source
   * asset is left untouched. Resolves as soon as the request is queued, not when the new asset
   * exists: once the user approves, the gatekeeper starts the job on Canva, which usually completes
   * within seconds. Call `listImageTransformations()` to follow it and get the new asset's ID.
   * Check `getProfile().canRemoveBackgrounds` first; Canva refuses background removal for users on
   * plans without it.
   *
   * @param assetId The source image asset. It must have finished uploading.
   * @param transformations 1 to 20 steps, applied in order.
   * @param options An optional name for the new asset.
   */
  transformImage(
    assetId: string,
    transformations: CanvaImageTransformation[],
    options?: CanvaTransformImageOptions,
  ): Promise<void>;

  /**
   * The image transformation jobs started from this connection, newest first. Observation.
   *
   * Refreshes the status of any job still in progress before returning, so calling this a few
   * times, a few seconds apart, is how to wait for a transformation to finish.
   */
  listImageTransformations(): Promise<CanvaImageTransformationJob[]>;

  // --- Folders ---

  /**
   * Get metadata for a folder by ID. Observation.
   *
   * Use "root" for the user's top-level Projects folder and "uploads" for their Uploads folder.
   */
  getFolder(folderId: string): Promise<CanvaFolder>;

  /**
   * List the sub-folders of a folder. Observation.
   *
   * A convenience over `listFolderItems(folderId, { itemTypes: ["folder"] })`. Defaults to the
   * "root" folder when `folderId` is omitted.
   */
  listFolders(folderId?: string, continuation?: string): Promise<CanvaPage<CanvaFolder>>;

  /**
   * List the contents of a folder: nested folders, designs, and image assets. Observation.
   *
   * Returns one page at a time; see `listDesigns()` for the pagination contract. Each item is
   * tagged with its `type` so a caller can switch on it.
   */
  listFolderItems(folderId: string, options?: CanvaListFolderItemsOptions): Promise<CanvaPage<CanvaFolderItem>>;
}
