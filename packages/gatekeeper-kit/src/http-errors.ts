/** HTTP access-error classification and ACL probe handling. */

/** HTTP error with a numeric response status. */
export class HttpError extends Error {
  /**
   * Creates an HTTP error.
   * @param status Numeric HTTP status.
   * @param message Error message.
   */
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Classifies access failures.
 * @param error Caught value with an optional status.
 * @returns Whether the status is 401, 403, or 404.
 */
export function isNoAccessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

/**
 * Runs an ACL probe. Resolved non-ok `Response` values are classified because `fetch` does not throw
 * for HTTP errors; every other failure is rethrown.
 * @param check Access check to run.
 * @returns `false` for access failures and `true` for success.
 *
 * @example
 * ```ts
 * const canRead = await probeAccess(() => api.getProject(projectId));
 * if (!canRead) throw new Error("You no longer have access to this project.");
 * ```
 */
export async function probeAccess(check: () => Promise<unknown>): Promise<boolean> {
  let result: unknown;
  try {
    result = await check();
  } catch (error) {
    if (isNoAccessError(error)) return false;
    throw error;
  }
  if (result instanceof Response) {
    // Probes never read the body; cancel it so the connection is released. Best-effort: a locked or
    // already-errored stream must not turn a classified probe into an operational throw.
    if (!result.bodyUsed) await result.body?.cancel().catch(() => undefined);
    if (!result.ok) {
      if (isNoAccessError(result)) return false;
      throw new HttpError(result.status, `ACL probe failed with status ${result.status}.`);
    }
  }
  return true;
}
