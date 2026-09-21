// Thin wrapper around Linear's GraphQL API plus the OAuth token endpoints.
//
// This module knows nothing about the gatekeeper's approval/session machinery — it just speaks
// HTTP to Linear and returns lightly-typed response nodes. Normalization into the Session API's
// public shapes happens in `linear.ts`.

const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const OAUTH_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const REQUEST_TIMEOUT_MS = 30_000;

export { OAUTH_AUTHORIZE_URL };

export class LinearApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "LinearApiError";
    this.status = status;
    this.details = details;
    // Linear returns 401 for a bad bearer token, a GraphQL "AUTHENTICATION_ERROR", or an
    // "invalid_grant" from the token endpoint when a refresh token is revoked/expired. Treat all
    // of these as auth errors so the gatekeeper can prompt the user to reconnect.
    this.isAuthError =
      status === 401 ||
      (typeof message === "string" && /authentication|unauthor|invalid_grant/i.test(message));
  }
}

// ---------------------------------------------------------------------------
// OAuth

export type LinearOAuthGrant = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
  scopes: string[];
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string | string[];
  error?: string;
  error_description?: string;
};

function parseScopes(scope: string | string[] | undefined): string[] {
  if (!scope) return [];
  if (Array.isArray(scope)) return scope;
  // New apps return a space- or comma-separated string.
  return scope.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function grantFromTokenResponse(result: TokenResponse): LinearOAuthGrant {
  if (!result.access_token || result.error) {
    const message =
      [result.error, result.error_description].filter(Boolean).join(": ") ||
      "Linear OAuth token exchange failed";
    throw new LinearApiError(400, message, result);
  }
  // Linear access tokens last ~24h; refresh a little early. Default to 23h if unspecified.
  const expiresInSec = result.expires_in ?? 23 * 3600;
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + expiresInSec * 1000,
    scopes: parseScopes(result.scope),
  };
}

async function postForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
  if (!response.ok || !parsed) {
    const message =
      [parsed?.error, parsed?.error_description].filter(Boolean).join(": ") ||
      `${response.status} ${response.statusText}`;
    throw new LinearApiError(response.status, message, parsed);
  }
  return parsed;
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scopes.join(","));
  url.searchParams.set("state", options.state);
  // Always show consent so users can pick which workspace to connect.
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeAuthCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<LinearOAuthGrant> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
  return grantFromTokenResponse(await postForm(OAUTH_TOKEN_URL, body));
}

export async function refreshAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinearOAuthGrant> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
  const grant = grantFromTokenResponse(await postForm(OAUTH_TOKEN_URL, body));
  // Linear may omit a new refresh token; keep the old one in that case.
  if (!grant.refreshToken) grant.refreshToken = options.refreshToken;
  return grant;
}

export async function revokeToken(token: string): Promise<void> {
  const body = new URLSearchParams({ token });
  const response = await fetch(OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 400 means "already revoked" — not worth surfacing.
  if (!response.ok && response.status !== 400) {
    throw new LinearApiError(response.status, `Failed to revoke token: ${response.statusText}`);
  }
}

// ---------------------------------------------------------------------------
// Raw GraphQL response node shapes (only the fields we request)

export type RawConnection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type RawUser = {
  id: string;
  name: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  active?: boolean | null;
};

export type RawOrganization = {
  id: string;
  name: string;
  urlKey: string;
};

export type RawTeam = {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  private?: boolean | null;
};

export type RawWorkflowState = {
  id: string;
  name: string;
  type: string;
  color?: string | null;
  position?: number | null;
};

export type RawLabel = {
  id: string;
  name: string;
  color?: string | null;
};

export type RawProject = {
  id: string;
  name: string;
  url: string;
  state?: string | null;
  progress?: number | null;
  startDate?: string | null;
  targetDate?: string | null;
  lead?: RawUser | null;
  /**
   * Only populated by the workspace-wide listProjects() query (via PROJECT_LIST_FIELDS), so the
   * workspace-binding observer tracking can attribute each project to the team(s) that gate access
   * to it. Omitted everywhere a project is embedded (e.g. on an issue), where it is not needed.
   */
  teams?: RawConnection<{ id: string }> | null;
};

export type RawCycle = {
  id: string;
  number: number;
  name?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type RawIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description?: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  dueDate?: string | null;
  branchName?: string | null;
  state?: RawWorkflowState | null;
  assignee?: RawUser | null;
  creator?: RawUser | null;
  labels?: RawConnection<RawLabel> | null;
  team: RawTeam;
  project?: RawProject | null;
  parent?: { id: string; identifier: string; url: string; title: string } | null;
  cycle?: RawCycle | null;
};

export type RawComment = {
  id: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt?: string | null;
  user?: RawUser | null;
};

// ---------------------------------------------------------------------------
// GraphQL fragments

const USER_FIELDS = `id name displayName email avatarUrl active`;
const TEAM_FIELDS = `id key name description private`;
const STATE_FIELDS = `id name type color position`;
const LABEL_FIELDS = `id name color`;
const PROJECT_FIELDS = `id name url state progress startDate targetDate lead { ${USER_FIELDS} }`;
// Used only by the workspace-wide listProjects() query: also pulls the teams that gate access to
// each project, so the workspace-binding observer tracking knows which teams a project listing
// reveals. (Team-scoped project listings already know their team, so they use PROJECT_FIELDS.)
const PROJECT_LIST_FIELDS = `${PROJECT_FIELDS} teams(first: 50) {
  nodes { id }
  pageInfo { hasNextPage endCursor }
}`;
const CYCLE_FIELDS = `id number name startsAt endsAt`;

const ISSUE_SUMMARY_FIELDS = `
  id identifier url title priority createdAt updatedAt completedAt canceledAt dueDate
  state { ${STATE_FIELDS} }
  assignee { ${USER_FIELDS} }
  labels { nodes { ${LABEL_FIELDS} } }
  team { ${TEAM_FIELDS} }
  project { ${PROJECT_FIELDS} }
`;

const ISSUE_DETAIL_FIELDS = `
  ${ISSUE_SUMMARY_FIELDS}
  description branchName
  creator { ${USER_FIELDS} }
  parent { id identifier url title }
  cycle { ${CYCLE_FIELDS} }
`;

const COMMENT_FIELDS = `id body url createdAt updatedAt user { ${USER_FIELDS} }`;

/** Linear input types */
export type IssueCreateInput = {
  teamId: string;
  title: string;
  description?: string;
  stateId?: string;
  assigneeId?: string;
  labelIds?: string[];
  priority?: number;
  projectId?: string;
  dueDate?: string;
  parentId?: string;
};

export type IssueUpdateInput = {
  title?: string;
  description?: string;
  stateId?: string;
  assigneeId?: string | null;
  priority?: number;
  labelIds?: string[];
  projectId?: string | null;
  dueDate?: string | null;
  parentId?: string | null;
};

// ---------------------------------------------------------------------------
// The API client

export class LinearApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.#getToken();
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401) {
      throw new LinearApiError(401, "Linear rejected the access token.");
    }

    const json = (await response.json().catch(() => undefined)) as
      | { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> }
      | undefined;

    if (!json) {
      throw new LinearApiError(response.status, `Linear returned an unparseable response.`);
    }

    if (json.errors && json.errors.length > 0) {
      const first = json.errors[0];
      const code = first.extensions?.code ?? "";
      const status = /AUTHENTICATION|FORBIDDEN/i.test(code) ? 401 : (response.ok ? 400 : response.status);
      throw new LinearApiError(status, first.message, json.errors);
    }

    if (!response.ok) {
      throw new LinearApiError(response.status, `${response.status} ${response.statusText}`);
    }

    if (json.data === undefined) {
      throw new LinearApiError(response.status, "Linear returned no data.");
    }
    return json.data;
  }

  // ---- Observations -------------------------------------------------------

  async getViewer(): Promise<{ user: RawUser; organization: RawOrganization }> {
    const data = await this.graphql<{ viewer: RawUser; organization: RawOrganization }>(
      `query { viewer { ${USER_FIELDS} } organization { id name urlKey } }`,
    );
    return { user: data.viewer, organization: data.organization };
  }

  async getOrganization(): Promise<RawOrganization> {
    const data = await this.graphql<{ organization: RawOrganization }>(
      `query { organization { id name urlKey } }`,
    );
    return data.organization;
  }

  async listTeams(options: { first: number; after?: string; includeArchived?: boolean }): Promise<RawConnection<RawTeam>> {
    const data = await this.graphql<{ teams: RawConnection<RawTeam> }>(
      `query($first: Int!, $after: String, $includeArchived: Boolean) {
        teams(first: $first, after: $after, includeArchived: $includeArchived) {
          nodes { ${TEAM_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: options.first, after: options.after, includeArchived: options.includeArchived ?? false },
    );
    return data.teams;
  }

  /**
   * Resolve a team by its UUID or its key (e.g. "ENG"). Returns null if not found.
   *
   * Linear's `id` comparator validates that its value is a UUID and rejects the whole query with
   * an "Argument Validation Error" otherwise, so we must filter by `key` (not `id`) for non-UUID
   * inputs rather than OR-ing both clauses.
   */
  async findTeam(keyOrId: string): Promise<RawTeam | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyOrId);
    const filter = isUuid ? { id: { eq: keyOrId } } : { key: { eqIgnoreCase: keyOrId } };
    const data = await this.graphql<{ teams: RawConnection<RawTeam> }>(
      `query($filter: TeamFilter) {
        teams(first: 2, filter: $filter) { nodes { ${TEAM_FIELDS} } pageInfo { hasNextPage endCursor } }
      }`,
      { filter },
    );
    return data.teams.nodes[0] ?? null;
  }

  async listWorkflowStates(teamId: string): Promise<RawWorkflowState[]> {
    const data = await this.graphql<{ team: { states: RawConnection<RawWorkflowState> } }>(
      `query($id: String!) {
        team(id: $id) { states(first: 100) { nodes { ${STATE_FIELDS} } pageInfo { hasNextPage endCursor } } }
      }`,
      { id: teamId },
    );
    return data.team.states.nodes;
  }

  async listLabels(teamId: string): Promise<RawLabel[]> {
    const data = await this.graphql<{ team: { labels: RawConnection<RawLabel> } }>(
      `query($id: String!) {
        team(id: $id) { labels(first: 250) { nodes { ${LABEL_FIELDS} } pageInfo { hasNextPage endCursor } } }
      }`,
      { id: teamId },
    );
    return data.team.labels.nodes;
  }

  async listTeamMembers(teamId: string): Promise<RawUser[]> {
    const data = await this.graphql<{ team: { members: RawConnection<RawUser> } }>(
      `query($id: String!) {
        team(id: $id) { members(first: 250) { nodes { ${USER_FIELDS} } pageInfo { hasNextPage endCursor } } }
      }`,
      { id: teamId },
    );
    return data.team.members.nodes;
  }

  async listUsers(options: { first: number; filter?: unknown }): Promise<RawUser[]> {
    const data = await this.graphql<{ users: RawConnection<RawUser> }>(
      `query($first: Int!, $filter: UserFilter) {
        users(first: $first, filter: $filter) { nodes { ${USER_FIELDS} } pageInfo { hasNextPage endCursor } }
      }`,
      { first: options.first, filter: options.filter },
    );
    return data.users.nodes;
  }

  async listProjects(
    scope: { teamId?: string },
    options: { first: number; after?: string; includeArchived?: boolean },
  ): Promise<RawConnection<RawProject>> {
    if (scope.teamId) {
      const data = await this.graphql<{ team: { projects: RawConnection<RawProject> } }>(
        `query($id: String!, $first: Int!, $after: String, $includeArchived: Boolean) {
          team(id: $id) {
            projects(first: $first, after: $after, includeArchived: $includeArchived) {
              nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: scope.teamId, first: options.first, after: options.after, includeArchived: options.includeArchived ?? false },
      );
      return data.team.projects;
    }
    const data = await this.graphql<{ projects: RawConnection<RawProject> }>(
      `query($first: Int!, $after: String, $includeArchived: Boolean) {
        projects(first: $first, after: $after, includeArchived: $includeArchived) {
          nodes { ${PROJECT_LIST_FIELDS} } pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: options.first, after: options.after, includeArchived: options.includeArchived ?? false },
    );
    await Promise.all(data.projects.nodes.map(async project => {
      const teams = project.teams;
      if (!teams) return;

      while (teams.pageInfo.hasNextPage) {
        const after = teams.pageInfo.endCursor;
        if (!after) throw new LinearApiError(500, "Linear returned an invalid project teams cursor.");
        const page = await this.#listProjectTeams(project.id, after);
        teams.nodes.push(...page.nodes);
        teams.pageInfo = page.pageInfo;
      }
    }));
    return data.projects;
  }

  async #listProjectTeams(projectId: string, after: string): Promise<RawConnection<{ id: string }>> {
    const data = await this.graphql<{ project: { teams: RawConnection<{ id: string }> } }>(
      `query($id: String!, $after: String!) {
        project(id: $id) {
          teams(first: 50, after: $after) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: projectId, after },
    );
    return data.project.teams;
  }

  async listCycles(teamId: string, options: { first: number; after?: string }): Promise<RawConnection<RawCycle>> {
    const data = await this.graphql<{ team: { cycles: RawConnection<RawCycle> } }>(
      `query($id: String!, $first: Int!, $after: String) {
        team(id: $id) {
          cycles(first: $first, after: $after) { nodes { ${CYCLE_FIELDS} } pageInfo { hasNextPage endCursor } }
        }
      }`,
      { id: teamId, first: options.first, after: options.after },
    );
    return data.team.cycles;
  }

  async listIssues(options: {
    first: number;
    after?: string;
    filter?: unknown;
    orderBy?: "createdAt" | "updatedAt";
    includeArchived?: boolean;
  }): Promise<RawConnection<RawIssue>> {
    const data = await this.graphql<{ issues: RawConnection<RawIssue> }>(
      `query($first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy, $includeArchived: Boolean) {
        issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy, includeArchived: $includeArchived) {
          nodes { ${ISSUE_SUMMARY_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        first: options.first,
        after: options.after,
        filter: options.filter,
        orderBy: options.orderBy ?? "updatedAt",
        includeArchived: options.includeArchived ?? false,
      },
    );
    return data.issues;
  }

  async searchIssues(options: {
    term: string;
    first: number;
    after?: string;
    filter?: unknown;
    includeArchived?: boolean;
  }): Promise<RawConnection<RawIssue>> {
    const data = await this.graphql<{ searchIssues: RawConnection<RawIssue> }>(
      `query($term: String!, $first: Int!, $after: String, $filter: IssueFilter, $includeArchived: Boolean) {
        searchIssues(term: $term, first: $first, after: $after, filter: $filter, includeArchived: $includeArchived) {
          nodes { ${ISSUE_SUMMARY_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        term: options.term,
        first: options.first,
        after: options.after,
        filter: options.filter,
        includeArchived: options.includeArchived ?? false,
      },
    );
    return data.searchIssues;
  }

  /**
   * Fetch a single issue by UUID or human identifier (e.g. "ENG-123"). Returns null if not found.
   * Linear's `issue(id:)` query accepts both forms.
   */
  async getIssue(idOrIdentifier: string): Promise<RawIssue | null> {
    const data = await this.graphql<{ issue: RawIssue | null }>(
      `query($id: String!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
      { id: idOrIdentifier },
    );
    return data.issue;
  }

  async listComments(issueId: string, options: { first: number; after?: string }): Promise<RawConnection<RawComment>> {
    const data = await this.graphql<{ issue: { comments: RawConnection<RawComment> } }>(
      `query($id: String!, $first: Int!, $after: String) {
        issue(id: $id) {
          comments(first: $first, after: $after) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }
        }
      }`,
      { id: issueId, first: options.first, after: options.after },
    );
    return data.issue.comments;
  }

  async getProject(projectId: string): Promise<RawProject | null> {
    const data = await this.graphql<{ project: RawProject | null }>(
      `query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
      { id: projectId },
    );
    return data.project;
  }

  // ---- Mutations ----------------------------------------------------------

  async createIssue(input: IssueCreateInput): Promise<RawIssue> {
    const data = await this.graphql<{ issueCreate: { success: boolean; issue: RawIssue } }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_DETAIL_FIELDS} } }
      }`,
      { input },
    );
    if (!data.issueCreate.success) throw new LinearApiError(400, "Linear refused to create the issue.");
    return data.issueCreate.issue;
  }

  async updateIssue(issueId: string, input: IssueUpdateInput): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issueId, input },
    );
    if (!data.issueUpdate.success) throw new LinearApiError(400, "Linear refused to update the issue.");
  }

  async setIssueArchived(issueId: string, archived: boolean): Promise<void> {
    const mutation = archived ? "issueArchive" : "issueUnarchive";
    const data = await this.graphql<Record<string, { success: boolean }>>(
      `mutation($id: String!) { ${mutation}(id: $id) { success } }`,
      { id: issueId },
    );
    if (!data[mutation].success) {
      throw new LinearApiError(400, `Linear refused to ${archived ? "archive" : "unarchive"} the issue.`);
    }
  }

  async createComment(issueId: string, body: string): Promise<RawComment> {
    const data = await this.graphql<{ commentCreate: { success: boolean; comment: RawComment } }>(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
      }`,
      { input: { issueId, body } },
    );
    if (!data.commentCreate.success) throw new LinearApiError(400, "Linear refused to create the comment.");
    return data.commentCreate.comment;
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.graphql<{ commentDelete: { success: boolean } }>(
      `mutation($id: String!) { commentDelete(id: $id) { success } }`,
      { id: commentId },
    );
  }

  async createLabel(input: { teamId: string; name: string; color?: string; description?: string }): Promise<RawLabel> {
    const data = await this.graphql<{ issueLabelCreate: { success: boolean; issueLabel: RawLabel } }>(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { ${LABEL_FIELDS} } }
      }`,
      { input },
    );
    if (!data.issueLabelCreate.success) throw new LinearApiError(400, "Linear refused to create the label.");
    return data.issueLabelCreate.issueLabel;
  }

  async deleteIssue(issueId: string): Promise<void> {
    await this.graphql<{ issueDelete: { success: boolean } }>(
      `mutation($id: String!) { issueDelete(id: $id) { success } }`,
      { id: issueId },
    );
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.graphql<{ issueLabelDelete: { success: boolean } }>(
      `mutation($id: String!) { issueLabelDelete(id: $id) { success } }`,
      { id: labelId },
    );
  }
}
