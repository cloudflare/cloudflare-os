/**
 * A fake provider for the conformance consumer: enough of a real API's shape to exercise every kit
 * contract, plus the failure modes a real provider will not reproduce on demand.
 */

/** Thrown for a rejected credential, the way a provider signals 401. */
export class ProviderAuthError extends Error {}

/** Thrown when the provider was reached but the outcome is unknowable -- a timeout. */
export class ProviderTimeoutError extends Error {}

/** The stored grant. `refreshToken` rotates, so a lost merge breaks the *next* refresh. */
export type Grant = {
  accessToken: string;
  refreshToken: string;
  scopes: readonly string[];
  expiresAt: number;
};

/** What a resource facet may see: refresh material never crosses the account RPC boundary. */
export type PublicGrant = Omit<Grant, "refreshToken">;

export type Project = { id: string; name: string; spaceId: string };

/** Controls the failure modes a conformance run needs to force. */
export type ProviderControls = {
  /** Rejects every call with the auth error, as a revoked grant does. */
  rejectCredentials?: boolean;
  /** Fails refresh with a dead-grant signal rather than issuing a new token. */
  grantDead?: boolean;
  /** Creates the project, then times out before returning -- the ambiguous outcome. */
  timeoutAfterCreate?: boolean;
};

/**
 * In-memory provider. One instance per test, shared by the account and its resources the way a
 * real provider's servers are.
 */
export class FakeProvider {
  readonly controls: ProviderControls = {};
  /** Refresh tokens the provider will no longer honour, by rotation or explicit revocation. */
  readonly revoked = new Set<string>();
  /** Access tokens the provider still accepts. */
  readonly activeAccessTokens = new Set<string>();
  /** Every project the provider holds, by id. */
  readonly projects = new Map<string, Project>();
  /** Per-user visibility, so a collaborator can legitimately lack access to one space. */
  readonly access = new Map<string, Set<string>>();
  /** Provider page fetches, so a test can prove a page came from the cursor's buffer. */
  listCalls = 0;
  /** The principal a fresh authorization belongs to; reassign it to reconnect as someone else. */
  principal = "user-a";
  #issued = 0;
  readonly #owners = new Map<string, string>();
  #created = 0;

  /**
   * Refreshes a grant. The response omits everything that did not change, which is what makes a
   * merge mandatory in the consumer's refresh callback.
   * @param current The grant being refreshed.
   * @returns Only the fields the provider considers changed.
   */
  refresh(current: Grant): { accessToken: string; expiresAt: number; refreshToken?: string } {
    if (this.controls.grantDead || this.revoked.has(current.refreshToken)) {
      throw new ProviderAuthError("invalid_grant");
    }
    // A refresh continues its own grant, whoever a fresh authorization would belong to now.
    const next = this.#issue(this.#owners.get(current.refreshToken) ?? this.principal);
    // Rotating: the old refresh token dies with this call.
    this.revoked.add(current.refreshToken);
    return {
      accessToken: next.accessToken,
      expiresAt: next.expiresAt,
      refreshToken: next.refreshToken,
    };
  }

  /** @returns A newly issued grant for the principal a fresh authorization belongs to. */
  mint(): Grant {
    return this.#issue(this.principal);
  }

  #issue(principal: string): Grant {
    this.#issued += 1;
    const accessToken = `${principal}-access-${this.#issued}`;
    const refreshToken = `${principal}-refresh-${this.#issued}`;
    this.activeAccessTokens.add(accessToken);
    this.#owners.set(refreshToken, principal);
    return {
      accessToken,
      refreshToken,
      scopes: ["projects:read", "projects:write"],
      expiresAt: Date.now() + 3_600_000,
    };
  }

  #check(grant: PublicGrant): void {
    if (this.controls.rejectCredentials || !this.activeAccessTokens.has(grant.accessToken)) {
      throw new ProviderAuthError("401 unauthorized");
    }
  }

  /**
   * Pages projects. Filters nothing, so the caller's `retain` decides visibility.
   * @param grant Current credentials.
   * @param token Continuation token.
   * @param perPage Requested page size.
   * @returns One page and the next token.
   */
  listProjects(grant: PublicGrant, token: string | undefined, perPage: number): {
    items: Project[];
    nextToken?: string;
  } {
    this.#check(grant);
    this.listCalls += 1;
    const all = [...this.projects.values()];
    const start = token === undefined ? 0 : Number(token);
    const items = all.slice(start, start + perPage);
    const next = start + perPage;
    return next < all.length ? { items, nextToken: String(next) } : { items };
  }

  /**
   * Answers whether a project matches, across every space the account can see.
   * @param grant Current credentials.
   * @param query Name substring.
   * @returns The matches, and every space the search covered — the scope an observation must
   * name, since a miss discloses absence in each of them.
   */
  searchProjects(grant: PublicGrant, query: string): { matches: Project[]; spaces: string[] } {
    this.#check(grant);
    const all = [...this.projects.values()];
    return {
      matches: all.filter(project => project.name.includes(query)),
      spaces: [...new Set(all.map(project => project.spaceId))],
    };
  }

  /**
   * Creates a project. Non-idempotent: a retry makes a second one, which is what `claimBeforeApply`
   * and the unknown outcome exist to prevent.
   * @param grant Current credentials.
   * @param name Project name.
   * @param spaceId Owning space.
   * @returns The new project id.
   */
  createProject(grant: PublicGrant, name: string, spaceId: string): string {
    this.#check(grant);
    this.#created += 1;
    const id = `project-${this.#created}`;
    this.projects.set(id, { id, name, spaceId });
    if (this.controls.timeoutAfterCreate) {
      // The effect landed and the caller will never learn it.
      throw new ProviderTimeoutError("gateway timeout");
    }
    return id;
  }

  /**
   * Renames an existing project, the dependent half of a provisional reference.
   * @param grant Current credentials.
   * @param id Project id.
   * @param name New name.
   */
  renameProject(grant: PublicGrant, id: string, name: string): void {
    this.#check(grant);
    const project = this.projects.get(id);
    if (!project) throw new Error(`no such project ${id}`);
    this.projects.set(id, { ...project, name });
  }

  /**
   * Whether a collaborator may see a space.
   * @param user Collaborator id.
   * @param spaceId Space id.
   * @returns Whether access is granted.
   */
  hasAccess(user: string, spaceId: string): boolean {
    return this.access.get(user)?.has(spaceId) === true;
  }
}
