/** Bounded result for a queued Zendesk write. */
export type ZendeskActionResult<T = unknown> =
  | { status: "pending" }
  | { status: "rejected" }
  | { status: "failed"; message: string }
  | { status: "ready"; result: T };

/** A Zendesk action submitted for user approval. */
export type ZendeskQueuedAction<T = unknown> = { actionId: number; status: "pending"; pollAfterMs: number };

/** Stable provider-qualified reference to a Zendesk ticket. */
export type ZendeskTicketRef = { source: "zendesk"; id: string; key?: string };

/** Work Items provider kind. */
export type WorkItemProviderKind = "jira" | "zendesk";

/** Stable provider-qualified reference to a work item. */
export type WorkItemProviderRef = { source: WorkItemProviderKind; id: string; key?: string };

/** Current source availability and shared-connection status. */
export type WorkItemSourceStatus = { configured: boolean; connected: boolean; reason?: string };

/** Bounded status map for all Work Items providers. */
export type WorkItemSourceStatuses = Record<WorkItemProviderKind, WorkItemSourceStatus>;

/** Normalized description body for Zendesk tickets. */
export type WorkItemDescription = { body: string; format: "text" | "markdown"; providerFormat?: "zendesk-markdown" | "zendesk-text" | "plain"; truncated?: boolean };

/** Search-list summary for a Zendesk ticket. */
export type WorkItemSummary = ZendeskTicketRef & {
  url?: string;
  title: string;
  status?: string;
  type?: string;
  priority?: string;
  assignee?: string;
  requester?: string;
  updatedAt?: string;
  description?: WorkItemDescription;
  fields: Record<string, string | number | boolean | null>;
};

/** Bounded Zendesk comment. */
export type WorkItemComment = { id: string; author?: string; body: string; format?: "text" | "markdown"; providerFormat?: "zendesk-markdown" | "zendesk-text" | "plain"; public: boolean; createdAt?: string; /** True when the body exceeds 12,000 characters. */ truncated?: boolean };

/** Bounded Zendesk audit/activity entry. */
export type WorkItemActivity = { id: string; type: string; author?: string; createdAt?: string; summary: string };

/** Zendesk attachment metadata exposed without raw provider URLs. */
export type WorkItemAttachment = { id: string; name: string; contentType?: string; size?: number; createdAt?: string; commentId?: string };

/** Bounded binary attachment content. */
export type WorkItemAttachmentContent = { data: Uint8Array; name: string; contentType?: string };

/** Zendesk staged upload capabilities for comments. */
export type WorkItemMediaCapabilities = { uploads: true; uploadMode: "staged-comment"; targets: Array<"comment">; inlineImages: false; inlineVideos: false; maxBytes: number; acceptedContentTypes: string[] };

/** Input for a bounded staged Zendesk upload. */
export type WorkItemAttachmentUploadInput = { name: string; contentType: string; data: Uint8Array; target: "comment" };

/** Result of staging a Zendesk attachment for a later comment. */
export type WorkItemAttachmentUploadResult = { attachment: WorkItemAttachment; uploadToken: string; uploadMode: "staged-comment"; target: "comment"; supportsInline: false; expiresAt: string };

/** Ticket detail wrapper compatible with Work Items consumers. */
export type WorkItemDetail = { item: WorkItemSummary };

/** Allowlisted field update metadata for a ticket. */
export type WorkItemUpdateOptions = ZendeskTicketRef & { allowedFields: string[]; providerOptions?: string[] };

/** Full normalized Work Items read model for one Zendesk ticket. */
export type WorkItemRead = { detail: WorkItemDetail; comments: WorkItemComment[]; activity: WorkItemActivity[]; updateOptions: WorkItemUpdateOptions; transitions: WorkItemTransition[]; attachments: WorkItemAttachment[] };

/** Zendesk exposes no workflow transitions through this gatekeeper. */
export type WorkItemTransition = { id: string; name: string; toStatus?: string };

/** Bounded Zendesk search request. Keep query and limit unchanged when following cursors. */
export type ZendeskTicketSearchRequest = { query?: string; limit?: number; cursor?: string; /** Filter by the signed-in user's assignee ID, never requester. Keep unchanged while paging; fails if identity is unavailable or query includes an assignee term. */ assignedToMe?: boolean; /** Pages every match through the Zendesk export endpoint instead of stopping at the 1,000-result ceiling. Set it on the first page and keep it unchanged while paging; export results are ordered by created_at and cursors expire after one hour. */ exhaustive?: boolean };

/** Work item source selector for search. */
export type WorkItemSearchSource = WorkItemProviderKind | "both";

/** Bounded Work Items source search request. Keep query and limit unchanged when following cursors. */
export type WorkItemSearchRequest = { source: WorkItemSearchSource; query?: string; limit?: number; cursors?: Partial<Record<WorkItemProviderKind, string>>; /** Filter by the signed-in user's assignee ID, never requester. Keep unchanged while paging; fails if identity is unavailable or query includes an assignee term. */ assignedToMe?: boolean; /** Pages every match through the Zendesk export endpoint instead of stopping at the 1,000-result ceiling. Set it on the first page and keep it unchanged while paging. */ exhaustive?: boolean };

/**
 * Search page returned by Zendesk Work Items APIs.
 *
 * `completeness.zendesk` is the single authoritative "did I see everything?" signal: `true` only when every ticket
 * matching this query has been returned across the pages walked so far, `false` when more pages remain or results
 * were truncated at a ceiling. Never present results as complete unless it is `true`.
 */
export type WorkItemSearchPage = {
  items: WorkItemSummary[];
  cursors: { zendesk?: string };
  hasMore: { zendesk?: boolean };
  /** True when the 1,000-result search ceiling is reached with further matches. Narrow the query, or retry with `exhaustive`. */
  truncated?: { zendesk?: boolean };
  /** True only when the entire matching ticket set is exhausted; false when more pages remain or results were truncated. */
  completeness?: { zendesk?: boolean };
};

/** Current Zendesk user identity shown in the management UI. */
export type WorkItemsCurrentUser = { displayName?: string; uniqueName?: string };

/** Signed-in Zendesk identity; id can be used in assignee_id updates or assignee search filters. */
export type ZendeskCurrentUser = WorkItemsCurrentUser & { id: string };

/** Persisted filter selections for a Work Items saved view. */
export type WorkItemSavedViewFilters = { status: string; priority: string; type: string; person: string };

/** Admin-created Work Items saved search/view. */
export type WorkItemSavedView = { id: string; name: string; query: string; source: WorkItemSearchSource; filters: WorkItemSavedViewFilters; view: "list" | "kanban"; hiddenStatuses: string[] };

/** Result of linking provider work items. Native Zendesk does not currently create links. */
export type WorkItemLinkResult = { globalId: string; jiraId: string; zendeskTicketId: string };

/** Comment input. Zendesk defaults to internal unless public is explicit. */
export type WorkItemCommentInput = { body: string; visibility?: "internal" | "public"; attachmentTokens?: string[] };

/** Bounded allowlisted ticket field patch. */
export type WorkItemFieldPatch = { fields: Record<string, string | number | boolean | null | string[]> };

/** Coding-session tool metadata. */
export type ZendeskCodingSessionToolInfo = { name: string; title?: string; description?: string; mode: "read" | "action"; classifiedBy: "server-annotation" | "default"; inputSchema?: unknown };

/** Coding-session tool call result. */
export type ZendeskCodingSessionToolResult =
  | { status: "ok"; content: Array<{ type: "text"; text: string }>; text: string; structuredContent?: unknown }
  | { status: "pending"; actionId: number; message: string }
  | { status: "rejected"; message: string }
  | { status: "failed"; message: string };

/** Account-wide Zendesk API for searching and selecting tickets in one approved subdomain. */
export interface ZendeskAccountSession {
  /** Reads the currently signed-in Zendesk user's id, display name, and email (when available). */
  getCurrentUser(): Promise<ZendeskCurrentUser>;
  /** Searches up to 1,000 tickets, or every match when `exhaustive` is set on the first page. Keep query, limit, and `exhaustive` unchanged while paging; offset and export cursors cannot be mixed. Offset pagination can duplicate results when tickets change. Trust `completeness.zendesk`, not the absence of a cursor, before calling a result set complete. */
  searchTickets(request?: ZendeskTicketSearchRequest): Promise<WorkItemSearchPage>;
  /** Reads normalized detail, comments, activity, update options, and attachment metadata for one ticket. History is paginated internally; throws rather than returning partial history if a page fails or the 100-page/8 MB per-history limit is exceeded. Comment bodies are bounded to 12,000 characters. */
  readTicket(ticketId: string): Promise<WorkItemRead>;
  /** Returns a narrow capability for one ticket. Dispose the returned stub when finished. */
  ticket(ticketId: string): Promise<ZendeskTicketSession>;
  /** Polls the result of a previously queued Zendesk action. */
  getActionResult(actionId: number): Promise<ZendeskCodingSessionToolResult>;
  /** Lists tool descriptors that coding sessions may expose for this Zendesk account. */
  listTools(): Promise<ZendeskCodingSessionToolInfo[]>;
  /** Calls one coding-session Zendesk tool by name. */
  callTool(name: string, args?: Record<string, unknown>): Promise<ZendeskCodingSessionToolResult>;
  /** Back-compatibility alias for Workshop action-result polling. */
  getCodingSessionActionResult(actionId: number): Promise<ZendeskCodingSessionToolResult>;
}

/** Per-ticket Zendesk API for normalized Work Items reads and approval-backed mutations. */
export interface ZendeskTicketSession {
  /** Reads normalized ticket detail and paginated comments, activity, and attachments. Throws on incomplete history or the 100-page/8 MB per-history limit. Comment bodies are bounded to 12,000 characters with a truncated flag. */
  read(): Promise<WorkItemRead>;
  /** Reads bounded binary content for one attachment id. */
  readAttachment(id: string): Promise<WorkItemAttachmentContent>;
  /** Reads staged attachment-upload limits for this ticket. */
  mediaCapabilities(): Promise<WorkItemMediaCapabilities>;
  /** Adds an internal comment by default, or a public comment when explicitly requested. */
  addComment(input: WorkItemCommentInput): Promise<ZendeskQueuedAction<WorkItemDetail>>;
  /** Updates allowlisted fields. tags replaces the existing tag list. A concurrent ticket change fails with a conflict; read the ticket and resubmit the intended change. Oversized values are rejected, not truncated. */
  updateFields(patch: WorkItemFieldPatch): Promise<ZendeskQueuedAction<WorkItemDetail>>;
}

/** Work Items source UI root capability for a native Zendesk account. */
export interface WorkItemsManagementApi {
  /** Reads the connected Zendesk identity for display. */
  getCurrentUser(): Promise<WorkItemsCurrentUser>;
  /** Lists saved Work Items views. Native Zendesk source stores none. */
  listSavedViews(): Promise<WorkItemSavedView[]>;
  /** Returns the supplied saved view unchanged; the shell owns saved-view storage. */
  saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView>;
  /** Deletes no local saved view state; the shell owns saved-view storage. */
  deleteSavedView(id: string): Promise<void>;
  /** Reads provider configuration and connection status. */
  getSourceStatuses(): Promise<WorkItemSourceStatuses>;
  /** Searches Zendesk tickets. */
  search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage>;
  /** Selects one Zendesk ticket and returns a narrow per-ticket capability. */
  item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi>;
}

/** Work Items per-item capability for the native Zendesk source UI. */
export interface WorkItemManagementApi {
  /** Reads authoritative detail plus comments, activity, update options, and attachment metadata. */
  read(): Promise<WorkItemRead>;
  /** Reads bounded binary content for one attachment id on this ticket. */
  readAttachment(id: string): Promise<WorkItemAttachmentContent>;
  /** Reads provider-specific upload limits and lifecycle semantics for this ticket. */
  mediaCapabilities(): Promise<WorkItemMediaCapabilities>;
  /** Uploads one bounded attachment for a later Zendesk comment. */
  createAttachment(input: WorkItemAttachmentUploadInput): Promise<WorkItemAttachmentUploadResult>;
  /** Adds a comment, defaulting to internal unless public is explicit, then returns refreshed detail. */
  addComment(input: WorkItemCommentInput): Promise<WorkItemDetail>;
  /** Updates allowlisted fields and returns refreshed authoritative detail. */
  updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail>;
  /** Zendesk transitions are unsupported and this method throws. */
  transition(transitionId: string): Promise<WorkItemDetail>;
  /** Native Zendesk links are unsupported and this method throws. */
  linkTo(other: WorkItemProviderRef): Promise<WorkItemLinkResult>;
}

/** Backward-compatible alias for the native source root capability. */
export type ZendeskWorkItemsManagementApi = WorkItemsManagementApi;
