import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
  type ApprovalQueue,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperReconnectOptions,
  type GatekeeperUser,
  type GatekeeperVendor as GatekeeperVendorIface,
  type GatekeeperUserVerifier,
  type ObservationAuthorizer,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
  renderBrowserFlowCompletionHtml,
} from "@gadgets/workshop-shared/gatekeeper";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type { McpCallResult, McpToolInfo } from "@gadgets/mcp-shared/types";
import { createLogger } from "@gadgets/backend-utils/logger";
import type {
  WorkItemAttachment,
  WorkItemAttachmentContent,
  WorkItemAttachmentUploadInput,
  WorkItemAttachmentUploadResult,
  WorkItemDetail,
  WorkItemFieldPatch,
  WorkItemLinkResult,
  WorkItemManagementApi,
  WorkItemMediaCapabilities,
  WorkItemProviderRef,
  WorkItemRead,
  WorkItemSearchPage,
  WorkItemSearchRequest,
  WorkItemSourceStatuses,
  WorkItemsCurrentUser,
  WorkItemsManagementApi,
} from "@gadgets/gatekeeper-work-items/types";
import {
  JIRA_SCOPES,
  JiraApi,
  JiraApiError,
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
  adfToMarkdown,
  assertAtlassianHost,
  classifyJiraUrl,
  exchangeAuthCode,
  getAccessibleResources,
  getAtlassianIdentity,
  markdownToAdf,
  jqlLiteral,
  normalizeJiraProjectKey,
  normalizeJiraIssueKey,
  parseIssueKeyOrId,
  parseProjectKeyOrId,
  refreshAccessToken,
  type AccessibleResource,
  type AtlassianIdentity,
  type OAuthGrant,
  type RawAttachment,
  type RawComment,
  type RawIssue,
  type RawProject,
  type RawStatus,
  type RawTransition,
  type RawUser,
} from "./jira-api";
import type {
  Cursor,
  JiraAttachment,
  JiraAttachmentDownload,
  JiraComment,
  JiraCreateIssueOptions,
  JiraIssue,
  JiraIssueDetails,
  JiraIssueSearchOptions,
  JiraIssueSummary,
  JiraIssueType,
  JiraIssueUpdate,
  JiraPageOptions,
  JiraProject,
  JiraProjectMetadata,
  JiraProjectSummary,
  JiraSite,
  JiraSiteMetadata,
  JiraStatus,
  JiraTransition,
  JiraTransitionOptions,
  JiraUploadAttachmentOptions,
  JiraUser,
} from "./types";
import TYPES_CODE from "./types.txt";
import JIRA_LOGO_SVG from "./jira-logo.svg";
import SITE_CONFIGURATOR_HTML from "./generated/jira-site-configurator-ui.txt";
import PROJECT_CONFIGURATOR_HTML from "./generated/jira-project-configurator-ui.txt";
import ISSUE_CONFIGURATOR_HTML from "./generated/jira-issue-configurator-ui.txt";
import { JiraConfiguratorUI } from "./jira-configurators";
import type { ConfiguratorOption, JiraConfiguratorRpc, JiraDefaultProject } from "./configurator/jira-configurator-types";

type Env = Cloudflare.Env & { BASE_URL?: string; PUBLIC_BASE_URL?: string; CLIENT_ID?: string; CLIENT_SECRET?: string };
type StoredNonce = { value: string; expiresAt: number; stage: "initiation" | "oauth" | "exchanging" | "selection"; returnUrl?: string };
type StoredGrant = Pick<OAuthGrant, "accessToken" | "refreshToken" | "expiresAt">;
/** The one Jira site this connection is scoped to. Atlassian never reports the consented site. */
type StoredSite = { cloudId: string; url: string; name: string };
/** A grant held while the browser flow asks which site to use; never usable until a site is chosen. */
type StoredPendingSelection = { grant: StoredGrant; sites: AccessibleResource[]; identity: AtlassianIdentity | null };
/** Outcome of a browser-flow step: completed, awaiting a site choice, or refused with a reason. */
type OAuthOutcome = { returnUrl?: string; selection?: { nonce: string; sites: StoredSite[] }; error?: string };
type StoredDefaultProject = { cloudId: string; webBase: string; projectKey: string; projectName: string };
type StoredOAuthError = { error?: string; error_description?: string };
type StagedActionState = { state: "pending" | "applying" | "approved" | "rejected" | "failed"; action: StoredAction; createdAt: number; result?: unknown; error?: string };
type BaseProps = { userObjectId: string; cloudId: string; webBase: string };
type ProjectProps = BaseProps & { projectKey: string };
type IssueProps = BaseProps & { issueKey: string; projectKey?: string };

const VENDOR_ID = "jira";
type JiraLogFields = { component: string; vendorId: string; event?: string; error?: unknown; actionId?: number; tool?: string };
const logger = createLogger<JiraLogFields>({ component: "gatekeeper.jira", vendorId: VENDOR_ID });
const NONCE_BYTES = 32;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;
const REFRESH_RETRY_DELAY_MS = 5 * 60 * 1000;
const CALLBACK_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_COMMENT_CHARS = 20_000;
const MAX_ATTACHMENT_NAME_CHARS = 180;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_CURSOR_CHARS = 4096;
const ACCEPTED_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif", "text/plain", "application/pdf"];
const NO_SELECTED_SITE = "This Jira connection has no selected Jira site. Reconnect the Jira account and choose one site.";
const JIRA_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(JIRA_LOGO_SVG)}`;

export const SITE_RESOURCE: SupportedResource = { urlPattern: "https://*.atlassian.net", title: "Jira Site", description: "Read and manage work items across one Jira Cloud site." };
export const PROJECT_RESOURCE: SupportedResource = { urlPattern: "https://*.atlassian.net/projects/:projectKey{/:rest}*", title: "Jira Project", description: "Read and manage issues inside one Jira project." };
export const ISSUE_RESOURCE: SupportedResource = { urlPattern: "https://*.atlassian.net/browse/:issueKey", title: "Jira Issue", description: "Read and manage one Jira issue, including comments and attachments." };
const SUPPORTED_RESOURCES = [SITE_RESOURCE, PROJECT_RESOURCE, ISSUE_RESOURCE];

const getBaseUrl = (env: Env): string => (env.BASE_URL ?? "http://localhost:8787/gatekeeper/jira").replace(/\/+$/, "");
const getBasePath = (env: Env): string => new URL(getBaseUrl(env)).pathname;
const hexEncode = (bytes: Uint8Array): string => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const generateNonce = (): string => hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
const clampPageSize = (size?: number): number => Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(size ?? DEFAULT_PAGE_SIZE)));
const issueUrl = (webBase: string, key: string): string => `${webBase}/browse/${key}`;
const projectUrl = (webBase: string, key: string): string => `${webBase}/projects/${key}`;
const SECURITY_HEADERS = { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const htmlResponse = (body: string, status = 200): Response => new Response(body, { status, headers: SECURITY_HEADERS });
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const page = (title: string, message: string): string => `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto"><h1>${title}</h1><p>${escapeHtml(message)}</p></body></html>`;
/** Explicit chooser shown when one authorization grants several Jira sites; never picks one for the user. */
const siteChooserPage = (env: Env, state: string, sites: StoredSite[]): string =>
  `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto"><h1>Choose a Jira site</h1><p>This connection uses exactly one Jira site. Reconnecting preserves this choice.</p><form method="post" action="${escapeHtml(`${getBaseUrl(env)}/select`)}"><input type="hidden" name="state" value="${escapeHtml(state)}">${sites.map(site => `<p><button type="submit" name="cloudId" value="${escapeHtml(site.cloudId)}" style="width:100%;padding:.75rem;text-align:left;font-size:1rem">${escapeHtml(site.name)}<br><small>${escapeHtml(site.url)}</small></button></p>`).join("")}</form></body></html>`;
const storedSite = (site: AccessibleResource): StoredSite => ({ cloudId: site.id, url: site.url, name: site.name });

function tokenRefreshAt(grant: StoredGrant): number {
  return Math.max(Date.now(), grant.expiresAt - TOKEN_REFRESH_SKEW_MS);
}

function isSameStoredGrant(a: StoredGrant | undefined, b: StoredGrant): boolean {
  return a?.accessToken === b.accessToken && a.refreshToken === b.refreshToken && a.expiresAt === b.expiresAt;
}

function isSameNotificationGeneration(value: unknown, generation: number): boolean {
  return value === true || value === generation;
}

function isTerminalRefreshError(error: unknown): boolean {
  if (!(error instanceof JiraApiError)) return false;
  const details = error.details as StoredOAuthError | undefined;
  return details?.error === "invalid_grant" || /(^|:)\s*invalid_grant\b/.test(error.message);
}

function expectedWorkshopBase(env: Env): URL {
  return new URL(env.PUBLIC_BASE_URL ?? new URL(getBaseUrl(env)).origin);
}

export function validateNativeReturnUrl(returnUrl: string | undefined, env: Env): string | undefined {
  if (returnUrl === undefined) return undefined;
  if (returnUrl.length > 4096) throw new Error("Native OAuth return URL is too long.");
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new Error("Native OAuth return URL is invalid.");
  }
  const expected = expectedWorkshopBase(env);
  const prefix = new URL("/native/oauth-return/", expected).pathname;
  if (parsed.origin !== expected.origin || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Native OAuth return URL is outside this Workshop deployment.");
  }
  if (!parsed.pathname.startsWith(prefix)) throw new Error("Native OAuth return URL has an invalid path.");
  let handle: string;
  try {
    handle = decodeURIComponent(parsed.pathname.slice(prefix.length));
  } catch {
    throw new Error("Native OAuth return URL handle is invalid.");
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(handle) || parsed.pathname !== `${prefix}${encodeURIComponent(handle)}`) {
    throw new Error("Native OAuth return URL handle is invalid.");
  }
  return parsed.toString();
}

/** Splits `${durableObjectId}:${nonce}` browser-flow state, rejecting anything else before any lookup. */
function parseFlowState(state: string): [string, string] | null {
  const parts = state.split(":");
  return parts.length === 2 && /^[0-9a-f]{64}$/i.test(parts[0]) && /^[0-9a-f]{64}$/i.test(parts[1]) ? [parts[0], parts[1]] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const lhs = new TextEncoder().encode(a);
  const rhs = new TextEncoder().encode(b);
  let diff = lhs.byteLength ^ rhs.byteLength;
  const length = Math.max(lhs.byteLength, rhs.byteLength);
  for (let i = 0; i < length; i++) diff |= (lhs[i] ?? 0) ^ (rhs[i] ?? 0);
  return diff === 0;
}

function normUser(user?: RawUser | null): JiraUser | undefined {
  if (!user) return undefined;
  return { accountId: user.accountId, displayName: user.displayName ?? user.accountId, emailAddress: user.emailAddress, active: user.active, avatarUrl: user.avatarUrls?.["48x48"] };
}
const normStatus = (status?: RawStatus): JiraStatus | undefined => status && ({ id: status.id, name: status.name, description: status.description, category: status.statusCategory?.key ?? status.statusCategory?.name });
const normProject = (webBase: string, project: RawProject): JiraProjectSummary => ({ id: project.id, key: project.key, name: project.name, url: projectUrl(webBase, project.key), projectTypeKey: project.projectTypeKey });
const normIssueType = (type?: { id: string; name: string; description?: string; subtask?: boolean }): JiraIssueType | undefined => type && ({ id: type.id, name: type.name, description: type.description, subtask: type.subtask });
function normIssue(webBase: string, issue: RawIssue): JiraIssueSummary {
  const f = issue.fields;
  return { id: issue.id, key: issue.key, url: issueUrl(webBase, issue.key), summary: f.summary ?? "", projectKey: f.project?.key ?? issue.key.split("-")[0], issueType: normIssueType(f.issuetype), status: normStatus(f.status), priority: f.priority?.name, assignee: normUser(f.assignee) ?? null, created: f.created, updated: f.updated };
}
function normIssueDetails(webBase: string, issue: RawIssue): JiraIssueDetails {
  const f = issue.fields;
  return { ...normIssue(webBase, issue), descriptionMarkdown: adfToMarkdown(f.description), reporter: normUser(f.reporter) ?? null, labels: f.labels ?? [], components: f.components?.map(c => c.name) ?? [], fixVersions: f.fixVersions?.map(v => v.name) ?? [], dueDate: f.duedate, parent: f.parent ? normIssue(webBase, f.parent) : undefined };
}
const normComment = (comment: RawComment): JiraComment => ({ id: comment.id, author: normUser(comment.author), bodyMarkdown: adfToMarkdown(comment.body), created: comment.created, updated: comment.updated });
const normAttachment = (attachment: RawAttachment): JiraAttachment => ({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size ?? 0, author: normUser(attachment.author), created: attachment.created });
const normTransition = (transition: RawTransition): JiraTransition => ({ id: transition.id, name: transition.name, to: normStatus(transition.to) });
const display = (user?: JiraUser | null): string | undefined => user ? user.emailAddress ?? user.displayName ?? user.accountId : undefined;
const defaultProjectOption = (project: StoredDefaultProject): JiraDefaultProject => ({ value: projectUrl(project.webBase, project.projectKey), title: project.projectName, subtitle: `${project.projectKey} · ${new URL(project.webBase).hostname}` });
function toWorkItem(issue: JiraIssueDetails | JiraIssueSummary): import("@gadgets/gatekeeper-work-items/types").WorkItemSummary {
  return { source: "jira", id: issue.url, key: issue.key, url: issue.url, title: issue.summary.slice(0, 500), status: issue.status?.name, type: issue.issueType?.name, priority: issue.priority, assignee: display(issue.assignee), requester: "reporter" in issue ? display(issue.reporter) : undefined, updatedAt: issue.updated, projectKey: issue.projectKey, description: "descriptionMarkdown" in issue && issue.descriptionMarkdown ? { body: issue.descriptionMarkdown, format: "markdown", providerFormat: "jira-adf" } : undefined, fields: { projectKey: issue.projectKey, key: issue.key, siteUrl: new URL(issue.url).origin } };
}
const toWorkAttachment = (a: JiraAttachment): WorkItemAttachment => ({ id: a.id, name: a.filename, contentType: a.mimeType, size: a.size, createdAt: a.created });
const toWorkTransition = (t: JiraTransition) => ({ id: t.id, name: t.name, toStatus: t.to?.name });

/** The account surface every site-scoped Jira caller needs: which site, and a token proven to match it. */
type SiteScopedAccount = { getSelectedSite(): Promise<AccessibleResource | null>; getAccessTokenForSite(cloudId: string): Promise<string> };
async function requireSelectedSite(account: SiteScopedAccount): Promise<AccessibleResource> {
  const site = await account.getSelectedSite();
  if (!site) throw new JiraApiError(409, NO_SELECTED_SITE);
  return site;
}
const apiForSite = (account: SiteScopedAccount, site: AccessibleResource): JiraApi =>
  new JiraApi({ cloudId: site.id, webBase: site.url, getToken: () => account.getAccessTokenForSite(site.id) });
/** Configurator inputs restricted to the selected site, so live search never spans other granted sites. */
const selectedSiteScope = (account: SiteScopedAccount) => ({
  getSites: async (): Promise<AccessibleResource[]> => [await requireSelectedSite(account)],
  getToken: async (): Promise<string> => account.getAccessTokenForSite((await requireSelectedSite(account)).id),
});

function validateComment(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Comment body is required.");
  if (trimmed.length > MAX_COMMENT_CHARS) throw new Error("Comment body exceeds the Jira gatekeeper limit.");
  return trimmed;
}
function validateUpload(input: JiraUploadAttachmentOptions | WorkItemAttachmentUploadInput): JiraUploadAttachmentOptions {
  const filename = ("filename" in input ? input.filename : input.name).trim()
    .replaceAll(String.fromCharCode(0), "_")
    .replace(/[\\/]/g, "_");
  if (!filename || filename.length > MAX_ATTACHMENT_NAME_CHARS) throw new Error("Attachment filename is missing or too long.");
  const mimeType = "contentType" in input ? input.contentType : input.mimeType;
  if (!mimeType || !ACCEPTED_UPLOAD_TYPES.includes(mimeType)) throw new Error("Attachment content type is not allowed.");
  const raw = "bytes" in input ? input.bytes : input.data;
  const bytes = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).slice().buffer;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Attachment bytes are missing or exceed the upload limit.");
  return { filename, mimeType, bytes };
}

function okResult(structuredContent: unknown): McpCallResult {
  const text = JSON.stringify(structuredContent, null, 2);
  return { status: "ok", content: [{ type: "text", text }], text, structuredContent };
}

function storedActionResult(staged: StagedActionState | undefined, actionId: number, liveApplying: boolean): McpCallResult {
  if (!staged) return { status: "failed", message: `No stored result is available yet for Jira action ${actionId}.` };
  if (staged.state === "applying" && !liveApplying) return { status: "failed", message: `Jira action ${actionId} has an unknown outcome after interruption. Verify the issue and its history before submitting a new action; the write may have reached Jira and will not be retried.` };
  if (staged.state === "pending" || staged.state === "applying") return { status: "pending", actionId, message: `Jira action ${actionId} is ${staged.state}.` };
  if (staged.state === "approved") return okResult({ state: "approved", actionId, result: staged.result });
  if (staged.state === "rejected") return { status: "rejected", message: `Jira action ${actionId} was rejected.` };
  return { status: "failed", message: `${staged.error ?? `Jira action ${actionId} failed.`} Verify the issue and its history before submitting a new action; the write may have reached Jira.` };
}

function parseToolString(args: Record<string, unknown>, key: string, pattern?: RegExp, max = 1000): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${key} is too long.`);
  if (pattern && !pattern.test(trimmed)) throw new Error(`${key} has an invalid format.`);
  return trimmed;
}

function parseToolLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 20) throw new Error("limit must be an integer from 1 to 20.");
  return value;
}

function parseToolPatch(args: Record<string, unknown>): JiraIssueUpdate {
  const fields = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be an object.");
  const out: JiraIssueUpdate = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (key === "summary" && typeof value === "string") out.summary = value.slice(0, 500);
    else if (key === "descriptionMarkdown" && (typeof value === "string" || value === null)) out.descriptionMarkdown = value;
    else if (key === "assigneeAccountId" && (typeof value === "string" || value === null)) out.assigneeAccountId = value;
    else if (key === "labels" && Array.isArray(value) && value.every(v => typeof v === "string")) out.labels = value.slice(0, 20);
    else if (key === "components" && Array.isArray(value) && value.every(v => typeof v === "string")) out.components = value.slice(0, 20);
    else if (key === "priority" && (typeof value === "string" || value === null)) out.priority = value;
    else if (key === "dueDate" && (typeof value === "string" || value === null)) out.dueDate = value;
    else throw new Error(`Unsupported Jira update field: ${key}`);
  }
  return out;
}

function parseWorkItemPatch(patch: WorkItemFieldPatch): JiraIssueUpdate {
  const out: JiraIssueUpdate = {};
  for (const [key, value] of Object.entries(patch.fields)) {
    if (key === "summary" && typeof value === "string") out.summary = value.slice(0, 500);
    else if (key === "description" && (typeof value === "string" || value === null)) out.descriptionMarkdown = value;
    else if (key === "assigneeAccountId" && (typeof value === "string" || value === null)) out.assigneeAccountId = value;
    else if (key === "labels" && Array.isArray(value) && value.every(v => typeof v === "string")) out.labels = value.slice(0, 20);
    else if (key === "components" && Array.isArray(value) && value.every(v => typeof v === "string")) out.components = value.slice(0, 20);
    else if (key === "priority" && (typeof value === "string" || value === null)) out.priority = value;
    else if (key === "dueDate" && (typeof value === "string" || value === null)) out.dueDate = value;
    else throw new Error(`Unsupported Jira work item update field: ${key}`);
  }
  return out;
}

function issueFields(options: JiraCreateIssueOptions, projectKey: string): Record<string, unknown> {
  projectKey = normalizeJiraProjectKey(projectKey);
  const fields: Record<string, unknown> = { project: { key: projectKey }, issuetype: { name: options.issueType }, summary: options.summary };
  if (options.descriptionMarkdown !== undefined) fields.description = markdownToAdf(options.descriptionMarkdown);
  if (options.assigneeAccountId !== undefined) fields.assignee = { accountId: options.assigneeAccountId };
  if (options.labels) fields.labels = options.labels;
  if (options.components) fields.components = options.components.map(name => ({ name }));
  if (options.priority) fields.priority = { name: options.priority };
  if (options.parentKeyOrId) fields.parent = { key: options.parentKeyOrId };
  if (options.dueDate) fields.duedate = options.dueDate;
  return fields;
}
function updateFields(options: JiraIssueUpdate): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (options.summary !== undefined) fields.summary = options.summary;
  if (options.descriptionMarkdown !== undefined) fields.description = options.descriptionMarkdown === null ? null : markdownToAdf(options.descriptionMarkdown);
  if (options.assigneeAccountId !== undefined) fields.assignee = options.assigneeAccountId === null ? null : { accountId: options.assigneeAccountId };
  if (options.labels !== undefined) fields.labels = options.labels;
  if (options.components !== undefined) fields.components = options.components.map(name => ({ name }));
  if (options.priority !== undefined) fields.priority = options.priority === null ? null : { name: options.priority };
  if (options.dueDate !== undefined) fields.duedate = options.dueDate;
  return fields;
}
export const scopedJql = (projectKey: string | undefined, options?: JiraIssueSearchOptions): string => {
  if (projectKey && options?.jql) throw new Error("Raw JQL is not accepted on project-scoped Jira capabilities.");
  if (options?.jql) {
    if (options.text || options.assignedToMe) throw new Error("Raw JQL cannot be combined with structural Jira search filters.");
    return options.jql;
  }
  const clauses = [projectKey ? `project = ${jqlLiteral(normalizeJiraProjectKey(projectKey))}` : undefined, options?.text ? `text ~ ${jqlLiteral(options.text)}` : undefined, options?.assignedToMe ? "assignee = currentUser()" : undefined].filter(Boolean);
  return (clauses.length ? clauses.join(" AND ") : "ORDER BY updated DESC");
};
const toBase64Url = (text: string): string => { let binary = ""; for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fromBase64Url = (text: string): string => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0)));
const CURSOR_HINT = "cursor must be a nextCursor returned by a previous jira_search.";
/** Coding-session cursors carry their query, so a cursor can never widen a search beyond its own scope. */
const encodeSearchCursor = (jql: string, token: string): string => toBase64Url(JSON.stringify({ jql, token }));
function parseSearchCursor(value: unknown, jql: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > MAX_SEARCH_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(CURSOR_HINT);
  let parsed: { jql?: unknown; token?: unknown };
  try { parsed = JSON.parse(fromBase64Url(value)) as { jql?: unknown; token?: unknown }; } catch { throw new Error(CURSOR_HINT); }
  if (typeof parsed?.token !== "string" || !parsed.token) throw new Error(CURSOR_HINT);
  if (parsed.jql !== jql) throw new Error("cursor belongs to a different Jira search; search again without a cursor.");
  return parsed.token;
}
const parseWorkItemsJiraCursor = (cursor: string | undefined): Record<string, string | null> => {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every(value => value === null || typeof value === "string")) return parsed as Record<string, string | null>;
  } catch {
    // Offset cursors cannot be translated to enhanced-search tokens.
  }
  throw new Error("Jira search cursor is obsolete or invalid. Restart the search.");
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) throw new Error("Request path does not match BASE_URL path");
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) return htmlResponse(page("Jira Gatekeeper Not Configured", "Configure an Atlassian OAuth client ID and secret."));
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(path[0]));
      const begun = await stub.beginOAuthFlow(path[1]);
      if (!begun) return htmlResponse(page("Authorization Link Expired", "Return to Cloudflare OS and try again."));
      const authUrl = new URL("https://auth.atlassian.com/authorize");
      authUrl.searchParams.set("audience", "api.atlassian.com");
      authUrl.searchParams.set("client_id", env.CLIENT_ID);
      authUrl.searchParams.set("scope", JIRA_SCOPES.join(" "));
      authUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      authUrl.searchParams.set("state", `${path[0]}:${begun.oauthNonce}`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("prompt", "consent");
      return Response.redirect(authUrl.toString(), 302);
    }
    if (relPath === "/oauth") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return new Response("missing state or code", { status: 400 });
      const parts = parseFlowState(state);
      if (!parts) return htmlResponse(page("Invalid Authorization State", "Return to Cloudflare OS and try again."), 400);
      const [id, nonce] = parts;
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(id));
      const accepted = await stub.acceptAuthCode(code, nonce);
      if (!accepted) return htmlResponse(page("Authorization Link Expired", "Return to Cloudflare OS and try again."));
      if (accepted.error) return htmlResponse(page("Jira Site Not Connected", accepted.error), 400);
      if (accepted.selection) return htmlResponse(siteChooserPage(env, `${id}:${accepted.selection.nonce}`, accepted.selection.sites));
      return htmlResponse(renderBrowserFlowCompletionHtml({ returnUrl: accepted.returnUrl, appName: "Odie OS" }));
    }
    if (relPath === "/select") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      const form = await req.formData();
      const parts = parseFlowState(String(form.get("state") ?? ""));
      if (!parts) return htmlResponse(page("Invalid Authorization State", "Return to Cloudflare OS and try again."), 400);
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(parts[0]));
      const selected = await stub.selectSite(String(form.get("cloudId") ?? "").slice(0, 200), parts[1]);
      if (!selected) return htmlResponse(page("Authorization Link Expired", "Return to Cloudflare OS and try again."));
      if (selected.error) return htmlResponse(page("Jira Site Not Connected", selected.error), 400);
      return htmlResponse(renderBrowserFlowCompletionHtml({ returnUrl: selected.returnUrl, appName: "Odie OS" }));
    }
    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> { return { displayName: "Jira", url: "https://www.atlassian.com/software/jira", logo: { url: JIRA_LOGO_URL }, color: "#deebff", tagline: "Read and update Jira Cloud work items", description: "Connect Jira Cloud to let agents search issues, inspect project work, and prepare approval-backed work item updates." }; }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).setCallback(callback, nonce, validateNativeReturnUrl(options?.returnUrl, this.env));
    return { url: `${getBaseUrl(this.env)}/${id.toString()}/${nonce}` };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return SUPPORTED_RESOURCES; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export class UserAccount extends DurableObject<Env> {
  #refreshPromise: Promise<string> | undefined;

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string, returnUrl?: string): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredGrant>("grant")) this.ctx.storage.kv.put("oauthCleanupAt", Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_TTL_MS, stage: "initiation", returnUrl });
    await this.#scheduleAlarm();
  }
  async beginOAuthFlow(nonce: string): Promise<{ oauthNonce: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) return null;
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: oauthNonce, expiresAt: Date.now() + NONCE_TTL_MS, stage: "oauth", returnUrl: stored.returnUrl });
    return { oauthNonce };
  }
  async acceptAuthCode(code: string, nonce: string): Promise<OAuthOutcome | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) return null;
    // Consume the code once, but retain its nonce to fence off newer flows and revocation during I/O.
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, stage: "exchanging" });
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) throw new Error("The Jira Gatekeeper is not configured.");
    if (!this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback")) throw new Error("Authorization callback expired.");
    const grant = await exchangeAuthCode(code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, `${getBaseUrl(this.env)}/oauth`);
    // Atlassian's consent callback carries only `code` and `state`, never the site the user consented
    // to, and accessible-resources has no documented order. The site is therefore always chosen here.
    const discovered = await getAccessibleResources(grant.accessToken).catch(() => null);
    const identity = await getAtlassianIdentity(grant.accessToken).catch(() => null);
    const current = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!current || current.stage !== "exchanging" || current.value !== nonce || Date.now() >= current.expiresAt) return null;
    this.ctx.storage.kv.delete("nonce");
    if (!discovered) return { error: "Could not verify the Jira sites for this authorization. Reconnect and try again; the existing connection has not changed." };
    const sites = discovered;
    const previous = this.ctx.storage.kv.get<StoredSite>("selectedSite");
    if (previous) {
      // Reconnecting keeps the site it already uses, or fails: it must never move bindings to another site.
      if (!sites.some(site => site.id === previous.cloudId && site.url === previous.url)) {
        return { error: `This authorization does not include ${new URL(previous.url).hostname}, the Jira site this connection uses. Authorize that site again, or connect a new Jira account to use a different site.` };
      }
      return this.#completeConnection(grant, sites, identity, previous, stored.returnUrl);
    }
    if (sites.length === 0) return { error: "This authorization includes no Jira sites. Reconnect and authorize a Jira site." };
    if (sites.length === 1) return this.#completeConnection(grant, sites, identity, storedSite(sites[0]), stored.returnUrl);
    const selectionNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: selectionNonce, expiresAt: Date.now() + NONCE_TTL_MS, stage: "selection", returnUrl: stored.returnUrl });
    this.ctx.storage.kv.put<StoredPendingSelection>("pendingSelection", { grant, sites, identity });
    this.ctx.storage.kv.put("oauthCleanupAt", Date.now() + CONNECT_TIMEOUT_MS);
    await this.#scheduleAlarm();
    return { selection: { nonce: selectionNonce, sites: sites.map(storedSite) } };
  }
  async selectSite(cloudId: string, nonce: string): Promise<OAuthOutcome | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    const pending = this.ctx.storage.kv.get<StoredPendingSelection>("pendingSelection");
    if (!stored || !pending || stored.stage !== "selection" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) return null;
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("pendingSelection");
    const site = pending.sites.find(candidate => candidate.id === cloudId);
    if (!site) return { error: "That Jira site is not part of this authorization. Start the Jira connection again." };
    return this.#completeConnection(pending.grant, pending.sites, pending.identity, storedSite(site), stored.returnUrl);
  }
  async #completeConnection(grant: StoredGrant, sites: AccessibleResource[], identity: AtlassianIdentity | null, selected: StoredSite, returnUrl?: string): Promise<OAuthOutcome> {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Authorization callback expired.");
    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    this.ctx.storage.kv.delete("reconnecting");
    const generation = this.#nextGrantGeneration();
    this.ctx.storage.kv.put<StoredGrant>("grant", grant);
    this.ctx.storage.kv.put("sites", sites);
    if (identity) this.ctx.storage.kv.put("identity", identity);
    this.ctx.storage.kv.put<StoredSite>("selectedSite", selected);
    this.ctx.storage.kv.delete("credentialsExpiredNotified");
    this.ctx.storage.kv.delete("credentialsExpiredPending");
    this.ctx.storage.kv.delete("credentialsExpiredGeneration");
    this.ctx.storage.kv.delete("oauthCleanupAt");
    this.ctx.storage.kv.delete("pendingSelection");
    this.ctx.storage.kv.delete("refreshRetryAt");
    this.ctx.storage.kv.delete("refreshRestoredNotified");
    this.ctx.storage.kv.delete("refreshRestoredPending");
    this.ctx.storage.kv.delete("refreshRestoredGeneration");
    this.ctx.storage.kv.delete("callbackRetryAt");
    await this.#scheduleAlarm();
    if (!isSameStoredGrant(this.ctx.storage.kv.get<StoredGrant>("grant"), grant) || this.ctx.storage.kv.get<number>("grantGeneration") !== generation) return { error: "This authorization was superseded or revoked. Return to Connections and try again." };
    const expiresAt = grant.refreshToken ? undefined : new Date(grant.expiresAt);
    if (reconnecting) {
      this.ctx.storage.kv.put("refreshRestoredPending", true);
      this.ctx.storage.kv.put("refreshRestoredGeneration", generation);
      await this.#notifyRefreshRestoredOnce(expiresAt);
    } else {
      try {
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } }), expiresAt);
        if (this.ctx.storage.kv.get<number>("grantGeneration") === generation && this.ctx.storage.kv.get("grant")) this.ctx.storage.kv.put("refreshRestoredNotified", generation);
      } catch (error) {
        if (this.ctx.storage.kv.get<number>("grantGeneration") !== generation || !this.ctx.storage.kv.get("grant")) throw error;
        this.ctx.storage.kv.delete("grant");
        this.ctx.storage.kv.delete("sites");
        this.ctx.storage.kv.delete("identity");
        this.ctx.storage.kv.delete("selectedSite");
        this.ctx.storage.kv.delete("refreshRestoredNotified");
        this.ctx.storage.kv.delete("refreshRestoredGeneration");
        this.ctx.storage.kv.put("oauthCleanupAt", Date.now() + CONNECT_TIMEOUT_MS);
        await this.#scheduleAlarm();
        throw error;
      }
    }
    return { returnUrl };
  }
  async getAccessToken(): Promise<string> {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant) throw new JiraApiError(401, "No Jira credentials set.");
    if (Date.now() < grant.expiresAt - TOKEN_REFRESH_SKEW_MS) return grant.accessToken;
    const retryAt = this.ctx.storage.kv.get<number>("refreshRetryAt");
    if (retryAt !== undefined && Date.now() < retryAt && Date.now() < grant.expiresAt) return grant.accessToken;
    return this.#refreshPromise ??= this.#refreshAccessToken().finally(() => { this.#refreshPromise = undefined; });
  }
  async #refreshAccessToken(): Promise<string> {
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (!grant) throw new JiraApiError(401, "No Jira credentials set.");
    if (Date.now() < grant.expiresAt - TOKEN_REFRESH_SKEW_MS) return grant.accessToken;
    if (!grant.refreshToken || !this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      if (!grant.refreshToken) await this.#markCredentialsExpired();
      throw new JiraApiError(401, "Jira credentials must be reconnected.");
    }
    try {
      const next = await refreshAccessToken(grant.refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      const current = this.ctx.storage.kv.get<StoredGrant>("grant");
      if (!isSameStoredGrant(current, grant)) {
        if (!current) throw new JiraApiError(401, "Jira credentials were revoked during refresh.");
        return current.accessToken;
      }
      this.ctx.storage.kv.put<StoredGrant>("grant", next);
      this.ctx.storage.kv.delete("credentialsExpiredNotified");
      this.ctx.storage.kv.delete("refreshRetryAt");
      await this.#scheduleAlarm();
      const generation = this.ctx.storage.kv.get<number>("grantGeneration") ?? 0;
      if (!isSameNotificationGeneration(this.ctx.storage.kv.get("refreshRestoredNotified"), generation)) {
        this.ctx.storage.kv.put("refreshRestoredPending", true);
        this.ctx.storage.kv.put("refreshRestoredGeneration", generation);
        await this.#notifyRefreshRestoredOnce();
      } else {
        this.ctx.storage.kv.delete("refreshRestoredPending");
        this.ctx.storage.kv.delete("refreshRestoredGeneration");
      }
      const latest = this.ctx.storage.kv.get<StoredGrant>("grant");
      if (!latest) throw new JiraApiError(401, "Jira credentials were revoked during refresh.");
      return latest.accessToken;
    } catch (err) {
      const current = this.ctx.storage.kv.get<StoredGrant>("grant");
      if (!isSameStoredGrant(current, grant)) return current?.accessToken ?? Promise.reject(err);
      if (isTerminalRefreshError(err)) await this.#markCredentialsExpired();
      else { this.ctx.storage.kv.put("refreshRetryAt", Date.now() + REFRESH_RETRY_DELAY_MS); await this.#scheduleAlarm(); }
      if (!isTerminalRefreshError(err) && Date.now() < grant.expiresAt) return grant.accessToken;
      throw err;
    }
  }
  async getSites(): Promise<AccessibleResource[]> { return this.ctx.storage.kv.get<AccessibleResource[]>("sites") ?? []; }
  async getIdentity(): Promise<AtlassianIdentity | null> { return this.ctx.storage.kv.get<AtlassianIdentity>("identity") ?? null; }
  /** The one site this connection uses, or null when a legacy multi-site connection must be reconnected. */
  async getSelectedSite(): Promise<AccessibleResource | null> {
    const sites = this.ctx.storage.kv.get<AccessibleResource[]>("sites") ?? [];
    const stored = this.ctx.storage.kv.get<StoredSite>("selectedSite");
    if (stored) return sites.find(site => site.id === stored.cloudId && site.url === stored.url) ?? null;
    // Connections made before site selection migrate only when exactly one site makes the choice unambiguous.
    if (sites.length !== 1) return null;
    this.ctx.storage.kv.put<StoredSite>("selectedSite", storedSite(sites[0]));
    return sites[0];
  }
  /** Token access for a specific site, so capabilities persisted before selection cannot outrun it. */
  async getAccessTokenForSite(cloudId: string): Promise<string> {
    const selected = await this.getSelectedSite();
    if (!selected) throw new JiraApiError(409, NO_SELECTED_SITE);
    if (selected.id !== cloudId) throw new JiraApiError(403, `This Jira connection is limited to ${new URL(selected.url).hostname}. Use a separate Jira connection for a different site.`);
    return this.getAccessToken();
  }
  async getDefaultProject(): Promise<StoredDefaultProject | null> {
    const stored = this.ctx.storage.kv.get<StoredDefaultProject>("defaultProject") ?? null;
    if (!stored) return null;
    const selected = await this.getSelectedSite();
    return selected?.id === stored.cloudId && selected.url === stored.webBase ? stored : null;
  }
  async setDefaultProject(projectUrlInput: string | null): Promise<StoredDefaultProject | null> {
    if (projectUrlInput === null) {
      this.ctx.storage.kv.delete("defaultProject");
      return null;
    }
    const classified = classifyJiraUrl(projectUrlInput);
    if (classified.kind !== "project") throw new JiraApiError(400, "Default Jira project must be a project URL.");
    const site = await this.getSelectedSite();
    if (!site || new URL(site.url).hostname !== classified.host) throw new JiraApiError(403, `Default Jira project must belong to this connection's selected Jira site: ${classified.host}.`);
    const api = new JiraApi({ cloudId: site.id, webBase: site.url, getToken: () => this.getAccessTokenForSite(site.id) });
    const project = await api.getProject(classified.projectKey);
    if (project.key !== classified.projectKey) throw new JiraApiError(400, "Jira returned a different project than requested.");
    const stored: StoredDefaultProject = { cloudId: site.id, webBase: site.url, projectKey: project.key, projectName: project.name };
    this.ctx.storage.kv.put<StoredDefaultProject>("defaultProject", stored);
    return stored;
  }
  async prepareReconnect(nonce: string, returnUrl?: string): Promise<void> { this.ctx.storage.kv.put("reconnecting", true); this.ctx.storage.kv.put("oauthCleanupAt", Date.now() + CONNECT_TIMEOUT_MS); this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_TTL_MS, stage: "initiation", returnUrl }); await this.#scheduleAlarm(); }
  async alarm(): Promise<void> {
    const now = Date.now();
    const cleanupAt = this.ctx.storage.kv.get<number>("oauthCleanupAt");
    if (cleanupAt !== undefined && now >= cleanupAt) {
      if (!this.ctx.storage.kv.get<StoredGrant>("grant")) { this.ctx.storage.deleteAll(); return; }
      this.ctx.storage.kv.delete("nonce");
      this.ctx.storage.kv.delete("pendingSelection");
      this.ctx.storage.kv.delete("reconnecting");
      this.ctx.storage.kv.delete("oauthCleanupAt");
    }
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (grant && now >= tokenRefreshAt(grant)) {
      try { await this.getAccessToken(); }
      catch (error) {
        if (isTerminalRefreshError(error)) return;
        logger.warn("failed to proactively refresh Jira credentials", { event: "oauth.refresh.proactive.failed", error });
      }
    }
    if (this.ctx.storage.kv.get<boolean>("credentialsExpiredPending")) await this.#notifyCredentialsExpired();
    if (this.ctx.storage.kv.get<boolean>("refreshRestoredPending")) await this.#notifyRefreshRestoredOnce();
    await this.#scheduleAlarm();
  }
  async revoke(): Promise<void> { this.ctx.storage.deleteAlarm(); this.ctx.storage.deleteAll(); }
  async #markCredentialsExpired(): Promise<void> {
    const generation = this.ctx.storage.kv.get<number>("grantGeneration") ?? 0;
    this.ctx.storage.kv.delete("grant");
    this.ctx.storage.kv.delete("sites");
    this.ctx.storage.kv.delete("refreshRetryAt");
    this.ctx.storage.kv.delete("refreshRestoredNotified");
    this.ctx.storage.kv.delete("refreshRestoredPending");
    this.ctx.storage.kv.delete("refreshRestoredGeneration");
    this.ctx.storage.kv.put("credentialsExpiredPending", true);
    this.ctx.storage.kv.put("credentialsExpiredGeneration", generation);
    await this.#notifyCredentialsExpired();
    await this.#scheduleAlarm();
  }
  async #notifyCredentialsExpired(): Promise<void> {
    const generation = this.ctx.storage.kv.get<number>("credentialsExpiredGeneration") ?? 0;
    if (isSameNotificationGeneration(this.ctx.storage.kv.get("credentialsExpiredNotified"), generation)) { this.ctx.storage.kv.delete("credentialsExpiredPending"); return; }
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;
    try {
      await callback.credentialsExpired();
      if (this.ctx.storage.kv.get<number>("credentialsExpiredGeneration") === generation && this.ctx.storage.kv.get<boolean>("credentialsExpiredPending")) {
        this.ctx.storage.kv.put("credentialsExpiredNotified", generation);
        this.ctx.storage.kv.delete("credentialsExpiredPending");
        this.ctx.storage.kv.delete("callbackRetryAt");
      }
    } catch {
      if (this.ctx.storage.kv.get<number>("credentialsExpiredGeneration") === generation && this.ctx.storage.kv.get<boolean>("credentialsExpiredPending")) this.ctx.storage.kv.put("callbackRetryAt", Date.now() + CALLBACK_RETRY_DELAY_MS);
    }
  }
  async #notifyRefreshRestoredOnce(expiresAt?: Date): Promise<void> {
    const generation = this.ctx.storage.kv.get<number>("refreshRestoredGeneration") ?? (this.ctx.storage.kv.get<number>("grantGeneration") ?? 0);
    if (isSameNotificationGeneration(this.ctx.storage.kv.get("refreshRestoredNotified"), generation)) { this.ctx.storage.kv.delete("refreshRestoredPending"); return; }
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;
    try {
      await callback.credentialsRestored(expiresAt);
      if ((this.ctx.storage.kv.get<number>("refreshRestoredGeneration") ?? generation) === generation && this.ctx.storage.kv.get<boolean>("refreshRestoredPending")) {
        this.ctx.storage.kv.put("refreshRestoredNotified", generation);
        this.ctx.storage.kv.delete("refreshRestoredPending");
        this.ctx.storage.kv.delete("callbackRetryAt");
      }
    } catch {
      if ((this.ctx.storage.kv.get<number>("refreshRestoredGeneration") ?? generation) === generation && this.ctx.storage.kv.get<boolean>("refreshRestoredPending")) this.ctx.storage.kv.put("callbackRetryAt", Date.now() + CALLBACK_RETRY_DELAY_MS);
    }
  }
  #nextGrantGeneration(): number {
    const next = (this.ctx.storage.kv.get<number>("grantGeneration") ?? 0) + 1;
    this.ctx.storage.kv.put("grantGeneration", next);
    return next;
  }
  async #scheduleAlarm(): Promise<void> {
    const candidates = [this.ctx.storage.kv.get<number>("oauthCleanupAt")];
    if (this.ctx.storage.kv.get<boolean>("credentialsExpiredPending") || this.ctx.storage.kv.get<boolean>("refreshRestoredPending")) candidates.push(this.ctx.storage.kv.get<number>("callbackRetryAt") ?? Date.now() + CALLBACK_RETRY_DELAY_MS);
    const grant = this.ctx.storage.kv.get<StoredGrant>("grant");
    if (grant?.refreshToken && this.env.CLIENT_ID && this.env.CLIENT_SECRET) candidates.push(this.ctx.storage.kv.get<number>("refreshRetryAt") ?? tokenRefreshAt(grant));
    const next = candidates.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .reduce<number | undefined>((earliest, value) => earliest === undefined || value < earliest ? value : earliest, undefined);
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, { userObjectId: string }> implements GatekeeperUser {
  #account() { return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId)); }
  async #siteForHost(host: string): Promise<AccessibleResource> {
    assertAtlassianHost(host);
    const site = await requireSelectedSite(this.#account());
    if (new URL(site.url).hostname !== host) throw new JiraApiError(404, `This Jira connection is limited to ${new URL(site.url).hostname} and has no access to ${host}.`);
    return site;
  }
  async describe(): Promise<AccountDescription> {
    const [identity, site] = await Promise.all([this.#account().getIdentity(), this.#account().getSelectedSite()]);
    return { displayName: identity?.name ?? site?.name ?? "Jira", uniqueName: identity?.email, avatar: { url: identity?.picture ?? site?.avatarUrl ?? "" }, providesUi: { title: "Jira", icon: { url: JIRA_LOGO_URL }, composition: { kind: "work-items", role: "jira", embeddedOnly: true } }, codingSessionResourceUrls: site ? [site.url] : [] };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return SUPPORTED_RESOURCES; }
  async getAuthenticatedEmail(): Promise<string | null> { return (await this.#account().getIdentity())?.email ?? null; }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async reconnect(options?: GatekeeperReconnectOptions): Promise<{ url: string }> { const nonce = generateNonce(); await this.#account().prepareReconnect(nonce, validateNativeReturnUrl(options?.returnUrl, this.env)); return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` }; }
  async revoke(): Promise<void> { await this.#account().revoke(); }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.JiraVerifier({ props: { userObjectId: this.ctx.props.userObjectId } }); }
  async startAppUi(): Promise<ResourceConfiguratorFrame> { return { iframeHtml: SITE_CONFIGURATOR_HTML, ui: new RpcStub(new JiraWorkItemsManagementUI(this.#account())) }; }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    const scope = selectedSiteScope(this.#account());
    const ui = new JiraConfiguratorUI(scope.getSites, scope.getToken, { getDefaultProject: async () => { const project = await this.#account().getDefaultProject(); return project ? defaultProjectOption(project) : null; }, setDefaultProject: async (url) => { const project = await this.#account().setDefaultProject(url); return project ? defaultProjectOption(project) : null; } });
    if (pattern === PROJECT_RESOURCE.urlPattern) return { iframeHtml: PROJECT_CONFIGURATOR_HTML, ui: new RpcStub(ui) };
    if (pattern === ISSUE_RESOURCE.urlPattern) return { iframeHtml: ISSUE_CONFIGURATOR_HTML, ui: new RpcStub(ui) };
    return { iframeHtml: SITE_CONFIGURATOR_HTML, ui: new RpcStub(ui) };
  }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    const classified = classifyJiraUrl(url);
    const site = await this.#siteForHost(classified.host);
    const base = { userObjectId: this.ctx.props.userObjectId, cloudId: site.id, webBase: site.url };
    if (classified.kind === "issue") return { class: this.ctx.exports.JiraIssueGatekeeperImpl({ props: { ...base, issueKey: classified.issueKey, projectKey: classified.projectKey } }), resource: ISSUE_RESOURCE };
    if (classified.kind === "project") return { class: this.ctx.exports.JiraProjectGatekeeperImpl({ props: { ...base, projectKey: classified.projectKey } }), resource: PROJECT_RESOURCE };
    return { class: this.ctx.exports.JiraSiteGatekeeperImpl({ props: base }), resource: SITE_RESOURCE };
  }
}

export interface JiraVerifierApi extends GatekeeperUserVerifier { hasProjectAccess(host: string, projectKey: string): Promise<boolean>; hasIssueAccess(host: string, issueKey: string): Promise<boolean>; }

type JiraAccountApi = Pick<UserAccount, "getSites" | "getAccessToken" | "getAccessTokenForSite" | "getSelectedSite" | "getIdentity" | "getDefaultProject" | "setDefaultProject">;

@validateRpc()
export class JiraWorkItemsManagementUI extends RpcTarget implements WorkItemsManagementApi, JiraConfiguratorRpc {
  constructor(readonly account: JiraAccountApi) { super(); }
  #configurator(): JiraConfiguratorUI { const scope = selectedSiteScope(this.account); return new JiraConfiguratorUI(scope.getSites, scope.getToken); }
  async listSites(query: string): Promise<ConfiguratorOption[]> { return this.#configurator().listSites(query); }
  async listProjects(query: string): Promise<ConfiguratorOption[]> { return this.#configurator().listProjects(query); }
  async listIssues(query: string): Promise<ConfiguratorOption[]> { return this.#configurator().listIssues(query); }
  async getDefaultProject(): Promise<JiraDefaultProject> { const project = await this.account.getDefaultProject(); return project ? defaultProjectOption(project) : null; }
  async setDefaultProject(projectUrlInput: string | null): Promise<JiraDefaultProject> { const project = await this.account.setDefaultProject(projectUrlInput); return project ? defaultProjectOption(project) : null; }
  async #apiForRef(ref: WorkItemProviderRef): Promise<{ api: JiraApi; site: AccessibleResource; issue: string }> {
    const site = await requireSelectedSite(this.account);
    const refUrl = ref.id.startsWith("http") ? ref.id : (ref as WorkItemProviderRef & { url?: string }).url;
    if (!refUrl?.startsWith("http")) return { site, issue: ref.key ?? ref.id, api: apiForSite(this.account, site) };
    const classified = classifyJiraUrl(refUrl);
    if (classified.kind !== "issue") throw new Error("Jira Work Item refs must identify an issue.");
    if (new URL(site.url).hostname !== classified.host) throw new Error(`This Jira connection is limited to ${new URL(site.url).hostname} and has no access to ${classified.host}.`);
    return { site, issue: classified.issueKey, api: apiForSite(this.account, site) };
  }
  async getCurrentUser(): Promise<WorkItemsCurrentUser> { const identity = await this.account.getIdentity(); return { displayName: identity?.name, uniqueName: identity?.email }; }
  async listSavedViews(): Promise<[]> { return []; }
  async saveSavedView(view: Parameters<WorkItemsManagementApi["saveSavedView"]>[0]) { return view; }
  async deleteSavedView(_id: string): Promise<void> {}
  async getSourceStatuses(): Promise<WorkItemSourceStatuses> { const site = await this.account.getSelectedSite(); let connected = false; let reason = site ? undefined : NO_SELECTED_SITE; if (site) { try { await apiForSite(this.account, site).getCurrentUser(); connected = true; } catch (error) { reason = error instanceof Error ? error.message.slice(0, 256) : "Jira status check failed."; } } return { jira: { configured: true, connected, reason }, zendesk: { configured: false, connected: false, reason: "Zendesk is provided by a separate source; Jira remote linking is disabled without a trusted Zendesk URL." } }; }
  async search(request: WorkItemSearchRequest & { assignedToMe?: boolean }): Promise<WorkItemSearchPage> {
    if (request.source !== "jira" && request.source !== "both") return { items: [], cursors: {}, hasMore: { jira: false } };
    // Cross-project live search stays inside the selected site; other granted sites are never queried.
    const site = await requireSelectedSite(this.account);
    const max = Math.min(Math.max(Math.floor(request.limit ?? 20), 1), 50);
    const starts = parseWorkItemsJiraCursor(request.cursors?.jira);
    const start = Object.hasOwn(starts, site.id) ? starts[site.id] : "";
    const filters = [request.query ? `text ~ ${jqlLiteral(request.query)}` : undefined, request.assignedToMe ? "assignee = currentUser()" : undefined].filter(Boolean);
    const jql = `${filters.join(" AND ")} ORDER BY updated DESC`.trim();
    const page = start === null ? { issues: [], nextPageToken: undefined } : await apiForSite(this.account, site).searchIssues(jql, start || undefined, max);
    return {
      items: page.issues.map(i => toWorkItem(normIssueDetails(site.url, i))),
      cursors: { jira: JSON.stringify({ [site.id]: page.nextPageToken ?? null }) },
      hasMore: { jira: page.nextPageToken !== undefined },
    };
  }
  async item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi> { if (ref.source !== "jira") throw new Error("This source only supports Jira work items."); const { api, site, issue } = await this.#apiForRef(ref); return new JiraWorkItemUI(api, this.account, site.url, issue); }
}

@validateRpc()
export class JiraWorkItemUI extends RpcTarget implements WorkItemManagementApi {
  constructor(readonly api: JiraApi, readonly account: JiraAccountApi, readonly webBase: string, readonly issue: string) { super(); }
  async #details(): Promise<JiraIssueDetails> { return normIssueDetails(this.webBase, await this.api.getIssue(this.issue)); }
  async read(): Promise<WorkItemRead> {
    const detail = await this.#details();
    const comments = (await this.api.listComments(detail.key, 0, 50)).comments.map(normComment).map(c => ({ id: c.id, author: display(c.author), body: c.bodyMarkdown, format: "markdown" as const, providerFormat: "jira-adf" as const, public: true, createdAt: c.created }));
    const transitions = (await this.api.transitions(detail.key)).transitions.map(normTransition).map(toWorkTransition);
    return { detail: { item: toWorkItem(detail) }, comments, activity: [], updateOptions: { source: "jira", id: detail.url, key: detail.key, allowedFields: ["summary", "description", "assigneeAccountId", "labels", "components", "priority", "dueDate"] }, transitions, attachments: (await this.listJiraAttachments()).map(toWorkAttachment) };
  }
  async listJiraAttachments(): Promise<JiraAttachment[]> { return (await this.api.getIssue(this.issue)).fields.attachment?.map(normAttachment) ?? []; }
  async readAttachment(id: string): Promise<WorkItemAttachmentContent> { const a = (await this.listJiraAttachments()).find(x => x.id === id); if (!a) throw new Error("Attachment not found."); const raw = (await this.api.getIssue(this.issue)).fields.attachment?.find(x => x.id === id); if (!raw?.content) throw new Error("Attachment has no downloadable content URL."); return { data: new Uint8Array(await this.api.downloadAttachment(raw.content)), name: a.filename, contentType: a.mimeType }; }
  async mediaCapabilities(): Promise<WorkItemMediaCapabilities> { return { uploads: true, uploadMode: "immediate-issue", targets: ["comment"], inlineImages: false, inlineVideos: false, maxBytes: MAX_UPLOAD_BYTES, acceptedContentTypes: ACCEPTED_UPLOAD_TYPES }; }
  async createAttachment(input: WorkItemAttachmentUploadInput): Promise<WorkItemAttachmentUploadResult> { const upload = validateUpload(input); const created = await this.api.uploadAttachment(this.issue, upload.filename, upload.mimeType, upload.bytes); const attachment = normAttachment(created[0] ?? { id: "unknown", filename: upload.filename, mimeType: upload.mimeType, size: upload.bytes.byteLength }); return { attachment: toWorkAttachment(attachment), uploadMode: "immediate-issue", target: input.target, supportsInline: false }; }
  async addComment(input: { body: string }): Promise<WorkItemDetail> { await this.api.addComment(this.issue, markdownToAdf(validateComment(input.body))); return { item: toWorkItem(await this.#details()) }; }
  async updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail> { await this.api.updateIssue(this.issue, updateFields(parseWorkItemPatch(patch))); return { item: toWorkItem(await this.#details()) }; }
  async transition(transitionId: string): Promise<WorkItemDetail> { await this.api.transition(this.issue, { transition: { id: transitionId } }); return { item: toWorkItem(await this.#details()) }; }
  async linkTo(_other: WorkItemProviderRef): Promise<WorkItemLinkResult> { throw new Error("Jira Work Items linking is unsupported until the paired provider supplies a trusted target URL."); }
  [Symbol.dispose](): void {}
}

export const JIRA_CODING_TOOLS: McpToolInfo[] = [
  { name: "jira_search", title: "Search Jira", description: "Search Jira issues with bounded text query. Results are paginated: when hasMore is true, call again with the returned nextCursor and the same query to read the next page.", mode: "read", classifiedBy: "server-annotation", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 20 }, cursor: { type: "string", minLength: 1, maxLength: MAX_SEARCH_CURSOR_CHARS } } } },
  { name: "jira_read_issue", title: "Read Jira issue", description: "Read one Jira issue by key.", mode: "read", classifiedBy: "server-annotation", inputSchema: { type: "object", additionalProperties: false, required: ["issue"], properties: { issue: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]+-[0-9]+$" } } } },
  { name: "jira_create_issue", title: "Create Jira issue", description: "Stage creation of one Jira issue. projectKey may be omitted when this connection has a default Jira project.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", additionalProperties: false, required: ["issueType", "summary"], properties: { projectKey: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{1,31}$" }, issueType: { type: "string", minLength: 1, maxLength: 80 }, summary: { type: "string", minLength: 1, maxLength: 500 }, descriptionMarkdown: { type: "string", maxLength: 20000 } } } },
  { name: "jira_add_comment", title: "Add Jira comment", description: "Stage a Jira issue comment and return a pending action id.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", additionalProperties: false, required: ["issue", "body"], properties: { issue: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]+-[0-9]+$" }, body: { type: "string", minLength: 1, maxLength: MAX_COMMENT_CHARS } } } },
  { name: "jira_update_issue", title: "Update Jira issue", description: "Stage allowlisted Jira issue field updates.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", additionalProperties: false, required: ["issue", "fields"], properties: { issue: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]+-[0-9]+$" }, fields: { type: "object", additionalProperties: false, properties: { summary: { type: "string", maxLength: 500 }, descriptionMarkdown: { anyOf: [{ type: "string", maxLength: 20000 }, { type: "null" }] }, assigneeAccountId: { anyOf: [{ type: "string", maxLength: 128 }, { type: "null" }] }, labels: { type: "array", maxItems: 20, items: { type: "string", maxLength: 80 } }, components: { type: "array", maxItems: 20, items: { type: "string", maxLength: 80 } }, priority: { anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }] }, dueDate: { anyOf: [{ type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }, { type: "null" }] } } } } } },
  { name: "jira_transition_issue", title: "Transition Jira issue", description: "Stage a Jira workflow transition by transition ID.", mode: "action", classifiedBy: "default", inputSchema: { type: "object", additionalProperties: false, required: ["issue", "transitionId"], properties: { issue: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]+-[0-9]+$" }, transitionId: { type: "string", pattern: "^[0-9]+$" } } } },
];

type CodingToolScope = { projectKey?: string; issueKey?: string };
type CodingToolDefaults = { projectKey?: string };

async function assertIssueInScope(api: JiraApi, issue: string, scope: CodingToolScope): Promise<RawIssue> {
  const raw = await api.getIssue(issue);
  if (scope.issueKey && raw.key !== scope.issueKey) throw new Error("Issue is outside this Jira issue binding.");
  if (scope.projectKey && raw.fields.project?.key !== scope.projectKey) throw new Error("Issue is outside this Jira project binding.");
  return raw;
}

async function callCodingTool(stager: ActionStager, api: JiraApi, queue: RpcStub<ApprovalQueue>, webBase: string, scope: CodingToolScope, name: string, args: Record<string, unknown>, defaults?: CodingToolDefaults): Promise<McpCallResult> {
  if (name === "jira_search") {
    const query = typeof args.query === "string" ? args.query.slice(0, 500) : "";
    const limit = parseToolLimit(args.limit);
    const jql = scope.issueKey ? `issuekey = ${jqlLiteral(normalizeJiraIssueKey(scope.issueKey))}${query ? ` AND text ~ ${jqlLiteral(query)}` : ""}` : scopedJql(scope.projectKey, { text: query || undefined });
    const page = await api.searchIssues(jql, parseSearchCursor(args.cursor, jql), limit);
    const items = page.issues.map(i => toWorkItem(normIssueDetails(webBase, i)));
    await queue.authorizeObservation({ title: "Coding session Jira search", description: `Returned ${items.length} Jira issues to a coding session.`, prohibitAllSharing: true });
    return okResult({ items, hasMore: page.nextPageToken !== undefined, ...(page.nextPageToken ? { nextCursor: encodeSearchCursor(jql, page.nextPageToken) } : {}) });
  }
  if (name === "jira_read_issue") { const issue = parseIssueKeyOrId(String(args.issue ?? "")); const item = toWorkItem(normIssueDetails(webBase, await assertIssueInScope(api, issue, scope))); await queue.authorizeObservation({ title: "Coding session Jira issue read", description: `Read Jira issue ${item.key ?? issue} for a coding session.` }); return okResult(item); }
  const issue = "issue" in args ? parseIssueKeyOrId(String(args.issue ?? "")) : undefined;
  let action: StoredAction | undefined;
  if (name === "jira_create_issue") { if (scope.issueKey) throw new Error("Issue-scoped Jira bindings cannot create issues."); const projectKey = normalizeJiraProjectKey(scope.projectKey ?? (typeof args.projectKey === "string" && args.projectKey.trim() ? parseToolString(args, "projectKey", /^[A-Za-z][A-Za-z0-9_]{1,31}$/, 32) : defaults?.projectKey ?? "")); action = { kind: "create", fields: issueFields({ projectKey, issueType: parseToolString(args, "issueType", undefined, 80), summary: parseToolString(args, "summary", undefined, 500), descriptionMarkdown: typeof args.descriptionMarkdown === "string" ? args.descriptionMarkdown : undefined }, projectKey) }; }
  else if (name === "jira_add_comment" && issue) { await assertIssueInScope(api, issue, scope); action = { kind: "comment", issue, markdown: validateComment(parseToolString(args, "body", undefined, MAX_COMMENT_CHARS)) }; }
  else if (name === "jira_update_issue" && issue) { await assertIssueInScope(api, issue, scope); action = { kind: "update", issue, fields: updateFields(parseToolPatch(args)) }; }
  else if (name === "jira_transition_issue" && issue) { await assertIssueInScope(api, issue, scope); action = { kind: "transition", issue, body: { transition: { id: parseToolString(args, "transitionId", /^[0-9]+$/, 30) } } }; }
  if (action) { const id = await stager.stageAction(queue, action, `Jira ${action.kind}`, `Apply Jira ${action.kind} action from coding session.`, action.kind === "comment"); return { status: "pending", actionId: id, message: `Jira ${action.kind} staged as action ${id}. Poll for the stored outcome after approval.` }; }
  return { status: "failed", message: `Unknown Jira coding-session tool: ${name}` };
}

@validateRpc()
export class JiraVerifier extends WorkerEntrypoint<Env, { userObjectId: string }> implements JiraVerifierApi {
  #account() { return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId)); }
  async #api(host: string): Promise<JiraApi> { const site = await this.#account().getSelectedSite(); if (!site || new URL(site.url).hostname !== host) return Promise.reject(new JiraApiError(404, "No site access")); return apiForSite(this.#account(), site); }
  async hasProjectAccess(host: string, projectKey: string): Promise<boolean> { try { await (await this.#api(host)).getProject(projectKey); return true; } catch (e) { if (e instanceof JiraApiError && [401, 403, 404].includes(e.status)) return false; throw e; } }
  async hasIssueAccess(host: string, issueKey: string): Promise<boolean> { try { await (await this.#api(host)).getIssue(issueKey); return true; } catch (e) { if (e instanceof JiraApiError && [401, 403, 404].includes(e.status)) return false; throw e; } }
}

class JiraCursor<T> extends RpcTarget implements Cursor<T> {
  #start = 0;
  constructor(readonly pageSize: number, readonly fetchPage: (startAt: number, max: number) => Promise<T[]>) { super(); }
  async next(): Promise<T[] | null> { const rows = await this.fetchPage(this.#start, this.pageSize); if (rows.length === 0) return null; this.#start += rows.length; return rows; }
}

type StoredAction = { kind: "create"; fields: Record<string, unknown> } | { kind: "update"; issue: string; fields: Record<string, unknown> } | { kind: "transition"; issue: string; body: Record<string, unknown> } | { kind: "comment"; issue: string; markdown: string } | { kind: "upload"; issue: string; filename: string; mimeType?: string; bytes: ArrayBuffer } | { kind: "link"; issue: string; globalId: string; url: string; title: string; summary?: string };

// Quote outbound values as data, including embedded Markdown fences, rather than letting a
// comment or filename change the approval's presentation. Never include attachment bytes.
function actionPreview(action: StoredAction): string {
  const payload = action.kind === "upload"
    ? { issue: action.issue, filename: action.filename, mimeType: action.mimeType ?? "application/octet-stream", sizeBytes: action.bytes.byteLength }
    : action.kind === "create" ? { fields: action.fields }
    : action.kind === "update" ? { issue: action.issue, fields: action.fields }
    : action.kind === "transition" ? { issue: action.issue, ...action.body }
    : action.kind === "comment" ? { issue: action.issue, comment: action.markdown }
    : { issue: action.issue, globalId: action.globalId, url: action.url, title: action.title, summary: action.summary };
  const text = JSON.stringify(payload, null, 2);
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = "`".repeat(fenceLength);
  return `### Outbound Jira values\n\n${fence}json\n${text}\n${fence}`;
}
type ActionStager = {
  stageAction(queue: RpcStub<ApprovalQueue>, action: StoredAction, title: string, description: string, auto?: boolean): Promise<number>;
  getCodingSessionActionResult(actionId: number): Promise<McpCallResult>;
};
abstract class BaseGatekeeper<Session, Props extends BaseProps = BaseProps> extends DurableObject<Env, Props> implements Gatekeeper<Session> {
  // Only distinguishes a live request from an orphan after restart. The durable claim remains
  // the authority for replay prevention; losing this set must never make an action retryable.
  #applyingActions = new Set<number>();
  // Bindings persist their cloudId, so tokens are requested for that site: one made before site
  // selection, or for a site the connection no longer uses, is refused rather than silently served.
  #api(): JiraApi { return new JiraApi({ cloudId: this.ctx.props.cloudId, webBase: this.ctx.props.webBase, getToken: () => this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId)).getAccessTokenForSite(this.ctx.props.cloudId) }); }
  protected api(): JiraApi { return this.#api(); }
  protected async defaultProjectForThisSite(): Promise<CodingToolDefaults> {
    const project = await this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId)).getDefaultProject();
    return project?.cloudId === this.ctx.props.cloudId && project.webBase === this.ctx.props.webBase ? { projectKey: project.projectKey } : {};
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<{ tag: string; label: string }[]> { return [{ tag: "jira.comment", label: "Add Jira comment" }]; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<Session> { return this.makeSession(queue.dup()); }
  abstract describe(): Promise<ResourceDescription>;
  abstract addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  protected abstract makeSession(queue: RpcStub<ApprovalQueue>): Session;
  protected async observe(queue: RpcStub<ObservationAuthorizer>, title: string, description: string, privateOnly = false): Promise<void> { await queue.authorizeObservation({ title, description, ...(privateOnly ? { prohibitAllSharing: true } : {}) }); }
  async stageAction(queue: RpcStub<ApprovalQueue>, action: StoredAction, title: string, description: string, auto = false): Promise<number> {
    const id = (this.ctx.storage.kv.get<number>("nextAction") ?? 1);
    this.ctx.storage.kv.put("nextAction", id + 1);
    this.ctx.storage.kv.put<StagedActionState>(`action:${id}`, { state: "pending", action, createdAt: Date.now() });
    try {
      await queue.submitAction(id, { title, description: `${description}\n\n${actionPreview(action)}`, implementsRevert: false, actionKind: { tag: action.kind === "comment" ? "jira.comment" : `jira.${action.kind}`, label: title }, autoApprovable: auto, awaitDecision: action.kind !== "comment" });
    } catch (error) {
      // submitAction may have dispatched applyAction before its response failed. Keep any
      // claimed/terminal state so the write cannot be mistaken for an unattempted action.
      if (this.ctx.storage.kv.get<StagedActionState>(`action:${id}`)?.state === "pending") this.ctx.storage.kv.delete(`action:${id}`);
      logger.warn("failed to submit Jira action", { event: "action.submit.failed", actionId: id, error });
      throw error;
    }
    return id;
  }
  async applyAction(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid Jira action id.");
    const staged = this.ctx.storage.kv.get<StagedActionState>(`action:${id}`);
    if (!staged) throw new Error("Jira action is unavailable. Verify the issue before submitting a new action.");
    if (staged.state === "approved") return;
    if (staged.state === "rejected") throw new Error("Jira action was rejected. Submit a new action if the change is still intended.");
    if (staged.state !== "pending") throw new Error("Jira action is in progress or its outcome is ambiguous. Read the issue and its history before submitting a new action; do not blindly repeat the write.");
    // Claim synchronously before scope checks, token RPCs, or HTTP can interleave. A durable
    // applying state also prevents replay after restart; it is not safe to expire this claim.
    this.ctx.storage.kv.put<StagedActionState>(`action:${id}`, { ...staged, state: "applying" });
    this.#applyingActions.add(id);
    try {
      const action = staged.action;
      await this.assertActionInScope(action);
      let result: unknown = { ok: true, actionId: id };
      if (action.kind === "create") { const created = await this.api().createIssue(action.fields); result = { id: created.id, key: created.key, url: issueUrl(this.ctx.props.webBase, created.key) }; }
      else if (action.kind === "update") await this.api().updateIssue(action.issue, action.fields);
      else if (action.kind === "transition") await this.api().transition(action.issue, action.body);
      else if (action.kind === "comment") result = await this.api().addComment(action.issue, markdownToAdf(action.markdown));
      else if (action.kind === "upload") result = await this.api().uploadAttachment(action.issue, action.filename, action.mimeType, action.bytes);
      else result = await this.api().createRemoteLink(action.issue, { globalId: action.globalId, object: { url: action.url, title: action.title, summary: action.summary } });
      this.ctx.storage.kv.put<StagedActionState>(`action:${id}`, { ...staged, state: "approved", result });
    } catch (error) {
      this.ctx.storage.kv.put<StagedActionState>(`action:${id}`, { ...staged, state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.#applyingActions.delete(id);
    }
  }
  async rejectAction(id: number): Promise<void> {
    const staged = this.ctx.storage.kv.get<StagedActionState>(`action:${id}`);
    if (!staged || staged.state === "rejected") return;
    if (staged.state !== "pending") throw new Error("Jira action has already been claimed. Verify its outcome in Jira; it cannot be rejected now.");
    this.ctx.storage.kv.put<StagedActionState>(`action:${id}`, { ...staged, state: "rejected" });
  }
  getCodingSessionActionResult(actionId: number): Promise<McpCallResult> { return Promise.resolve(storedActionResult(this.ctx.storage.kv.get<StagedActionState>(`action:${actionId}`), actionId, this.#applyingActions.has(actionId))); }
  getActionResult(actionId: number): Promise<McpCallResult> { return this.getCodingSessionActionResult(actionId); }
  async revertAction(_id: number): Promise<{ message: string }> { return { message: "Jira changes are not automatically reverted; use Jira's history to undo the approved change if needed." }; }
  protected async assertActionInScope(_action: StoredAction): Promise<void> {}
  protected async assertIssueActionProject(action: StoredAction, projectKey: string): Promise<void> {
    if (action.kind === "create") {
      const key = (action.fields.project as { key?: unknown } | undefined)?.key;
      if (key !== projectKey) throw new Error("Jira issue creation is outside this project.");
      return;
    }
    const issue = await this.api().getIssue(action.issue);
    if (issue.fields.project?.key !== projectKey) throw new Error("Jira action is outside this project.");
  }
  protected async addCheckedObserver(verifier: Fetcher<GatekeeperUserVerifier>, check: (v: Fetcher<JiraVerifierApi>) => Promise<boolean>): Promise<void> { if (!await check(verifier as unknown as Fetcher<JiraVerifierApi>)) throw new Error("Observer cannot access this Jira resource."); }
  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
export class JiraSiteGatekeeperImpl extends BaseGatekeeper<JiraSite, BaseProps> {
  async describe(): Promise<ResourceDescription> { return { url: this.ctx.props.webBase, title: new URL(this.ctx.props.webBase).hostname, snippet: "Jira site", suggestedBindingName: "JIRA_SITE", tsType: "JiraSite" }; }
  protected makeSession(queue: RpcStub<ApprovalQueue>): JiraSite { return new JiraSiteSession(this, this.api(), queue, this.ctx.props.webBase, () => this.defaultProjectForThisSite()); }
  async addObserver(): Promise<void> { throw new Error("Jira site bindings are private-only; connect a project or issue to share observations."); }
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>) { await this.observe(authorizer, "Inspect Jira site catalog", "Listed connected Jira site resource metadata.", true); return boundAgentCatalog([{ id: this.ctx.props.webBase, title: new URL(this.ctx.props.webBase).hostname, description: "Jira Cloud site available through this private binding." }]); }
}

@validateRpc()
export class JiraProjectGatekeeperImpl extends BaseGatekeeper<JiraProject, ProjectProps> {
  #props(): ProjectProps { return this.ctx.props; }
  async describe(): Promise<ResourceDescription> { const p = await this.api().getProject(this.#props().projectKey); return { url: projectUrl(this.ctx.props.webBase, p.key), title: p.name, snippet: `Jira project ${p.key}`, suggestedBindingName: "JIRA_PROJECT", tsType: "JiraProject" }; }
  protected makeSession(queue: RpcStub<ApprovalQueue>): JiraProject { return new JiraProjectSession(this, this.api(), queue, this.ctx.props.webBase, this.#props().projectKey); }
  async addObserver(): Promise<void> { throw new Error("Jira project bindings are private-only until full project-scoped observer tracking is implemented; connect a single issue to share observations."); }
  protected override async assertActionInScope(action: StoredAction): Promise<void> { await this.assertIssueActionProject(action, this.#props().projectKey); }
}

@validateRpc()
export class JiraIssueGatekeeperImpl extends BaseGatekeeper<JiraIssue, IssueProps> {
  #props(): IssueProps { return this.ctx.props; }
  async describe(): Promise<ResourceDescription> { const issue = await this.api().getIssue(this.#props().issueKey); return { url: issueUrl(this.ctx.props.webBase, issue.key), title: issue.fields.summary ?? issue.key, snippet: `Jira issue ${issue.key}`, suggestedBindingName: "JIRA_ISSUE", tsType: "JiraIssue" }; }
  protected makeSession(queue: RpcStub<ApprovalQueue>): JiraIssue { return new JiraIssueSession(this, this.api(), queue, this.ctx.props.webBase, this.#props().issueKey); }
  async addObserver(_id: string, verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> { await this.addCheckedObserver(verifier, v => v.hasIssueAccess(new URL(this.ctx.props.webBase).hostname, this.#props().issueKey)); }
  protected override async assertActionInScope(action: StoredAction): Promise<void> {
    if (action.kind === "create") throw new Error("Jira issue bindings cannot create issues.");
    const issue = await this.api().getIssue(action.issue);
    if (issue.key !== this.#props().issueKey) throw new Error("Jira action is outside this issue binding.");
  }
}

class JiraSiteSession extends RpcTarget implements JiraSite {
  constructor(readonly owner: BaseGatekeeper<JiraSite, BaseProps>, readonly api: JiraApi, readonly queue: RpcStub<ApprovalQueue>, readonly webBase: string, readonly defaults: () => Promise<CodingToolDefaults>) { super(); }
  getCurrentUser(): Promise<JiraUser> { return observeCurrentUser(this.api, this.queue); }
  async getMetadata(): Promise<JiraSiteMetadata> { await this.queue.authorizeObservation({ title: "Read Jira site metadata", description: `Read metadata for ${this.webBase}`, prohibitAllSharing: true }); return { cloudId: this.api.options.cloudId, name: new URL(this.webBase).hostname, url: this.webBase }; }
  async listProjects(options?: JiraPageOptions): Promise<Cursor<JiraProjectSummary>> { return new JiraCursor(clampPageSize(options?.maxResults), async (start, max) => { const page = await this.api.listProjects(start, max); const rows = (page.values ?? []).map(p => normProject(this.webBase, p)); await this.queue.authorizeObservation({ title: "List Jira projects", description: `Listed ${rows.length} Jira projects on ${this.webBase}.`, prohibitAllSharing: true }); return rows; }); }
  async getProject(id: string): Promise<JiraProject> { const p = await this.api.getProject(parseProjectKeyOrId(id)); await this.queue.authorizeObservation({ title: "Open Jira project", description: `Opened Jira project ${p.key}.`, prohibitAllSharing: true }); return new JiraProjectSession(this.owner, this.api, this.queue.dup(), this.webBase, p.key); }
  async searchIssues(options: JiraIssueSearchOptions): Promise<Cursor<JiraIssueSummary>> { return issueSearchCursor(this.api, this.queue, this.webBase, undefined, options, true); }
  async getIssue(id: string): Promise<JiraIssue> { const issue = await this.api.getIssue(parseIssueKeyOrId(id)); await this.queue.authorizeObservation({ title: "Open Jira issue", description: `Opened Jira issue ${issue.key}.`, prohibitAllSharing: true }); return new JiraIssueSession(this.owner, this.api, this.queue.dup(), this.webBase, issue.key); }
  async createIssue(options: JiraCreateIssueOptions): Promise<JiraIssue> { const projectKey = options.projectKey ?? (await this.defaults()).projectKey; if (!projectKey) throw new Error("projectKey is required on a JiraSite session unless a default Jira project is configured."); using project = new JiraProjectSession(this.owner, this.api, this.queue.dup(), this.webBase, normalizeJiraProjectKey(projectKey)); return await project.createIssue(options); }
  async findUsers(query: string): Promise<JiraUser[]> { const users = (await this.api.assignableUsers(undefined, query)).map(normUser).filter(Boolean) as JiraUser[]; await this.queue.authorizeObservation({ title: "Find Jira users", description: `Found ${users.length} Jira users matching a query.`, prohibitAllSharing: true }); return users; }
  async listTools(): Promise<McpToolInfo[]> { return JIRA_CODING_TOOLS; }
  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult> { return callCodingTool(this.owner, this.api, this.queue, this.webBase, {}, name, args ?? {}, await this.defaults()); }
  getCodingSessionActionResult(actionId: number): Promise<McpCallResult> { return this.owner.getCodingSessionActionResult(actionId); }
  getActionResult(actionId: number): Promise<McpCallResult> { return this.getCodingSessionActionResult(actionId); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

class JiraProjectSession extends RpcTarget implements JiraProject {
  constructor(readonly owner: ActionStager, readonly api: JiraApi, readonly queue: RpcStub<ApprovalQueue>, readonly webBase: string, readonly projectKey: string) { super(); }
  getCurrentUser(): Promise<JiraUser> { return observeCurrentUser(this.api, this.queue); }
  async getMetadata(): Promise<JiraProjectMetadata> { const p = await this.api.getProject(this.projectKey); await this.queue.authorizeObservation({ title: "Read Jira project", description: `Read Jira project ${p.key}.`, prohibitAllSharing: true }); return { ...normProject(this.webBase, p), description: p.description, lead: normUser(p.lead) }; }
  async searchIssues(options?: JiraIssueSearchOptions): Promise<Cursor<JiraIssueSummary>> { return issueSearchCursor(this.api, this.queue, this.webBase, this.projectKey, options, true); }
  async getIssue(id: string): Promise<JiraIssue> { const issue = await this.api.getIssue(parseIssueKeyOrId(id)); if ((issue.fields.project?.key ?? "") !== this.projectKey) throw new Error("Issue is outside this project."); await this.queue.authorizeObservation({ title: "Open Jira issue", description: `Opened ${issue.key} in ${this.projectKey}.`, prohibitAllSharing: true }); return new JiraIssueSession(this.owner, this.api, this.queue.dup(), this.webBase, issue.key); }
  async createIssue(options: JiraCreateIssueOptions): Promise<JiraIssue> { const fields = issueFields(options, this.projectKey); const id = await this.owner.stageAction(this.queue, { kind: "create", fields }, `Create Jira issue ${options.summary}`, `Create a ${options.issueType} in ${this.projectKey}: ${options.summary}`); return new JiraPendingIssueSession(this.owner, this.api, this.queue.dup(), this.webBase, id); }
  async listIssueTypes(): Promise<JiraIssueType[]> { const p = await this.api.issueTypes(this.projectKey); await this.queue.authorizeObservation({ title: "List Jira issue types", description: `Listed issue types for ${this.projectKey}.`, prohibitAllSharing: true }); return p.issueTypes?.map(t => ({ id: t.id, name: t.name, description: t.description, subtask: t.subtask })) ?? []; }
  async listStatuses(): Promise<JiraStatus[]> { const statuses = (await this.api.statuses(this.projectKey)).map(s => normStatus(s)!); await this.queue.authorizeObservation({ title: "List Jira statuses", description: `Listed statuses for ${this.projectKey}.`, prohibitAllSharing: true }); return statuses; }
  async findUsers(query: string): Promise<JiraUser[]> { const users = (await this.api.assignableUsers(this.projectKey, query)).map(normUser).filter(Boolean) as JiraUser[]; await this.queue.authorizeObservation({ title: "Find Jira project users", description: `Found ${users.length} assignable users in ${this.projectKey}.`, prohibitAllSharing: true }); return users; }
  async listTools(): Promise<McpToolInfo[]> { return JIRA_CODING_TOOLS; }
  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult> { return callCodingTool(this.owner, this.api, this.queue, this.webBase, { projectKey: this.projectKey }, name, args ?? {}); }
  getCodingSessionActionResult(actionId: number): Promise<McpCallResult> { return this.owner.getCodingSessionActionResult(actionId); }
  getActionResult(actionId: number): Promise<McpCallResult> { return this.getCodingSessionActionResult(actionId); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

class JiraPendingIssueSession extends RpcTarget implements JiraIssue {
  constructor(private readonly owner: ActionStager, private readonly api: JiraApi, private readonly queue: RpcStub<ApprovalQueue>, private readonly webBase: string, private readonly actionId: number) { super(); }
  async #resolve(): Promise<JiraIssue> {
    const outcome = await this.owner.getCodingSessionActionResult(this.actionId);
    if (outcome.status === "pending") throw new Error("Jira issue creation is pending. Retry this same issue session after creation completes; do not create another issue.");
    if (outcome.status !== "ok") throw new Error(`Jira issue creation ${outcome.status}. ${outcome.message ?? "This issue session cannot be used."}`);
    const result = (outcome.structuredContent as { result?: { key?: string } } | undefined)?.result;
    if (!result?.key) throw new Error("Jira issue creation completed without an issue key.");
    return new JiraIssueSession(this.owner, this.api, this.queue, this.webBase, normalizeJiraIssueKey(result.key));
  }
  async getDetails() { return (await this.#resolve()).getDetails(); }
  async listTransitions() { return (await this.#resolve()).listTransitions(); }
  async update(fields: JiraIssueUpdate) { return (await this.#resolve()).update(fields); }
  async transition(transition: string, options?: JiraTransitionOptions) { return (await this.#resolve()).transition(transition, options); }
  async listComments(options?: JiraPageOptions) { return (await this.#resolve()).listComments(options); }
  async addComment(markdown: string) { return (await this.#resolve()).addComment(markdown); }
  async listAttachments() { return (await this.#resolve()).listAttachments(); }
  async downloadAttachment(id: string) { return (await this.#resolve()).downloadAttachment(id); }
  async uploadAttachment(options: JiraUploadAttachmentOptions) { return (await this.#resolve()).uploadAttachment(options); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

class JiraIssueSession extends RpcTarget implements JiraIssue {
  constructor(readonly owner: ActionStager, readonly api: JiraApi, readonly queue: RpcStub<ApprovalQueue>, readonly webBase: string, readonly issueKey: string) { super(); }
  async getDetails(): Promise<JiraIssueDetails> { const issue = await this.api.getIssue(this.issueKey); await this.queue.authorizeObservation({ title: "Read Jira issue", description: `Read Jira issue ${issue.key}: ${issue.fields.summary ?? ""}` }); return normIssueDetails(this.webBase, issue); }
  async listTransitions(): Promise<JiraTransition[]> { const result = (await this.api.transitions(this.issueKey)).transitions.map(normTransition); await this.queue.authorizeObservation({ title: "List Jira transitions", description: `Listed workflow transitions for ${this.issueKey}.` }); return result; }
  async update(fields: JiraIssueUpdate): Promise<void> { const f = updateFields(fields); await this.#stage({ kind: "update", issue: this.issueKey, fields: f }, `Update Jira issue ${this.issueKey}`, `Update fields on Jira issue ${this.issueKey}.`); }
  async transition(transition: string, options?: JiraTransitionOptions): Promise<void> { const transitions = await this.api.transitions(this.issueKey); const match = transitions.transitions.find(t => t.id === transition || t.name.toLowerCase() === transition.toLowerCase()); if (!match) throw new Error(`No transition named or ID ${transition} is currently available.`); const body: Record<string, unknown> = { transition: { id: match.id } }; if (options?.fields) body.fields = updateFields(options.fields); if (options?.commentMarkdown) body.update = { comment: [{ add: { body: markdownToAdf(options.commentMarkdown) } }] }; await this.#stage({ kind: "transition", issue: this.issueKey, body }, `Transition Jira issue ${this.issueKey}`, `Move Jira issue ${this.issueKey} using transition ${match.name}.`); }
  async listComments(options?: JiraPageOptions): Promise<Cursor<JiraComment>> { return new JiraCursor(clampPageSize(options?.maxResults), async (start, max) => { const rows = (await this.api.listComments(this.issueKey, start, max)).comments.map(normComment); await this.queue.authorizeObservation({ title: "List Jira comments", description: `Listed ${rows.length} comments on ${this.issueKey}.` }); return rows; }); }
  async addComment(markdown: string): Promise<void> { const body = validateComment(markdown); await this.#stage({ kind: "comment", issue: this.issueKey, markdown: body }, `Comment on Jira issue ${this.issueKey}`, body.slice(0, 500), true); }
  async listAttachments(): Promise<JiraAttachment[]> { const issue = await this.api.getIssue(this.issueKey); const rows = issue.fields.attachment?.map(normAttachment) ?? []; await this.queue.authorizeObservation({ title: "List Jira attachments", description: `Listed ${rows.length} attachments on ${this.issueKey}.` }); return rows; }
  async downloadAttachment(id: string): Promise<JiraAttachmentDownload> { const issue = await this.api.getIssue(this.issueKey); const meta = issue.fields.attachment?.find(a => a.id === id); if (!meta?.content) throw new Error("Attachment not found on this issue."); const bytes = await this.api.downloadAttachment(meta.content, MAX_ATTACHMENT_DOWNLOAD_BYTES); await this.queue.authorizeObservation({ title: "Download Jira attachment", description: `Downloaded attachment ${meta.filename} from ${this.issueKey}.` }); return { id, filename: meta.filename, mimeType: meta.mimeType, bytes }; }
  async uploadAttachment(options: JiraUploadAttachmentOptions): Promise<JiraAttachment> { const upload = validateUpload(options); await this.#stage({ kind: "upload", issue: this.issueKey, filename: upload.filename, mimeType: upload.mimeType, bytes: upload.bytes }, `Upload Jira attachment ${upload.filename}`, `Upload ${upload.filename} to ${this.issueKey}.`); return { id: "pending", filename: upload.filename, mimeType: upload.mimeType, size: upload.bytes.byteLength }; }
  async #stage(action: StoredAction, title: string, description: string, auto = false): Promise<void> { await this.owner.stageAction(this.queue, action, title, description, auto); }
  async listTools(): Promise<McpToolInfo[]> { return JIRA_CODING_TOOLS; }
  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult> { return callCodingTool(this.owner, this.api, this.queue, this.webBase, { issueKey: this.issueKey }, name, args ?? {}); }
  getCodingSessionActionResult(actionId: number): Promise<McpCallResult> { return this.owner.getCodingSessionActionResult(actionId); }
  getActionResult(actionId: number): Promise<McpCallResult> { return this.getCodingSessionActionResult(actionId); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

function issueSearchCursor(api: JiraApi, queue: RpcStub<ApprovalQueue>, webBase: string, projectKey: string | undefined, options: JiraIssueSearchOptions | undefined, privateOnly: boolean): Cursor<JiraIssueSummary> {
  const jql = scopedJql(projectKey, options);
  const max = clampPageSize(options?.maxResults);
  const authorizer = queue.dup();
  return new class extends RpcTarget implements Cursor<JiraIssueSummary> {
    #token: string | undefined;
    #done = false;
    #busy = false;
    async next(): Promise<JiraIssueSummary[] | null> {
      if (this.#busy) throw new Error("Await the previous Jira cursor next() call before advancing.");
      if (this.#done) return null;
      this.#busy = true;
      try {
        const result = await api.searchIssues(jql, this.#token, max);
        if (projectKey && result.issues.some(issue => issue.fields.project?.key !== projectKey)) throw new Error("Jira search returned an issue outside this project.");
        const rows = result.issues.map(i => normIssue(webBase, i));
        await authorizer.authorizeObservation({ title: "Search Jira issues", description: `Returned ${rows.length} Jira issues${projectKey ? ` in ${projectKey}` : ""}.`, ...(privateOnly ? { prohibitAllSharing: true } : {}) });
        this.#token = result.nextPageToken;
        this.#done = !result.nextPageToken;
        return rows.length || !this.#done ? rows : null;
      } finally { this.#busy = false; }
    }
    [Symbol.dispose](): void { this.#done = true; authorizer[Symbol.dispose](); }
  }();
}

async function observeCurrentUser(api: JiraApi, queue: RpcStub<ApprovalQueue>): Promise<JiraUser> {
  const user = normUser(await api.getCurrentUser());
  if (!user?.accountId || user.accountId === "unknown") throw new Error("Jira did not return the connected user's account ID.");
  await queue.authorizeObservation({ title: "Read connected Jira user", description: "Read the connected Jira user's profile and account ID.", prohibitAllSharing: true });
  return user;
}
