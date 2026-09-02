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
 * Retries once after provider-confirmed credential rejection.
 * @param options Token acquisition and error policy.
 * @param run Replayable provider operation.
 * @returns The first successful result.
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
