/** Readiness marker only, with no search/read/mutation API. Use separately authorized Jira or Zendesk bindings for provider operations, not the UI-only interfaces below. */
export interface WorkItemsSession {
  /** Returns a short readiness string for smoke tests and agent discovery. */
  ping(): Promise<string>;
}

/** Work Items provider kind. */
export type WorkItemProviderKind = "jira" | "zendesk";

/** Stable provider-qualified reference to a work item. */
export type WorkItemProviderRef = {
  /** Source system that owns the item. */
  source: WorkItemProviderKind;
  /** Provider-native item identifier accepted by the source capability. */
  id: string;
  /** Optional human-readable key, such as a Jira issue key. */
  key?: string;
  /** Trusted provider UI URL supplied by the owning source, used to retain site identity. */
  url?: string;
};

/** Current source availability and shared-connection status. */
export type WorkItemSourceStatus = {
  /** Whether the source has the provider settings required for this source. */
  configured: boolean;
  /** Whether the source has a connection available for the caller. */
  connected: boolean;
  /** Bounded explanation for an unavailable source. */
  reason?: string;
};

/** Bounded status map for all Work Items providers. */
export type WorkItemSourceStatuses = Record<WorkItemProviderKind, WorkItemSourceStatus>;

/** Minimal person metadata exposed by normalized provider records. */
export type WorkItemPerson = {
  /** Display name when supplied by the source. */
  name?: string;
  /** Email address when supplied by the source. */
  email?: string;
  /** Provider-native person identifier when no richer metadata is available. */
  id?: string;
};

/** Search-list summary for a Jira issue or Zendesk ticket. */
export type WorkItemSummary = WorkItemProviderRef & {
  /** Trusted provider UI URL, when the source can provide one. */
  url?: string;
  /** Bounded title or subject. */
  title: string;
  /** Provider status name. */
  status?: string;
  /** Provider type name. */
  type?: string;
  /** Provider priority name. */
  priority?: string;
  /** Assignee display name or identifier. */
  assignee?: string;
  /** Requester display name or identifier. */
  requester?: string;
  /** Provider update timestamp as an ISO-like string. */
  updatedAt?: string;
  /** Jira project key, when present. */
  projectKey?: string;
  /** First-class normalized description text returned by the source, when present. */
  description?: WorkItemDescription;
  /** Allowlisted normalized field values. */
  fields: Record<string, string | number | boolean | null>;
};

/** Normalized provider description content for a work item. */
export type WorkItemDescription = {
  /** Complete or bounded body text in the declared format. */
  body: string;
  /** Safe interchange format supplied by the source. */
  format: "text" | "markdown";
  /** Provider-native source format from which the safe body was derived. */
  providerFormat?: "jira-adf" | "zendesk-markdown" | "zendesk-text" | "plain";
  /** True when unsupported provider structures could not be represented exactly. */
  lossy?: boolean;
  /** Bounded provider node names that could not be represented exactly. */
  unsupportedNodes?: string[];
  /** True when the proxy explicitly truncated the returned description. */
  truncated?: boolean;
};

/** Normalized metadata for an attachment exposed by Work Items. */
export type WorkItemAttachment = {
  /** Provider-native attachment id accepted by readAttachment(). */
  id: string;
  /** Safe display name supplied by the provider. */
  name: string;
  /** Provider content type, when supplied. */
  contentType?: string;
  /** File size in bytes, when supplied. */
  size?: number;
  /** Provider creation timestamp as an ISO-like string. */
  createdAt?: string;
  /** Provider-native comment id associated with the attachment, when supplied. */
  commentId?: string;
};

/** Bounded binary attachment content returned through the source capability. */
export type WorkItemAttachmentContent = {
  /** Bounded bytes of the attachment content. */
  data: Uint8Array;
  /** Safe display name for the attachment. */
  name: string;
  /** Content type selected from the proxy response, when supplied. */
  contentType?: string;
};

/** Provider media capabilities for one selected work item. */
export type WorkItemMediaCapabilities = {
  /** Whether the source capability accepts bounded binary uploads for this item. */
  uploads: boolean;
  /** Provider upload lifecycle: Jira attaches immediately; Zendesk stages until comment creation. */
  uploadMode: "immediate-issue" | "staged-comment";
  /** Editor targets that may initiate an upload. */
  targets: Array<"comment" | "description">;
  /** Whether provider-native inline image nodes are supported. */
  inlineImages: boolean;
  /** Whether provider-native inline video nodes are supported. */
  inlineVideos: boolean;
  /** Maximum accepted upload size in bytes. */
  maxBytes: number;
  /** Exact accepted MIME content types. */
  acceptedContentTypes: string[];
};

/** Input for a bounded work item attachment upload. */
export type WorkItemAttachmentUploadInput = {
  /** Safe provider-visible file name. */
  name: string;
  /** Allowlisted MIME content type. */
  contentType: string;
  /** Bounded attachment bytes. */
  data: Uint8Array;
  /** Editor target initiating the upload. */
  target: "comment" | "description";
};

/** Result of uploading a work item attachment. */
export type WorkItemAttachmentUploadResult = {
  /** Normalized provider attachment metadata. */
  attachment: WorkItemAttachment;
  /** Opaque bounded Zendesk staging handle supplied back only when the comment is posted. */
  uploadToken?: string;
  /** Provider upload lifecycle used for this attachment. */
  uploadMode: "immediate-issue" | "staged-comment";
  /** Editor target that initiated the upload. */
  target: "comment" | "description";
  /** False until the provider proxy supports native rich-text media nodes. */
  supportsInline: boolean;
  /** Zendesk staging expiry timestamp, when supplied by the provider. */
  expiresAt?: string;
};

/** Authoritative item detail returned by the source. */
export type WorkItemDetail = {
  /** The normalized authoritative item. */
  item: WorkItemSummary;
};

/** Bounded work item comment. */
export type WorkItemComment = {
  /** Provider-native comment id. */
  id: string;
  /** Bounded author display string. */
  author?: string;
  /** Safe bounded Markdown or text body. */
  body: string;
  /** Safe interchange format supplied by the source. */
  format?: "text" | "markdown";
  /** Provider-native source format from which the safe body was derived. */
  providerFormat?: "jira-adf" | "zendesk-markdown" | "zendesk-text" | "plain";
  /** True when unsupported provider structures could not be represented exactly. */
  lossy?: boolean;
  /** Bounded provider node names that could not be represented exactly. */
  unsupportedNodes?: string[];
  /** Whether the comment is public in Zendesk; Jira comments are always public. */
  public: boolean;
  /** Provider creation timestamp as an ISO-like string. */
  createdAt?: string;
};

/** Bounded work item activity entry. */
export type WorkItemActivity = {
  /** Provider-native activity id. */
  id: string;
  /** Provider activity kind, such as changelog or audit. */
  type: string;
  /** Bounded actor display string. */
  author?: string;
  /** Provider creation timestamp as an ISO-like string. */
  createdAt?: string;
  /** Bounded human-readable summary. */
  summary: string;
};

/** Provider-backed field update metadata for one item. */
export type WorkItemUpdateOptions = WorkItemProviderRef & {
  /** Lowercase allowlisted field names accepted by Work Items for this item. */
  allowedFields: string[];
  /** Bounded provider-native editable option names, when available. */
  providerOptions?: string[];
};

/** Optional provider-declared operation support for one selected work item. */
export type WorkItemOperationCapabilities = {
  /** Cross-provider linking support. Omitted or false means the UI must not offer link creation. */
  linkTo?: { supported: boolean; targetSources?: WorkItemProviderKind[]; reason?: string };
};

/** Jira workflow transition exposed by Work Items. */
export type WorkItemTransition = {
  /** Provider-native transition id. */
  id: string;
  /** Transition display name. */
  name: string;
  /** Destination status name, when supplied. */
  toStatus?: string;
};

/** Full read model for one selected item. */
export type WorkItemRead = {
  /** Authoritative item detail. */
  detail: WorkItemDetail;
  /** Recent provider comments. */
  comments: WorkItemComment[];
  /** Recent provider activity. */
  activity: WorkItemActivity[];
  /** Allowlisted update options. */
  updateOptions: WorkItemUpdateOptions;
  /** Jira workflow transitions; empty for Zendesk. */
  transitions: WorkItemTransition[];
  /** Bounded attachment metadata for the selected item. */
  attachments: WorkItemAttachment[];
  /** Provider-declared operation support; omitted capabilities are treated as unsupported. */
  operations?: WorkItemOperationCapabilities;
};

/** Work item source selector for search. */
export type WorkItemSearchSource = WorkItemProviderKind | "both";

/** Bounded work item search request. */
export type WorkItemSearchRequest = {
  /** Filter by this provider account's current assignee before pagination. Providers must fail rather than search all items when identity cannot be resolved. */
  assignedToMe?: boolean;
  /** Source to search, or both with provider-isolated partial failures. */
  source: WorkItemSearchSource;
  /** Optional provider text query. Empty searches use the provider default. */
  query?: string;
  /** Maximum items per provider, capped by Work Items. */
  limit?: number;
  /** Optional per-provider cursor map. */
  cursors?: Partial<Record<WorkItemProviderKind, string>>;
  /**
   * Asks providers that support it to page their entire matching source instead of stopping at a result ceiling.
   * Providers without such a path ignore it. Set it on the first page and keep it unchanged while paging: providers
   * may use a different endpoint and ordering, so cursors are not interchangeable between the two modes.
   */
  exhaustive?: boolean;
};

/** Bounded provider search error for partial-result pages. */
export type WorkItemProviderError = {
  /** Provider that failed. */
  source: WorkItemProviderKind;
  /** Bounded non-secret error message. */
  message: string;
  /** HTTP status when Work Items supplied one. */
  status?: number;
};

/**
 * Search page returned by the Work Items management API.
 *
 * Completeness contract — the minimal rules every producer and consumer must follow:
 * - `completeness[p] === true` means provider `p` exhausted its entire matching source for this query: no further
 *   pages, no ceiling truncation, no dropped or failed results. Only then may a caller call the results complete.
 * - `completeness[p] === false` means anything else: more pages remain, a provider ceiling truncated the match set,
 *   the provider failed, or malformed items were dropped.
 * - Omitting `p` is legal for providers that do not report it. Consumers must then derive conservatively:
 *   complete only when `hasMore[p] !== true` and `truncated[p] !== true` and no `errors` entry names `p`.
 * - A missing cursor is never evidence of completeness; a provider stopped at a ceiling also returns no cursor.
 * - When appending pages, a provider stays incomplete if any earlier page truncated, errored, or dropped items.
 */
export type WorkItemSearchPage = {
  /** Normalized items from all successful selected providers. */
  items: WorkItemSummary[];
  /** Next cursors keyed by provider. */
  cursors: Partial<Record<WorkItemProviderKind, string>>;
  /** Whether each provider reported more data. */
  hasMore: Partial<Record<WorkItemProviderKind, boolean>>;
  /** Whether each provider stopped at a hard result ceiling while further matches existed. */
  truncated?: Partial<Record<WorkItemProviderKind, boolean>>;
  /** Whether each provider exhausted its entire matching source. Omitted providers are derived conservatively. */
  completeness?: Partial<Record<WorkItemProviderKind, boolean>>;
  /** Provider-local failures when searching both. */
  errors?: WorkItemProviderError[];
};

/** Current Work Items user identity shown in the management UI. */
export type WorkItemsCurrentUser = {
  /** Human-readable display name from the connected Work Items OAuth identity. */
  displayName?: string;
  /** Stable unique user name, usually the connected Work Items OAuth email address. */
  uniqueName?: string;
};

/** Persisted filter selections for a Work Items saved view. */
export type WorkItemSavedViewFilters = {
  /** Provider status name included by the saved view. */
  status: string;
  /** Provider priority name included by the saved view. */
  priority: string;
  /** Provider work item type name included by the saved view. */
  type: string;
  /** Person display name, email, or identifier included by the saved view. */
  person: string;
};

/** Admin-created Work Items saved search/view stored on the shell account. */
export type WorkItemSavedView = {
  /** Restricts searches to the current assignee independently in each provider. */
  assignedToMe?: boolean;
  /** Stable user-supplied identifier used for replacement and deletion. */
  id: string;
  /** Human-readable saved view name. */
  name: string;
  /** Provider text query associated with the saved view. */
  query: string;
  /** Source selector searched by the saved view. */
  source: WorkItemSearchSource;
  /** Structured filters applied by the management UI. */
  filters: WorkItemSavedViewFilters;
  /** Preferred saved view presentation. */
  view: "list" | "kanban";
  /** Provider statuses hidden from the saved view. */
  hiddenStatuses: string[];
};

/** Input for adding a provider comment. */
export type WorkItemCommentInput = {
  /** Plain text comment body. */
  body: string;
  /** Visibility override. Zendesk defaults to internal; public must be explicit. Jira allows public only. */
  visibility?: "internal" | "public";
  /** Opaque handles returned by createAttachment() for Zendesk staged comment uploads. */
  attachmentTokens?: string[];
};

/** Bounded allowlisted field patch. */
export type WorkItemFieldPatch = {
  /** Field values keyed by provider field name. */
  fields: Record<string, string | number | boolean | null | string[]>;
};

/** Result of linking a Jira issue and Zendesk ticket through a Jira remote link. */
export type WorkItemLinkResult = {
  /** Stable Work Items remote-link global id. */
  globalId: string;
  /** Jira issue id or key used for the backlink. */
  jiraId: string;
  /** Zendesk ticket id linked from Jira. */
  zendeskTicketId: string;
};

/** Provider-source root capability consumed by the composite Work Items shell UI. */
export interface WorkItemsSourceManagementApi {
  /** Reads connected source identity for display only; assignment searches resolve identity within each provider. */
  getCurrentUser(): Promise<WorkItemsCurrentUser>;
  /** Reads provider configuration and connection status for the represented source. */
  getSourceStatuses(): Promise<WorkItemSourceStatuses>;
  /** Searches this source. The shell passes this source's exact selector, never `both`. Report `completeness` for this source when the provider can; the shell derives it conservatively otherwise. */
  search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage>;
  /** Selects one item and returns a narrow per-item capability. The client must dispose it. */
  item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi>;
}

/** Shell-local metadata and saved-view capability. */
export interface WorkItemsShellMetadataApi {
  /** Lists normalized saved Work Items views stored by the shell account. */
  listSavedViews(): Promise<WorkItemSavedView[]>;
  /** Saves or replaces one normalized Work Items saved view by its stable user-supplied id. */
  saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView>;
  /** Deletes one Work Items saved view by its stable user-supplied id. */
  deleteSavedView(id: string): Promise<void>;
  /** One-time bounded operational import for migrating saved views from a legacy shell. */
  importSavedViews?(views: WorkItemSavedView[]): Promise<WorkItemSavedView[]>;
}

/** Composite Work Items management root capability used by the shell UI. */
export interface WorkItemsManagementApi {
  /** Reads a display identity only. Never use this merged metadata to filter provider assignments. */
  getCurrentUser(): Promise<WorkItemsCurrentUser>;
  /** Lists normalized saved Work Items views stored on this shell account. */
  listSavedViews(): Promise<WorkItemSavedView[]>;
  /** Saves or replaces one normalized Work Items saved view by its stable user-supplied id. */
  saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView>;
  /** Deletes one Work Items saved view by its stable user-supplied id. */
  deleteSavedView(id: string): Promise<void>;
  /** Reads provider configuration and shared-connection statuses. */
  getSourceStatuses(): Promise<WorkItemSourceStatuses>;
  /** Searches Jira, Zendesk, or both; both-provider searches isolate provider failures and report per-provider `completeness`. */
  search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage>;
  /** Selects one item and returns a narrow per-item capability. The client must dispose it. */
  item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi>;
}

/** Work Items per-item management capability. */
export interface WorkItemManagementApi {
  /** Reads authoritative detail plus comments, activity, update options, and Jira transitions. */
  read(): Promise<WorkItemRead>;
  /** Reads bounded binary content for one attachment id on this item. */
  readAttachment(id: string): Promise<WorkItemAttachmentContent>;
  /** Reads provider-specific upload limits and lifecycle semantics for this item. */
  mediaCapabilities(): Promise<WorkItemMediaCapabilities>;
  /** Uploads one bounded attachment through Work Items without exposing provider credentials or URLs. */
  createAttachment(input: WorkItemAttachmentUploadInput): Promise<WorkItemAttachmentUploadResult>;
  /** Adds a comment, defaulting Zendesk comments to internal unless public is explicit, then returns refreshed detail. */
  addComment(input: WorkItemCommentInput): Promise<WorkItemDetail>;
  /** Updates allowlisted fields and returns refreshed authoritative detail. */
  updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail>;
  /** Applies a Jira transition and returns refreshed authoritative detail. */
  transition(transitionId: string): Promise<WorkItemDetail>;
  /** Links this item to another Jira/Zendesk item by creating the supported Jira backlink. */
  linkTo(other: WorkItemProviderRef): Promise<WorkItemLinkResult>;
}
