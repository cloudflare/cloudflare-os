/**
 * An HTTP error carrying its response status, so verifiers can classify failures numerically
 * instead of parsing message text.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * True only when the error carries a numeric `status` of 401/403/404 (observer lacks access).
 * Classification is numeric and never parses message text. Anything without a numeric 401/403/404
 * status MUST be rethrown by the caller, never treated as "no access".
 */
export function isNoAccessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  return error.status === 401 || error.status === 403 || error.status === 404;
}

/**
 * Runs an ACL probe, mapping no-access statuses to `false` and rethrowing anything operational.
 *
 * `check` should throw to report failure. The one resolved value that still counts as an answer is
 * a non-ok `Response` — `fetch` resolves for HTTP errors, so a bare `probeAccess(() => fetch(url))`
 * would otherwise report access for a 403. It is classified by status like a thrown error.
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
