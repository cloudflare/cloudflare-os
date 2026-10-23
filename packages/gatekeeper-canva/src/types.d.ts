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
// `removeBackground()`, and each is simulated: it returns the design or asset it will make under a
// temporary id ("~1", "~2", ...), which `getDesign()`, `getImageAsset()`, `listDesigns()` and
// `listFolderItems()` honour straight away, and which keeps working once Canva has assigned the
// real id. A temporary id can also be passed on to another action (`createDesign({ assetId })`
// with the asset a pending `removeBackground()` makes), and the actions then apply in order. The
// agent is not paused for approval; it should carry on and treat the returned object as real,
// knowing that `editUrl`/`viewUrl` (and a thumbnail) exist only once Canva has made the design.

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
  /**
   * Canva design ID, e.g. "DAFVztcvd9z", or the temporary id ("~1") of a design a pending action
   * makes. Every method that takes a design id accepts the temporary one, before and after Canva
   * assigns the real id.
   */
  id: string;
  /** Design title. Untitled designs have no title. */
  title: string | null;
  /** The design's owner. Null when Canva omits it, as it does for a freshly generated design. */
  owner: CanvaUserRef | null;
  /** Thumbnail of the first page, if Canva has rendered one. */
  thumbnail: CanvaThumbnail | null;
  /**
   * URL that opens the design in the Canva editor. Null while the design is pending: Canva has
   * not made it yet, because the action that makes it awaits approval or its generation is still
   * running; read the design again later for the URL. TEMPORARY and PERSONAL once present: Canva
   * issues it for the connected user only, and it stops working after 30 days. Never store it in a
   * gadget or share it with another user; call `getDesign()` again for a fresh one. For a link
   * anyone with access can open any time, use `https://www.canva.com/design/<id>/edit`.
   */
  editUrl: string | null;
  /**
   * URL that opens a read-only view of the design. Same caveats as `editUrl`: null while pending,
   * and otherwise valid for 30 days and only for the connected user.
   */
  viewUrl: string | null;
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
  /**
   * Asset ID, e.g. "Msd59349ff", or the temporary id ("~2") of the asset a pending
   * `removeBackground()` makes, which `getImageAsset()` and `createDesign()` accept.
   */
  id: string;
  /** Asset name. */
  name: string;
  /** Tags the user has applied to the asset. */
  tags: string[];
  /** The asset's owner. Null when Canva omits it, as it does in folder listings. */
  owner: CanvaUserRef | null;
  /** Pixel dimensions, when Canva reports them (folder listings omit them). */
  dimensions: { width: number; height: number } | null;
  /** Thumbnail, if Canva has rendered one. Null while the asset is pending. */
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
   * ID of an image asset to place on the first page: one in the user's Canva account (see
   * `listFolderItems()` with `itemTypes: ["image"]`), or the temporary id of the asset a pending
   * `removeBackground()` makes, in which case this design is created once that asset exists.
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
  /** The id `generateDesign()` returned for the design, which `getDesign()` accepts throughout. */
  designId: string;
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
  /** The id `removeBackground()` returned for the new asset, which `getImageAsset()` accepts throughout. */
  assetId: string;
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
   * chooses the page size. Designs pending actions make are included, under their temporary ids,
   * when no `query` is given (a search cannot tell whether they would match).
   */
  listDesigns(options?: CanvaListDesignsOptions): Promise<Cursor<CanvaDesign>>;

  /**
   * Get metadata for a single design. Observation.
   *
   * Accepts a bare design ID ("DAFVztcvd9z"), a Canva design URL
   * ("https://www.canva.com/design/DAFVztcvd9z/..."), or the temporary id of a design a pending
   * `createDesign()` or `generateDesign()` makes ("~1"). For a temporary id it returns the pending
   * design, with null URLs, until Canva has made it, then the real one; for a design Canva could
   * not generate it throws with Canva's reason. Throws if the design does not exist, the connected
   * user cannot access it, or its creation was rejected.
   */
  getDesign(designIdOrUrl: string): Promise<CanvaDesign>;

  /**
   * Create a new, empty design. Action.
   *
   * Returns the design at once, under a temporary id and with null URLs, and queues its creation
   * for the user's approval. The pending design appears in `listDesigns()` and in
   * `listFolderItems("root")`, and `getDesign()` accepts its id throughout; once approved and
   * created, the same id resolves to the real design with its edit URL. Nothing exists on Canva
   * until the user approves.
   */
  createDesign(options: CanvaCreateDesignOptions): Promise<CanvaDesign>;

  // --- AI generation ---

  /**
   * Generate a doc or presentation from a text brief, using Canva's AI. Action.
   *
   * This spends the user's Canva AI credit allowance, so it always requires approval and the
   * approval shows the full brief. Returns the design at once, under a temporary id: Canva writes
   * its title and contents, so until generation finishes the design has a null title, page count
   * and URLs. Once the user approves, the gatekeeper starts the job on Canva, and generation takes
   * anywhere from seconds to a few minutes; `getDesign()` with the temporary id returns the real
   * design as soon as it is done, and throws with Canva's reason if generation failed. Keep the
   * returned design and poll `getDesign()` with its id; do not call this again for the same brief,
   * as every approval spends credits. Check `getProfile().canGenerateDesigns` first; Canva refuses
   * the job for users whose plan or team settings don't allow generation.
   */
  generateDesign(options: CanvaGenerateDesignOptions): Promise<CanvaDesign>;

  /**
   * The design generation jobs the user has approved from this connection, newest first.
   * Observation.
   *
   * A generation still waiting for approval is NOT listed here: its design exists only as the
   * pending row `generateDesign()` returned, so read that with `getDesign()`. An empty list after
   * calling `generateDesign()` means the user has not decided yet, not that the request was lost;
   * never ask again, since each approval spends credits. Refreshes the status of any job still in
   * progress before returning, and includes jobs Canva refused to start, as failed. To wait for one
   * design, poll `getDesign()` with its id.
   */
  listGeneratedDesigns(): Promise<CanvaGenerationJob[]>;

  // --- Image assets ---

  /**
   * Get metadata for an image asset by ID. Observation.
   *
   * Asset IDs come from `listFolderItems()` entries of type "image" or from `removeBackground()`,
   * whose temporary id ("~2") is accepted throughout: it returns the pending asset, without a
   * thumbnail, until Canva has made it, then the real one, and throws with Canva's reason if the
   * removal failed. Only IDs are accepted, because Canva has no public URL for an asset. Throws if
   * the asset does not exist, is not an image (Canva also stores videos as assets), or the
   * connected user cannot access it.
   */
  getImageAsset(assetId: string): Promise<CanvaImageAsset>;

  /**
   * Remove an image's background with Canva's AI, producing a new asset. Action.
   *
   * This spends the user's Canva AI credit allowance, so it always requires approval. The source
   * asset is left untouched; the result is a new asset with a transparent background, capped at 10
   * megapixels. Returns the new asset at once, under a temporary id and with its name and size
   * predicted from the source; it appears in `listFolderItems("uploads")`, `getImageAsset()`
   * accepts its id, and `createDesign({ assetId })` can place it before it exists. Once the user
   * approves, the gatekeeper starts the job on Canva, which usually completes within seconds (if
   * it takes longer, the user is asked to approve again and the same job is resumed). Keep the
   * returned asset and poll `getImageAsset()` with its id; do not call this again for the same
   * image, as every approval spends credits. Check `getProfile().canRemoveBackgrounds` first;
   * Canva refuses the job for users on plans without it.
   *
   * @param assetId The source image asset, which must have finished uploading, or the temporary id
   * of the asset an earlier `removeBackground()` makes.
   */
  removeBackground(assetId: string, options?: CanvaRemoveBackgroundOptions): Promise<CanvaImageAsset>;

  /**
   * The background removal jobs the user has approved from this connection, newest first.
   * Observation.
   *
   * A removal still waiting for approval is NOT listed here: its asset exists only as the pending
   * row `removeBackground()` returned, so read that with `getImageAsset()`. An empty list after
   * calling `removeBackground()` means the user has not decided yet, not that the request was lost;
   * never ask again, since each approval spends credits (a repeat for the same image is refused
   * while the first waits). Refreshes the status of any job still in progress before returning, and
   * includes jobs Canva refused to start, as failed. To wait for one asset, poll `getImageAsset()`
   * with its id.
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
   * `{ itemTypes: ["folder"] }`. Designs pending actions make are listed in "root", and assets a
   * pending `removeBackground()` makes in "uploads", under their temporary ids.
   */
  listFolderItems(folderIdOrUrl: string, options?: CanvaListFolderItemsOptions): Promise<Cursor<CanvaFolderItem>>;
}
