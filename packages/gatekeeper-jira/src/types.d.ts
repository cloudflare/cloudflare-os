/**
 * Jira Cloud gatekeeper Session API.
 *
 * Jira Cloud organizes work into sites, projects, and issues. The gatekeeper exposes the same
 * capability boundaries: a whole {@link JiraSite}, one {@link JiraProject}, or one {@link JiraIssue}.
 * A connection uses exactly one Jira site, chosen when it was authorized; searches never reach
 * another site even when the same Atlassian account can access one. Reconnect to change sites.
 * Issue descriptions and comments use plain Markdown-like text strings. Jira stores them as
 * Atlassian Document Format; this gatekeeper preserves paragraph text and line breaks and treats
 * richer Jira formatting as best-effort plain text.
 */

/** Access to a whole Jira Cloud site. Prefer project or issue grants when possible. */
export interface JiraSite {
  /** Returns the connected Jira user. Use accountId for assignment; email may be hidden. */
  getCurrentUser(): Promise<JiraUser>;
  /** Returns basic site metadata, including the Atlassian cloud ID. */
  getMetadata(): Promise<JiraSiteMetadata>;
  /** Lists projects visible to the connected account. */
  listProjects(options?: JiraPageOptions): Promise<Cursor<JiraProjectSummary>>;
  /** Opens a project by key, numeric ID, or Jira project URL. */
  getProject(projectKeyOrIdOrUrl: string): Promise<JiraProject>;
  /** Searches issues with JQL, e.g. `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
   * currentUser() is the connected user: do not ask for their email. Keep JQL scoped when possible.
   * Recent writes may take time to appear in search; use getIssue() to read a known issue directly.
   */
  searchIssues(options: JiraIssueSearchOptions): Promise<Cursor<JiraIssueSummary>>;
  /** Opens an issue by key, numeric ID, or Jira issue URL. */
  getIssue(issueKeyOrIdOrUrl: string): Promise<JiraIssue>;
  /** Creates an issue. `projectKey` is required on a site session unless the connection has a default project. */
  createIssue(options: JiraCreateIssueOptions): Promise<JiraIssue>;
  /** Finds assignable users by name or email for issue assignment fields. */
  findUsers(query: string): Promise<JiraUser[]>;
}

/** Access to one Jira project and the issues it contains. */
export interface JiraProject {
  /** Returns the connected Jira user. Use accountId for assignment; email may be hidden. */
  getCurrentUser(): Promise<JiraUser>;
  /** Returns project metadata. */
  getMetadata(): Promise<JiraProjectMetadata>;
  /** Searches issues in this project using bounded structural filters; raw JQL is rejected. */
  searchIssues(options?: JiraIssueSearchOptions): Promise<Cursor<JiraIssueSummary>>;
  /** Opens an issue that belongs to this project. */
  getIssue(issueKeyOrIdOrUrl: string): Promise<JiraIssue>;
  /** Creates an issue in this project. `projectKey` is ignored if supplied. */
  createIssue(options: JiraCreateIssueOptions): Promise<JiraIssue>;
  /** Lists issue types available when creating issues in this project. */
  listIssueTypes(): Promise<JiraIssueType[]>;
  /** Lists project-visible workflow statuses. Use transitions on an issue to see allowed moves. */
  listStatuses(): Promise<JiraStatus[]>;
  /** Finds assignable users in this project. */
  findUsers(query: string): Promise<JiraUser[]>;
}

/** Access to one Jira issue and its comments, attachments, and workflow transitions.
 * A session returned by createIssue() may still be awaiting creation. Its operations then throw a
 * pending-creation error promptly. Retry the same session after creation completes, not createIssue().
 * Rejected or failed creation is terminal for that session.
 */
export interface JiraIssue {
  /** Returns full issue details, including Markdown description. */
  getDetails(): Promise<JiraIssueDetails>;
  /** Returns currently allowed workflow transitions for this issue. */
  listTransitions(): Promise<JiraTransition[]>;
  /** Updates common fields; omit fields that should remain unchanged. */
  update(fields: JiraIssueUpdate): Promise<void>;
  /** Applies a workflow transition by transition ID or case-insensitive transition name. */
  transition(transition: string, options?: JiraTransitionOptions): Promise<void>;
  /** Reads comments in oldest-first order. */
  listComments(options?: JiraPageOptions): Promise<Cursor<JiraComment>>;
  /** Adds a Markdown comment to the issue. */
  addComment(markdown: string): Promise<void>;
  /** Lists issue attachments. */
  listAttachments(): Promise<JiraAttachment[]>;
  /** Downloads a small attachment. Throws when the attachment exceeds the documented size limit. */
  downloadAttachment(id: string): Promise<JiraAttachmentDownload>;
  /** Uploads a new attachment to the issue. */
  uploadAttachment(options: JiraUploadAttachmentOptions): Promise<JiraAttachment>;
}

/** A pagination cursor. Await each `next()` before the next call. Empty batches may precede more
 * results; continue until `null`, then dispose the cursor. */
export interface Cursor<T> { next(): Promise<T[] | null>; }

/** Generic paging options. */
export type JiraPageOptions = { /** Max results per batch, clamped to Jira's API limits. */ maxResults?: number; };

/** Options for searching issues. */
export type JiraIssueSearchOptions = JiraPageOptions & {
  /** Raw JQL expression accepted only by site-scoped searches. Project-scoped searches reject it. */
  jql?: string;
  /** Plain text to match against issue text using Jira's `text ~` JQL operator. */
  text?: string;
  /** Match issues assigned to the connected user without an email lookup. Works within project grants too. Cannot be combined with jql. */
  assignedToMe?: boolean;
};

/** Metadata for a Jira Cloud site. */
export type JiraSiteMetadata = { cloudId: string; name: string; url: string; };

/** Compact project row. */
export type JiraProjectSummary = { id: string; key: string; name: string; url: string; projectTypeKey?: string; };

/** Full project metadata. */
export type JiraProjectMetadata = JiraProjectSummary & { description?: string; lead?: JiraUser; };

/** Jira user profile fields that are safe and commonly useful to agents. */
export type JiraUser = { accountId: string; displayName: string; emailAddress?: string; active?: boolean; avatarUrl?: string; };

/** Jira issue type, such as Bug, Task, Story, or Sub-task. */
export type JiraIssueType = { id: string; name: string; description?: string; subtask?: boolean; };

/** Jira workflow status. */
export type JiraStatus = { id: string; name: string; description?: string; category?: string; };

/** A transition currently available to an issue. */
export type JiraTransition = { id: string; name: string; to?: JiraStatus; };

/** Compact issue row returned by searches. */
export type JiraIssueSummary = {
  id: string; key: string; url: string; summary: string; projectKey: string; issueType?: JiraIssueType;
  status?: JiraStatus; priority?: string; assignee?: JiraUser | null; updated?: string; created?: string;
};

/** Full issue details. */
export type JiraIssueDetails = JiraIssueSummary & {
  descriptionMarkdown?: string; reporter?: JiraUser | null; labels: string[]; components: string[];
  fixVersions: string[]; dueDate?: string; parent?: JiraIssueSummary;
};

/** Fields accepted when creating an issue. */
export type JiraCreateIssueOptions = {
  projectKey?: string; issueType: string; summary: string; descriptionMarkdown?: string; assigneeAccountId?: string;
  labels?: string[]; components?: string[]; priority?: string; parentKeyOrId?: string; dueDate?: string;
};

/** Fields accepted when updating an issue. */
export type JiraIssueUpdate = {
  summary?: string; descriptionMarkdown?: string | null; assigneeAccountId?: string | null; labels?: string[];
  components?: string[]; priority?: string | null; dueDate?: string | null;
};

/** Additional fields to set while transitioning an issue. */
export type JiraTransitionOptions = { commentMarkdown?: string; fields?: JiraIssueUpdate; };

/** Issue comment. */
export type JiraComment = { id: string; author?: JiraUser; bodyMarkdown: string; created?: string; updated?: string; };

/** Issue attachment metadata. */
export type JiraAttachment = { id: string; filename: string; mimeType?: string; size: number; author?: JiraUser; created?: string; };

/** Small downloaded attachment. */
export type JiraAttachmentDownload = { id: string; filename: string; mimeType?: string; bytes: ArrayBuffer; };

/** Attachment upload payload. */
export type JiraUploadAttachmentOptions = { filename: string; mimeType?: string; bytes: ArrayBuffer; };
