// Thin wrapper around Linear's GraphQL API plus the OAuth token endpoints.
//
// This module knows nothing about the gatekeeper's approval/session machinery — it just speaks
// HTTP to Linear and returns lightly-typed response nodes. Normalization into the Session API's
// public shapes happens in `linear.ts`.
//
// Every request goes through `linearUpstream`, which gives each attempt its timeout, follows no
// redirect, and counts it as a subservice call. Every request is a POST, which the client sends
// once: no query, mutation or token request that failed is sent again.

import { defineUpstream, type CallAnswer } from "@gadgets/gatekeeper-kit/upstream";

const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const OAUTH_REVOKE_URL = "https://api.linear.app/oauth/revoke";

export { OAUTH_AUTHORIZE_URL };

/**
 * The names of the GraphQL requests this gatekeeper sends, one per query or mutation: the
 * operation each is counted under. Every GraphQL request has the same URL, so its name is a
 * literal at its call site.
 */
export const GRAPHQL_OPERATIONS = [
  "viewer.get", "organization.get", "teams.list", "teams.find", "states.list", "labels.list",
  "members.list", "users.list", "team-projects.list", "projects.list", "project-teams.list",
  "cycles.list", "issues.list", "issues.search", "issues.get", "comments.list", "projects.get",
  "issues.create", "issues.update", "issues.archive", "issues.unarchive", "comments.create",
  "comments.delete", "labels.create", "issues.delete", "labels.delete",
] as const;

/** The name of one GraphQL request: a member of `GRAPHQL_OPERATIONS`. */
export type GraphqlOperation = (typeof GRAPHQL_OPERATIONS)[number];

/**
 * The client every request to Linear is sent through. Each is counted as a subservice call to
 * the service `linear` under the source `gatekeeper.linear.api`: a GraphQL request under its
 * `GraphqlOperation`, and a token request under `token.exchange`, `token.refresh` or
 * `token.revoke`.
 */
export const linearUpstream = defineUpstream({ vendorId: "linear" });

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
  if (!isGrant(result)) {
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

// Whether a token response is a grant: an access token, and no OAuth error.
function isGrant(result: TokenResponse): result is TokenResponse & { access_token: string } {
  return Boolean(result.access_token) && !result.error;
}

// Posts a form to the token endpoint. A rejection inside a 2xx is returned, and counted as an
// error of the API; grantFromTokenResponse throws it.
async function postForm(
  operation: "token.exchange" | "token.refresh", url: string, body: URLSearchParams,
): Promise<TokenResponse> {
  return await linearUpstream.read(url, {
    method: "POST",
    operation,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  }, async response => {
    const parsed = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
    if (!response.ok || !parsed) {
      const message =
        [parsed?.error, parsed?.error_description].filter(Boolean).join(": ") ||
        `${response.status} ${response.statusText}`;
      throw new LinearApiError(response.status, message, parsed);
    }
    return parsed;
  }, (parsed): CallAnswer | undefined =>
    isGrant(parsed) ? undefined : { outcome: "error", reason: "api" });
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

/** Exchanges an authorization code for a grant. Counted as `token.exchange`. */
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
  return grantFromTokenResponse(await postForm("token.exchange", OAUTH_TOKEN_URL, body));
}

/** Refreshes a grant, keeping its refresh token where Linear gives no other. Counted as `token.refresh`. */
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
  const grant = grantFromTokenResponse(await postForm("token.refresh", OAUTH_TOKEN_URL, body));
  // Linear may omit a new refresh token; keep the old one in that case.
  if (!grant.refreshToken) grant.refreshToken = options.refreshToken;
  return grant;
}

// Whether a revocation's status is the one Linear answers for a token already revoked: a 400.
function isAlreadyRevoked(status: number): boolean {
  return status === 400;
}

/**
 * Revokes an access or refresh token; one already revoked is no failure. Counted as
 * `token.revoke`: a success for a token already revoked too, with the 400 Linear answered.
 */
export async function revokeToken(token: string): Promise<void> {
  const body = new URLSearchParams({ token });
  const response = await linearUpstream.request(OAUTH_REVOKE_URL, {
    method: "POST",
    operation: "token.revoke",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // The revocation is done, so the attempt is no error of Linear's.
    answer: ({ status }): CallAnswer | undefined =>
      isAlreadyRevoked(status) ? { outcome: "success" } : undefined,
  });
  // A token already revoked is not worth surfacing.
  if (!response.ok && !isAlreadyRevoked(response.status)) {
    throw new LinearApiError(response.status, `Failed to revoke token: ${response.statusText}`);
  }
}

// ---------------------------------------------------------------------------
// Raw GraphQL response node shapes (only the fields we request)

export type RawConnection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

// A connection as Linear answers one: a list of nodes, which may be empty, and, where it says a
// further page follows, the cursor of that page. An answer with no such list, or that promises a
// page it names no cursor for, is refused where the query reads it, within the request, so that
// it is counted an error and no reader meets it: a cursor that drains the listing would ask for
// its first page again.
function connection<T>(answered: RawConnection<T>): RawConnection<T> {
  if (listed(answered).pageInfo?.hasNextPage === true && !answered.pageInfo.endCursor) {
    throw new LinearApiError(502, "Linear answered a page that names no cursor for the page after it.");
  }
  return answered;
}

// A connection whose list of nodes is checked alone: the page of one whose cursor the loop that
// asked for it refuses in words of its own.
function listed<T>(answered: RawConnection<T>): RawConnection<T> {
  if (!Array.isArray(answered?.nodes)) throw new LinearApiError(502, "Linear answered a listing with no list.");
  return answered;
}

export type RawUser = {
  id: string;
  name: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  active?: boolean | null;
  /** Whether the user is an app (an integration or agent) rather than a person. */
  app?: boolean | null;
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
  /**
   * `team` is absent only from a parent a pending action recorded before reads reported the
   * parent's team (see LinearGatekeeperImpl.issueTeamIds).
   */
  parent?: { id: string; identifier: string; url: string; title: string; team?: { id: string } } | null;
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

const USER_FIELDS = `id name displayName email avatarUrl active app`;
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
  parent { id identifier url title team { id } }
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

// The body of a GraphQL answer.
type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

// The code Linear gives the error of a request refused for its rate limit.
const RATE_LIMITED_CODE = "RATELIMITED";

// What the method that sent a request made of the data `graphql` hands it: what it read from the
// data, or what it threw for data that lacks what the request was sent for. `flawed` marks data
// the method goes on with and will refuse.
type Made<R> = { value: R; flawed: boolean } | { thrown: unknown };

// Reads data as the method that sent the request does, keeping what `read` throws for the request
// to be counted by and for `graphql` to throw. A `flawed` that cannot read what `read` returned
// says that the method cannot either.
function madeOf<T, R>(data: T, read: (data: T) => R, flawed?: (value: R) => boolean): Made<R> {
  let value: R;
  try {
    value = read(data);
  } catch (error) {
    return { thrown: error };
  }
  try {
    return { value, flawed: flawed?.(value) === true };
  } catch {
    return { value, flawed: true };
  }
}

// How a GraphQL answer is counted where its status does not say: a request refused for the rate
// limit as that, whatever its status, and any other failure inside a 2xx as an error of the API:
// GraphQL errors, no data, a mutation Linear says it did not apply, and data the method that sent
// the request refuses (`Made`).
function graphqlAnswer(
  answer: { ok: boolean; json: GraphqlEnvelope<unknown>; made?: Made<unknown> },
): CallAnswer | undefined {
  const { errors, data } = answer.json;
  if (errors && errors.length > 0) {
    if (errors.some(error => error.extensions?.code === RATE_LIMITED_CODE)) {
      return { outcome: "refused", reason: "rate" };
    }
    return answer.ok ? { outcome: "error", reason: "api" } : undefined;
  }
  if (!answer.ok) return undefined;
  const { made } = answer;
  const refused = made !== undefined && ("thrown" in made || made.flawed);
  return data === undefined || refusesMutation(data) || refused ? { outcome: "error", reason: "api" } : undefined;
}

// Whether an answer's data says Linear did not apply a mutation: each mutation answers a payload
// of its own name with a `success` flag, and no query asks for a field of that name.
function refusesMutation(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  return Object.values(data).some(payload =>
    typeof payload === "object" && payload !== null && "success" in payload && payload.success === false);
}

// The cursor of the page after one page of a project's teams: undefined after the last page, and
// null where Linear says a further page follows and names no cursor for it.
function nextTeamsCursor(teams: RawConnection<{ id: string }>): string | null | undefined {
  if (!teams.pageInfo.hasNextPage) return undefined;
  return teams.pageInfo.endCursor || null;
}

// The two mutations setIssueArchived sends, and the name of each.
const ARCHIVE_MUTATIONS = {
  archive: { mutation: "issueArchive", operation: "issues.archive" },
  unarchive: { mutation: "issueUnarchive", operation: "issues.unarchive" },
} as const;

export class LinearApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  /**
   * Sends one GraphQL request to Linear.
   * @param operation The request's name, which it is counted under.
   * @param query The GraphQL document.
   * @param variables The document's variables.
   * @returns The answer's `data`.
   * @throws A `LinearApiError` for a rejected token, an answer that is no JSON, GraphQL `errors`,
   * a failed status or an answer with no data.
   */
  async graphql<T>(
    operation: GraphqlOperation, query: string, variables?: Record<string, unknown>,
  ): Promise<T>;
  /**
   * Sends one GraphQL request to Linear, and reads its data as the method that sent it does, so
   * that data the method refuses counts the request an error of the API.
   * @param operation The request's name, which it is counted under.
   * @param query The GraphQL document.
   * @param variables The document's variables.
   * @param read Takes from the answer's `data` what the request was sent for, and throws where the
   * data lacks it or says that Linear did not do what was asked.
   * @param flawed Whether what `read` returned holds something its caller goes on to refuse, which
   * counts the request an error of the API and throws nothing here.
   * @returns What `read` returned.
   * @throws What the other signature throws, and what `read` threw.
   */
  async graphql<T, R>(
    operation: GraphqlOperation, query: string, variables: Record<string, unknown> | undefined,
    read: (data: T) => R, flawed?: (value: R) => boolean,
  ): Promise<R>;
  async graphql<T, R>(
    operation: GraphqlOperation, query: string, variables?: Record<string, unknown>,
    read?: (data: T) => R, flawed?: (value: R) => boolean,
  ): Promise<T | R> {
    const token = await this.#getToken();
    // The envelope is returned before it is judged, so that the request is counted by what it
    // holds: GraphQL errors arrive inside a 200.
    const { status, statusText, ok, json, made } = await linearUpstream.read(GRAPHQL_ENDPOINT, {
      method: "POST",
      operation,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    }, async response => {
      if (response.status === 401) {
        throw new LinearApiError(401, "Linear rejected the access token.");
      }
      const envelope = (await response.json().catch(() => undefined)) as GraphqlEnvelope<T> | undefined;
      if (!envelope) {
        throw new LinearApiError(response.status, `Linear returned an unparseable response.`);
      }
      // The method reads the data this helper returns: that of an answer it throws nothing for.
      const { errors, data } = envelope;
      const returned = read && response.ok && !(errors && errors.length > 0) && data !== undefined;
      return {
        status: response.status, statusText: response.statusText, ok: response.ok, json: envelope,
        made: returned ? madeOf(data, read, flawed) : undefined,
      };
    }, graphqlAnswer);

    if (json.errors && json.errors.length > 0) {
      const first = json.errors[0];
      const code = first.extensions?.code ?? "";
      const errorStatus = /AUTHENTICATION|FORBIDDEN/i.test(code) ? 401 : (ok ? 400 : status);
      throw new LinearApiError(errorStatus, first.message, json.errors);
    }

    if (!ok) {
      throw new LinearApiError(status, `${status} ${statusText}`);
    }

    if (json.data === undefined) {
      throw new LinearApiError(status, "Linear returned no data.");
    }
    if (!made) return json.data;
    if ("thrown" in made) throw made.thrown;
    return made.value;
  }

  // ---- Observations -------------------------------------------------------

  async getViewer(): Promise<{ user: RawUser; organization: RawOrganization }> {
    return await this.graphql(
      "viewer.get",
      `query { viewer { ${USER_FIELDS} } organization { id name urlKey } }`,
      undefined,
      (data: { viewer: RawUser; organization: RawOrganization }) =>
        ({ user: data.viewer, organization: data.organization }),
    );
  }

  async getOrganization(): Promise<RawOrganization> {
    return await this.graphql(
      "organization.get",
      `query { organization { id name urlKey } }`,
      undefined,
      (data: { organization: RawOrganization }) => data.organization,
    );
  }

  async listTeams(options: { first: number; after?: string; includeArchived?: boolean }): Promise<RawConnection<RawTeam>> {
    return await this.graphql(
      "teams.list",
      `query($first: Int!, $after: String, $includeArchived: Boolean) {
        teams(first: $first, after: $after, includeArchived: $includeArchived) {
          nodes { ${TEAM_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: options.first, after: options.after, includeArchived: options.includeArchived ?? false },
      (data: { teams: RawConnection<RawTeam> }) => connection(data.teams),
    );
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
    return await this.graphql(
      "teams.find",
      `query($filter: TeamFilter) {
        teams(first: 2, filter: $filter) { nodes { ${TEAM_FIELDS} } pageInfo { hasNextPage endCursor } }
      }`,
      { filter },
      (data: { teams: RawConnection<RawTeam> }) => data.teams.nodes[0] ?? null,
    );
  }

  async listWorkflowStates(teamId: string): Promise<RawWorkflowState[]> {
    return await this.graphql(
      "states.list",
      `query($id: String!) {
        team(id: $id) { states(first: 100) { nodes { ${STATE_FIELDS} } pageInfo { hasNextPage endCursor } } }
      }`,
      { id: teamId },
      (data: { team: { states: RawConnection<RawWorkflowState> } }) => connection(data.team.states).nodes,
    );
  }

  async listLabels(teamId: string): Promise<RawLabel[]> {
    return await this.graphql(
      "labels.list",
      `query($id: String!) {
        team(id: $id) { labels(first: 250) { nodes { ${LABEL_FIELDS} } pageInfo { hasNextPage endCursor } } }
      }`,
      { id: teamId },
      (data: { team: { labels: RawConnection<RawLabel> } }) => connection(data.team.labels).nodes,
    );
  }

  async listTeamMembers(teamId: string): Promise<RawUser[]> {
    return await this.graphql(
      "members.list",
      `query($id: String!) {
        team(id: $id) { members(first: 250) { nodes { ${USER_FIELDS} } pageInfo { hasNextPage endCursor } } }
      }`,
      { id: teamId },
      (data: { team: { members: RawConnection<RawUser> } }) => connection(data.team.members).nodes,
    );
  }

  async listUsers(options: { first: number; filter?: unknown }): Promise<RawUser[]> {
    return await this.graphql(
      "users.list",
      `query($first: Int!, $filter: UserFilter) {
        users(first: $first, filter: $filter) { nodes { ${USER_FIELDS} } pageInfo { hasNextPage endCursor } }
      }`,
      { first: options.first, filter: options.filter },
      (data: { users: RawConnection<RawUser> }) => connection(data.users).nodes,
    );
  }

  async listProjects(
    scope: { teamId?: string },
    options: { first: number; after?: string; includeArchived?: boolean },
  ): Promise<RawConnection<RawProject>> {
    if (scope.teamId) {
      return await this.graphql(
        "team-projects.list",
        `query($id: String!, $first: Int!, $after: String, $includeArchived: Boolean) {
          team(id: $id) {
            projects(first: $first, after: $after, includeArchived: $includeArchived) {
              nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: scope.teamId, first: options.first, after: options.after, includeArchived: options.includeArchived ?? false },
        (data: { team: { projects: RawConnection<RawProject> } }) => connection(data.team.projects),
      );
    }
    // Each project's further pages of teams are requested too, so the requests are counted summed.
    return await linearUpstream.summed(() => this.#listWorkspaceProjects(options));
  }

  async #listWorkspaceProjects(
    options: { first: number; after?: string; includeArchived?: boolean },
  ): Promise<RawConnection<RawProject>> {
    // A project whose teams name no cursor for a further page is refused below, once the teams of
    // the projects before it are asked for: the listing counts an error of the API by that check.
    // The page is held under the name its query gives it, as the data of the query holds it.
    const data = { projects: await this.graphql(
      "projects.list",
      `query($first: Int!, $after: String, $includeArchived: Boolean) {
        projects(first: $first, after: $after, includeArchived: $includeArchived) {
          nodes { ${PROJECT_LIST_FIELDS} } pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: options.first, after: options.after, includeArchived: options.includeArchived ?? false },
      (found: { projects: RawConnection<RawProject> }) => connection(found.projects),
      listed => listed.nodes.some(({ teams }) => (teams ? nextTeamsCursor(teams) === null : false)),
    ) };
    await Promise.all(data.projects.nodes.map(async project => {
      const teams = project.teams;
      if (!teams) return;

      for (;;) {
        const after = nextTeamsCursor(teams);
        if (after === undefined) break;
        if (after === null) throw new LinearApiError(500, "Linear returned an invalid project teams cursor.");
        const page = await this.#listProjectTeams(project.id, after);
        teams.nodes.push(...page.nodes);
        teams.pageInfo = page.pageInfo;
      }
    }));
    return data.projects;
  }

  // One further page of a project's teams. A page that names no cursor for the page after it is
  // refused by the loop that asked for it, and counts an error of the API by that check.
  async #listProjectTeams(projectId: string, after: string): Promise<RawConnection<{ id: string }>> {
    return await this.graphql(
      "project-teams.list",
      `query($id: String!, $after: String!) {
        project(id: $id) {
          teams(first: 50, after: $after) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: projectId, after },
      (data: { project: { teams: RawConnection<{ id: string }> } }) => listed(data.project.teams),
      teams => nextTeamsCursor(teams) === null,
    );
  }

  async listCycles(teamId: string, options: { first: number; after?: string }): Promise<RawConnection<RawCycle>> {
    return await this.graphql(
      "cycles.list",
      `query($id: String!, $first: Int!, $after: String) {
        team(id: $id) {
          cycles(first: $first, after: $after) { nodes { ${CYCLE_FIELDS} } pageInfo { hasNextPage endCursor } }
        }
      }`,
      { id: teamId, first: options.first, after: options.after },
      (data: { team: { cycles: RawConnection<RawCycle> } }) => connection(data.team.cycles),
    );
  }

  async listIssues(options: {
    first: number;
    after?: string;
    filter?: unknown;
    orderBy?: "createdAt" | "updatedAt";
    includeArchived?: boolean;
  }): Promise<RawConnection<RawIssue>> {
    return await this.graphql(
      "issues.list",
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
      (data: { issues: RawConnection<RawIssue> }) => connection(data.issues),
    );
  }

  async searchIssues(options: {
    term: string;
    first: number;
    after?: string;
    filter?: unknown;
    includeArchived?: boolean;
  }): Promise<RawConnection<RawIssue>> {
    return await this.graphql(
      "issues.search",
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
      (data: { searchIssues: RawConnection<RawIssue> }) => connection(data.searchIssues),
    );
  }

  /**
   * Fetch a single issue by UUID or human identifier (e.g. "ENG-123"). Returns null if not found.
   * Linear's `issue(id:)` query accepts both forms.
   */
  async getIssue(idOrIdentifier: string): Promise<RawIssue | null> {
    return await this.graphql(
      "issues.get",
      `query($id: String!) { issue(id: $id) { ${ISSUE_DETAIL_FIELDS} } }`,
      { id: idOrIdentifier },
      (data: { issue: RawIssue | null }) => data.issue,
    );
  }

  async listComments(issueId: string, options: { first: number; after?: string }): Promise<RawConnection<RawComment>> {
    return await this.graphql(
      "comments.list",
      `query($id: String!, $first: Int!, $after: String) {
        issue(id: $id) {
          comments(first: $first, after: $after) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }
        }
      }`,
      { id: issueId, first: options.first, after: options.after },
      (data: { issue: { comments: RawConnection<RawComment> } }) => connection(data.issue.comments),
    );
  }

  async getProject(projectId: string): Promise<RawProject | null> {
    return await this.graphql(
      "projects.get",
      `query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
      { id: projectId },
      (data: { project: RawProject | null }) => data.project,
    );
  }

  // ---- Mutations ----------------------------------------------------------

  async createIssue(input: IssueCreateInput): Promise<RawIssue> {
    return await this.graphql(
      "issues.create",
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_DETAIL_FIELDS} } }
      }`,
      { input },
      (data: { issueCreate: { success: boolean; issue: RawIssue } }) => {
        if (!data.issueCreate.success) throw new LinearApiError(400, "Linear refused to create the issue.");
        return data.issueCreate.issue;
      },
    );
  }

  async updateIssue(issueId: string, input: IssueUpdateInput): Promise<void> {
    await this.graphql(
      "issues.update",
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issueId, input },
      (data: { issueUpdate: { success: boolean } }) => {
        if (!data.issueUpdate.success) throw new LinearApiError(400, "Linear refused to update the issue.");
      },
    );
  }

  async setIssueArchived(issueId: string, archived: boolean): Promise<void> {
    const { mutation, operation } = archived ? ARCHIVE_MUTATIONS.archive : ARCHIVE_MUTATIONS.unarchive;
    await this.graphql(
      operation,
      `mutation($id: String!) { ${mutation}(id: $id) { success } }`,
      { id: issueId },
      (data: Record<string, { success: boolean }>) => {
        if (!data[mutation].success) {
          throw new LinearApiError(400, `Linear refused to ${archived ? "archive" : "unarchive"} the issue.`);
        }
      },
    );
  }

  async createComment(issueId: string, body: string): Promise<RawComment> {
    return await this.graphql(
      "comments.create",
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
      }`,
      { input: { issueId, body } },
      (data: { commentCreate: { success: boolean; comment: RawComment } }) => {
        if (!data.commentCreate.success) throw new LinearApiError(400, "Linear refused to create the comment.");
        return data.commentCreate.comment;
      },
    );
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.graphql<{ commentDelete: { success: boolean } }>(
      "comments.delete",
      `mutation($id: String!) { commentDelete(id: $id) { success } }`,
      { id: commentId },
    );
  }

  async createLabel(input: { teamId: string; name: string; color?: string; description?: string }): Promise<RawLabel> {
    return await this.graphql(
      "labels.create",
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { ${LABEL_FIELDS} } }
      }`,
      { input },
      (data: { issueLabelCreate: { success: boolean; issueLabel: RawLabel } }) => {
        if (!data.issueLabelCreate.success) throw new LinearApiError(400, "Linear refused to create the label.");
        return data.issueLabelCreate.issueLabel;
      },
    );
  }

  async deleteIssue(issueId: string): Promise<void> {
    await this.graphql<{ issueDelete: { success: boolean } }>(
      "issues.delete",
      `mutation($id: String!) { issueDelete(id: $id) { success } }`,
      { id: issueId },
    );
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.graphql<{ issueLabelDelete: { success: boolean } }>(
      "labels.delete",
      `mutation($id: String!) { issueLabelDelete(id: $id) { success } }`,
      { id: labelId },
    );
  }
}
