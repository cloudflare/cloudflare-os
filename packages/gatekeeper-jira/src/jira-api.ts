const ATLASSIAN_AUTH = "https://auth.atlassian.com";
const ATLASSIAN_API = "https://api.atlassian.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_BODY_BYTES = 128 * 1024;
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 256 * 1024;

/** OAuth scopes for Jira Cloud REST API v3 through Atlassian 3LO. */
export const JIRA_SCOPES = [
  "read:me", "offline_access",
  "read:jira-user", "read:jira-work", "write:jira-work",
  "read:project:jira", "read:issue:jira", "write:issue:jira",
  "read:comment:jira", "write:comment:jira",
  "read:attachment:jira", "write:attachment:jira", "read:avatar:jira",
  "read:issue-meta:jira", "read:field:jira",
];

export class JiraApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "JiraApiError";
  }
  get isAuthError(): boolean { return this.status === 401 || this.status === 403; }
}

export type OAuthGrant = { accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] };
export type AccessibleResource = { id: string; name: string; url: string; scopes: string[]; avatarUrl?: string };
export type AtlassianIdentity = { accountId: string; name?: string; email?: string; picture?: string };

export type RawUser = { accountId: string; displayName?: string; emailAddress?: string; active?: boolean; avatarUrls?: Record<string, string> };
export type RawProject = { id: string; key: string; name: string; self?: string; projectTypeKey?: string; description?: string; lead?: RawUser; issueTypes?: RawIssueType[] };
export type RawIssueType = { id: string; name: string; description?: string; subtask?: boolean };
export type RawStatus = { id: string; name: string; description?: string; statusCategory?: { key?: string; name?: string } };
export type RawTransition = { id: string; name: string; to?: RawStatus };
export type RawAttachment = { id: string; filename: string; mimeType?: string; size?: number; author?: RawUser; created?: string; content?: string };
export type RawComment = { id: string; author?: RawUser; body?: AdfDoc | string; created?: string; updated?: string };
export type RawIssue = {
  id: string; key: string; self?: string;
  fields: {
    summary?: string; description?: AdfDoc | null; project?: RawProject; issuetype?: RawIssueType;
    status?: RawStatus; priority?: { name?: string } | null; assignee?: RawUser | null; reporter?: RawUser | null;
    labels?: string[]; components?: { name: string }[]; fixVersions?: { name: string }[]; duedate?: string;
    parent?: RawIssue; attachment?: RawAttachment[];
    created?: string; updated?: string;
  };
};
export type AdfDoc = { type: "doc"; version: 1; content?: AdfNode[] };
type AdfNode = { type: string; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[] };

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string | string[]; error?: string; error_description?: string };
const parseScopes = (scope: string | string[] | undefined): string[] => Array.isArray(scope) ? scope : (scope ?? "").split(/[\s,]+/).filter(Boolean);
const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,31}-\d+$/;

export function normalizeJiraProjectKey(input: string): string {
  const key = input.trim().toUpperCase();
  if (!JIRA_PROJECT_KEY_PATTERN.test(key)) throw new JiraApiError(400, `Invalid Jira project key: ${input}`);
  return key;
}

export function normalizeJiraIssueKey(input: string): string {
  const key = input.trim().toUpperCase();
  if (!JIRA_ISSUE_KEY_PATTERN.test(key)) throw new JiraApiError(400, `Invalid Jira issue key: ${input}`);
  return key;
}

export function jqlLiteral(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_JSON_BODY_BYTES) throw new JiraApiError(response.status, "Jira response body exceeded the safety limit");
  return text ? JSON.parse(text) : undefined;
}

async function postToken(body: Record<string, string>): Promise<OAuthGrant> {
  const response = await fetch(`${ATLASSIAN_AUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const parsed = await readJsonBounded(response).catch(() => undefined) as TokenResponse | undefined;
  if (!response.ok || !parsed?.access_token) {
    throw new JiraApiError(response.status, [parsed?.error, parsed?.error_description].filter(Boolean).join(": ") || `Atlassian OAuth failed: ${response.status}`, parsed);
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    scopes: parseScopes(parsed.scope),
  };
}

export function exchangeAuthCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<OAuthGrant> {
  return postToken({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
}
export async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<OAuthGrant> {
  const grant = await postToken({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
  if (!grant.refreshToken) grant.refreshToken = refreshToken;
  return grant;
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const parsed = await readJsonBounded(response).catch(error => { throw new JiraApiError(response.status, `Invalid Jira JSON response for ${url}`, error); });
  if (!response.ok) throw new JiraApiError(response.status, `${response.status} ${response.statusText} for ${url}`, parsed);
  return parsed as T;
}

export const getAccessibleResources = (token: string): Promise<AccessibleResource[]> =>
  getJson<AccessibleResource[]>(`${ATLASSIAN_API}/oauth/token/accessible-resources`, token)
    .then(resources => resources.filter(r => r.url.endsWith(".atlassian.net") && r.scopes.some(s => s.includes("jira"))));

export const getAtlassianIdentity = async (token: string): Promise<AtlassianIdentity> => {
  const me = await getJson<{ account_id: string; name?: string; email?: string; picture?: string }>(`${ATLASSIAN_API}/me`, token);
  return { accountId: me.account_id, name: me.name, email: me.email, picture: me.picture };
};

export function assertAtlassianHost(host: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,61}\.atlassian\.net$/i.test(host)) throw new JiraApiError(400, `Unsupported Jira Cloud host: ${host}`);
}

export type UrlClassification = { kind: "site"; host: string } | { kind: "project"; host: string; projectKey: string } | { kind: "issue"; host: string; issueKey: string; projectKey?: string };
export function classifyJiraUrl(input: string): UrlClassification {
  const url = new URL(input);
  assertAtlassianHost(url.hostname);
  const segments = url.pathname.split("/").filter(Boolean);
  const browseIdx = segments.indexOf("browse");
  if (browseIdx >= 0 && segments[browseIdx + 1]) {
    const key = normalizeJiraIssueKey(segments[browseIdx + 1]);
    return { kind: "issue", host: url.hostname, issueKey: key, projectKey: key.split("-")[0] };
  }
  const projectIdx = segments.indexOf("projects");
  if (projectIdx >= 0 && segments[projectIdx + 1]) return { kind: "project", host: url.hostname, projectKey: normalizeJiraProjectKey(segments[projectIdx + 1]) };
  return { kind: "site", host: url.hostname };
}

export function parseIssueKeyOrId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^[A-Z][A-Z0-9_]{1,31}-\d+$/i.test(trimmed)) return normalizeJiraIssueKey(trimmed);
  const classified = classifyJiraUrl(trimmed);
  if (classified.kind !== "issue") throw new JiraApiError(400, `No Jira issue key found in ${input}`);
  return classified.issueKey;
}

export function parseProjectKeyOrId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^[A-Z][A-Z0-9_]{1,31}$/i.test(trimmed)) return normalizeJiraProjectKey(trimmed);
  const classified = classifyJiraUrl(trimmed);
  if (classified.kind === "project") return classified.projectKey;
  if (classified.kind === "issue" && classified.projectKey) return classified.projectKey;
  throw new JiraApiError(400, `No Jira project key found in ${input}`);
}

const enc = encodeURIComponent;
export class JiraApi {
  constructor(readonly options: { cloudId: string; webBase: string; getToken: () => Promise<string> }) { assertAtlassianHost(new URL(options.webBase).hostname); }
  #url(path: string): string { return `${ATLASSIAN_API}/ex/jira/${this.options.cloudId}/rest/api/3${path}`; }
  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    const token = await this.options.getToken();
    const response = await fetch(this.#url(path), {
      ...init,
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body instanceof FormData ? { "X-Atlassian-Token": "no-check" } : { "Content-Type": "application/json" }), ...init.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = response.status === 204 ? undefined : await readJsonBounded(response).catch(error => { throw new JiraApiError(response.status, `Invalid Jira JSON response for ${path}`, error); });
    if (!response.ok) throw new JiraApiError(response.status, `${response.status} ${response.statusText} for ${path}`, parsed);
    return parsed as T;
  }
  getProject(keyOrId: string): Promise<RawProject> { return this.#request(`/project/${enc(keyOrId)}?expand=description,lead,issueTypes`); }
  listProjects(startAt: number, maxResults: number, query?: string): Promise<{ values?: RawProject[]; isLast?: boolean; startAt?: number; maxResults?: number; total?: number }> {
    const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) });
    if (query) params.set("query", query);
    return this.#request(`/project/search?${params}`);
  }
  searchIssues(jql: string, startAt: number, maxResults: number): Promise<{ issues: RawIssue[]; total?: number; startAt?: number; maxResults?: number }> {
    return this.#request("/search", { method: "POST", body: JSON.stringify({ jql, startAt, maxResults, fields: ["summary", "description", "project", "issuetype", "status", "priority", "assignee", "reporter", "labels", "components", "fixVersions", "duedate", "parent", "attachment", "created", "updated"] }) });
  }
  getIssue(keyOrId: string): Promise<RawIssue> { return this.#request(`/issue/${enc(keyOrId)}?fields=*all`); }
  createIssue(fields: Record<string, unknown>): Promise<RawIssue> { return this.#request("/issue", { method: "POST", body: JSON.stringify({ fields }) }); }
  updateIssue(keyOrId: string, fields: Record<string, unknown>): Promise<void> { return this.#request(`/issue/${enc(keyOrId)}`, { method: "PUT", body: JSON.stringify({ fields }) }); }
  transitions(keyOrId: string): Promise<{ transitions: RawTransition[] }> { return this.#request(`/issue/${enc(keyOrId)}/transitions`); }
  transition(keyOrId: string, body: Record<string, unknown>): Promise<void> { return this.#request(`/issue/${enc(keyOrId)}/transitions`, { method: "POST", body: JSON.stringify(body) }); }
  listComments(keyOrId: string, startAt: number, maxResults: number): Promise<{ comments: RawComment[]; total?: number }> { return this.#request(`/issue/${enc(keyOrId)}/comment?orderBy=created&startAt=${startAt}&maxResults=${maxResults}`); }
  addComment(keyOrId: string, body: AdfDoc): Promise<RawComment> { return this.#request(`/issue/${enc(keyOrId)}/comment`, { method: "POST", body: JSON.stringify({ body }) }); }
  assignableUsers(project: string | undefined, query: string): Promise<RawUser[]> { return this.#request(`/user/assignable/search?${project ? `project=${enc(project)}&` : ""}query=${enc(query)}&maxResults=50`); }
  statuses(projectKeyOrId: string): Promise<RawStatus[]> { return this.#request(`/project/${enc(projectKeyOrId)}/statuses`); }
  issueTypes(projectKeyOrId: string): Promise<RawProject> { return this.getProject(projectKeyOrId); }
  async downloadAttachment(url: string, limit = MAX_ATTACHMENT_DOWNLOAD_BYTES): Promise<ArrayBuffer> {
    const parsed = new URL(url);
    const siteOrigin = new URL(this.options.webBase).origin;
    const expectedApiPath = `/ex/jira/${this.options.cloudId}/`;
    if (parsed.origin !== siteOrigin && (parsed.origin !== ATLASSIAN_API || !parsed.pathname.startsWith(expectedApiPath))) throw new JiraApiError(400, "Unexpected attachment host");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${await this.options.getToken()}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new JiraApiError(response.status, `Attachment download failed: ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > limit) throw new JiraApiError(413, "Attachment exceeds download limit");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) throw new JiraApiError(413, "Attachment exceeds download limit");
    return bytes;
  }
  async uploadAttachment(keyOrId: string, filename: string, mimeType: string | undefined, bytes: ArrayBuffer): Promise<RawAttachment[]> {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: mimeType ?? "application/octet-stream" }), filename);
    return this.#request(`/issue/${enc(keyOrId)}/attachments`, { method: "POST", body: form });
  }
  createRemoteLink(keyOrId: string, body: { globalId: string; object: { url: string; title: string; summary?: string } }): Promise<unknown> {
    return this.#request(`/issue/${enc(keyOrId)}/remotelink`, { method: "POST", body: JSON.stringify(body) });
  }
}

export function markdownToAdf(markdown: string): AdfDoc {
  const content: AdfNode[] = markdown.split(/\n{2,}/).map(block => ({ type: "paragraph", content: block ? [{ type: "text", text: block }] : [] }));
  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [] }] };
}
export function adfToMarkdown(input: AdfDoc | string | null | undefined): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  const walk = (node: AdfNode): string => node.text ?? node.content?.map(walk).join("") ?? "";
  return input.content?.map(walk).join("\n\n") ?? "";
}
