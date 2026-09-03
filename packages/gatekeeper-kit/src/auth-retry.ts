/** One-retry authentication recovery for replayable provider calls. */

/** How `withAuthRetry` obtains tokens and classifies failures. */
export type AuthRetryOptions<Token> = {
  /**
   * Gets a token, optionally replacing a stale one.
   * @param options Refresh policy and optional stale token.
   * @returns A usable token.
   */
  getToken(options: { forceRefresh: boolean; staleToken?: Token }): Promise<Token>;
  /**
   * Classifies provider credential rejection.
   * @param error Caught provider error.
   * @returns Whether credentials caused the failure.
   */
  isAuthError(error: unknown): boolean;
};

/**
 * Retries once after provider-confirmed credential rejection. This helper never reports expiry;
 * wrap it in `CredentialSource.run()` when the grant itself should be expired.
 * @param options Token acquisition and error policy.
 * @param run Replayable provider operation, executed at most twice.
 * @returns The first successful result.
 *
 * @example
 * ```ts
 * return withAuthRetry({
 *   getToken: options => this.#account.getToken(options),
 *   isAuthError: error => error instanceof VendorApiError && error.status === 401,
 * }, token => this.#api.listProjects(token));
 * ```
 */
export async function withAuthRetry<Token, T>(
  options: AuthRetryOptions<Token>,
  run: (token: Token) => Promise<T>,
): Promise<T> {
  const token = await options.getToken({ forceRefresh: false });
  try {
    return await run(token);
  } catch (error) {
    if (!options.isAuthError(error)) throw error;
  }
  return run(await options.getToken({ forceRefresh: true, staleToken: token }));
}
