// TypeScript API exposed to Gadgets by the Canva gatekeeper.
//
// One resource granularity is offered (see getGatekeeperClassFor / getSupportedResources):
//
//   1. Canva Account (whole-instance, `https://*`) -> `CanvaAccountSession`.
//      Access to the connected account via the Canva Connect API: the user's profile, their
//      designs (search, metadata), their folders and image assets, creating and AI-generating
//      designs, and AI image transformation.
//
// Reads are observations: they are logged and may be blocked by policy, but need no approval.
// Listings return a `Cursor`: call `next()` until it returns null, and dispose it when done.
//
// Writes are actions: they are queued for the user's approval and nothing reaches Canva until the
// action is approved. There are three, `createDesign()`, `generateDesign()` and
// `removeBackground()`, and none is simulated — each returns once queued, and nothing exists until
// the user approves it and Canva has done the work. The harness pauses the agent until the user
// decides, so after an action resolves the agent should read back: `listDesigns()` for a created
// design, `listGeneratedDesigns()` for a generated one, and `listBackgroundRemovals()` for a
// transformed image (the last two are asynchronous jobs on Canva's side).

// ---------------------------------------------------------------------------
// Pagination

/**
 * A pagination cursor over a listing. Call `next()` repeatedly to fetch successive batches; it
 * returns null once exhausted. An empty batch does NOT mean exhaustion — Canva can return an
 * empty page mid-walk — so stop on null, never on length. Dispose the cursor when finished.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

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
   * Whether this user's plan allows background removal (a premium feature). When false,
   * `removeBackground()` will be refused by Canva at apply time.
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
  /**
   * URL that opens the design in the Canva editor. TEMPORARY and PERSONAL: Canva issues it for
   * the connected user only, and it stops working after 30 days. Never store it in a gadget or
   * share it with another user; call `getDesign()` again for a fresh one. For a link anyone with
   * access can open any time, use `https://www.canva.com/design/<id>/edit`.
   */
  editUrl: string;
  /**
   * URL that opens a read-only view of the design. Same caveats as `editUrl`: valid for 30 days
   * and only for the connected user.
   */
  viewUrl: string;
  /** Number of pages, if known. Docs have no pages. */
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
};

// ---------------------------------------------------------------------------
// Actions

/** Canva's preset design kinds. */
export type CanvaPresetDesignType = "doc" | "whiteboard" | "presentation";

/**
 * The kind of design to create: a preset name, or custom pixel dimensions (each between 40 and
 * 8000 pixels).
 */
export type CanvaDesignType = CanvaPresetDesignType | { width: number; height: number };

/** Options for `createDesign()`. */
export type CanvaCreateDesignOptions = {
  /** What kind of design to create. */
  designType: CanvaDesignType;
  /** Title for the new design. Untitled if omitted. */
  title?: string;
  /**
   * ID of an existing image asset to place on the first page. The asset must already be in the
   * user's Canva account (see `listFolderItems()` with `itemTypes: ["image"]`).
   */
  assetId?: string;
};

/** The kinds of design Canva can generate from a brief. */
export type CanvaGenerationDesignType = "doc" | "presentation";

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
   * What to make: subject, purpose, required wording, tone, and visual direction. 1 to 5000
   * characters. A specific brief produces a far better design than a vague one.
   */
  brief: string;
  /** "doc" or "presentation". */
  designType: CanvaGenerationDesignType;
  /**
   * A slide-by-slide outline, 1 to 100 sections. Only valid when the design type is
   * "presentation"; Canva rejects it for docs.
   */
  outline?: { sections: CanvaGenerationSection[] };
};

/** Options for `removeBackground()`. */
export type CanvaRemoveBackgroundOptions = {
  /**
   * Name for the new asset, 1 to 255 characters. Defaults to the source asset's name. Not
   * localised, so write it in the user's language.
   */
  name?: string;
};

/**
 * Why a design generation job failed. "content_not_allowed": the brief or output failed Canva's
 * content-safety checks. "generation_failed": Canva could not complete the job. "expired": the job
 * aged out on Canva before completing. "refused": Canva refused to start the job (the message says
 * why, e.g. the user's plan lacks the feature). Other codes may appear as Canva adds them.
 */
export type CanvaGenerationErrorCode =
  | "content_not_allowed" | "generation_failed" | "expired" | "refused" | (string & {});

/**
 * Why a background removal job failed. "no_foreground_found": the image has no subject to keep.
 * "quota_exceeded": the user's AI credits ran out. "internal_error": Canva could not complete the
 * job. "expired": the job aged out before completing. "refused": Canva refused to start the job.
 * Other codes may appear as Canva adds them.
 */
export type CanvaBackgroundRemovalErrorCode =
  | "no_foreground_found" | "quota_exceeded" | "internal_error" | "expired" | "refused" | (string & {});

/** One design generation job started from this connection, as returned by `listGeneratedDesigns()`. */
export type CanvaGenerationJob = {
  /** Canva's job ID. Null when Canva refused to start the job. */
  id: string | null;
  /** The brief the design was generated from. */
  brief: string;
  /** The kind of design requested. */
  designType: CanvaGenerationDesignType;
  /** ISO 8601 timestamp of when the job was started on Canva (or refused). */
  startedAt: string;
  /**
   * "in_progress" while Canva is still generating; "success" once the design exists; "failed" when
   * Canva could not or would not generate it.
   */
  status: "in_progress" | "success" | "failed";
  /** The generated design. Present only when `status` is "success". */
  design: CanvaDesign | null;
  /** Why generation failed. Present only when `status` is "failed". */
  error: { code: CanvaGenerationErrorCode; message: string } | null;
};

/** One background removal job started from this connection, as returned by `listBackgroundRemovals()`. */
export type CanvaBackgroundRemovalJob = {
  /** Canva's job ID. Null when the job finished during creation, or Canva refused to start it. */
  id: string | null;
  /** The source asset. It is never modified; the result is a new asset. */
  sourceAssetId: string;
  /** ISO 8601 timestamp of when the job was started on Canva (or refused). */
  startedAt: string;
  /** "in_progress" while Canva is working; "success" once the new asset exists; "failed" otherwise. */
  status: "in_progress" | "success" | "failed";
  /** The new image asset. Present only when `status` is "success". */
  asset: CanvaImageAsset | null;
  /** Why the removal failed. Present only when `status` is "failed". */
  error: { code: CanvaBackgroundRemovalErrorCode; message: string } | null;
};

// ---------------------------------------------------------------------------
// Session

/**
 * Access to the connected Canva account. All methods are RPC calls to the gatekeeper.
 *
 * Every read is an observation that is logged and may be blocked by policy, and every write is an
 * action that waits for the user's approval.
 */
export interface CanvaAccountSession {
  /** Read the connected user's profile and which plan-gated features they have. Observation. */
  getProfile(): Promise<CanvaProfile>;

  // --- Designs ---

  /**
   * List or search the user's designs. Observation.
   *
   * Returns a cursor; call `next()` until it returns null and dispose it when done. Canva
   * chooses the page size.
   */
  listDesigns(options?: CanvaListDesignsOptions): Promise<Cursor<CanvaDesign>>;

  /**
   * Get metadata for a single design. Observation.
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
  createDesign(options: CanvaCreateDesignOptions): Promise<void>;

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
   */
  generateDesign(options: CanvaGenerateDesignOptions): Promise<void>;

  /**
   * The design generation jobs started from this connection, newest first. Observation.
   *
   * Refreshes the status of any job still in progress before returning, so calling this a few
   * times, a few seconds apart, is how to wait for a generation to finish. Includes jobs Canva
   * refused to start, as failed, so an approved request that went nowhere is visible. Jobs the
   * user rejected before they started are not included.
   */
  listGeneratedDesigns(): Promise<CanvaGenerationJob[]>;

  // --- Image assets ---

  /**
   * Get metadata for an image asset by ID. Observation.
   *
   * Asset IDs come from `listFolderItems()` entries of type "image", or from a finished
   * `listBackgroundRemovals()` job. Only IDs are accepted, because Canva has no public URL for an
   * asset. Throws if the asset does not exist, is not an image (Canva also stores videos as
   * assets), or the connected user cannot access it.
   */
  getImageAsset(assetId: string): Promise<CanvaImageAsset>;

  /**
   * Queue the removal of an image's background with Canva's AI, producing a new asset. Action.
   *
   * This spends the user's Canva AI credit allowance, so it always requires approval. The source
   * asset is left untouched; the result is a new asset with a transparent background, capped at 10
   * megapixels. Resolves as soon as the request is queued, not when the new asset exists: once the
   * user approves, the gatekeeper starts the job on Canva, which usually completes within seconds.
   * Call `listBackgroundRemovals()` to follow it and get the new asset's ID. Check
   * `getProfile().canRemoveBackgrounds` first; Canva refuses the job for users on plans without it.
   *
   * @param assetId The source image asset. It must have finished uploading.
   */
  removeBackground(assetId: string, options?: CanvaRemoveBackgroundOptions): Promise<void>;

  /**
   * The background removal jobs started from this connection, newest first. Observation.
   *
   * Refreshes the status of any job still in progress before returning, so calling this a few
   * times, a few seconds apart, is how to wait for a removal to finish. Includes jobs Canva refused
   * to start, as failed.
   */
  listBackgroundRemovals(): Promise<CanvaBackgroundRemovalJob[]>;

  // --- Folders ---

  /**
   * Get metadata for a folder. Observation.
   *
   * Accepts a folder ID or a Canva folder URL ("https://www.canva.com/folder/FAF..."). Use "root"
   * for the user's top-level Projects folder and "uploads" for their Uploads folder.
   */
  getFolder(folderIdOrUrl: string): Promise<CanvaFolder>;

  /**
   * List the contents of a folder: nested folders, designs, and image assets. Observation.
   *
   * Accepts a folder ID or URL, as `getFolder()` does. Returns a cursor; see `listDesigns()`. Each
   * item is tagged with its `type` so a caller can switch on it. To list only sub-folders, pass
   * `{ itemTypes: ["folder"] }`.
   */
  listFolderItems(folderIdOrUrl: string, options?: CanvaListFolderItemsOptions): Promise<Cursor<CanvaFolderItem>>;
}
