// The single retry three gatekeepers hand-roll around a rejected credential (google
// `auth-retry.ts:100-141`, notion `notion-api.ts:1022-1052`, confluence
// `confluence-api.ts:527-550`). `CredentialSource` has only two outcomes -- pass through, or report
// the grant dead -- so a provider whose rejection can mean a stale derived bearer needs this in
// front of it.

/** How `withAuthRetry` obtains tokens and classifies failures. */
export type AuthRetryOptions<Token> = {
  /**
   * Returns a usable token. `forceRefresh` demands a provider round trip; `staleToken` is the
   * token the provider just rejected, so a shared cache can skip a redundant mint when another
   * caller already advanced it.
   */
  getToken(options: { forceRefresh: boolean; staleToken?: Token }): Promise<Token>;
  /** Classifies a caught error as the provider rejecting the credential (not transport/5xx). */
  isAuthError(error: unknown): boolean;
};

/**
 * Retries once when `isAuthError` means a stale derived bearer rather than a dead grant -- the
 * classifier is the provider's, so a non-401 envelope counts. `run` is executed at most twice and
 * must therefore be replayable; build the request inside it for each attempt.
 *
 * Reporting a twice-rejected credential is the caller's, and belongs outside this module, which
 * holds no credential identity to fence a notification on: wrap the call in `CredentialSource.run`
 * (`./credentials`), whose catch reports against the identity it captured before the attempt.
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
