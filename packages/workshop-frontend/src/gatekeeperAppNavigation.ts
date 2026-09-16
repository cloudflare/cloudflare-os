export const MAX_GATEKEEPER_APP_PROMPT_LENGTH = 4_000;

// A Durable Object ID string, which is what a workspace ID is.
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{64}$/;

export type GatekeeperAppWorkspaceTarget = { workspaceId: string; gadgetId?: number };

/**
 * Validates a workspace target arriving from a sandboxed gatekeeper app before the host navigates
 * to it. The app is untrusted input, so the shape is checked here rather than at the router.
 */
export function parseGatekeeperAppWorkspaceTarget(
  workspaceId: unknown,
  gadgetId: unknown,
): GatekeeperAppWorkspaceTarget {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError("Invalid gatekeeper app workspace target.");
  }
  if (gadgetId === undefined) return { workspaceId };
  if (typeof gadgetId !== "number" || !Number.isSafeInteger(gadgetId) || gadgetId < 0) {
    throw new TypeError("Invalid gatekeeper app workspace target.");
  }
  return { workspaceId, gadgetId };
}

export function normalizeGatekeeperAppPrompt(value: string): string {
  if (typeof value !== "string") throw new TypeError("Gatekeeper app prompt must be text.");
  const prompt = value.trim();
  if (!prompt) throw new TypeError("Gatekeeper app prompt cannot be empty.");
  if (prompt.length > MAX_GATEKEEPER_APP_PROMPT_LENGTH) {
    throw new RangeError("Gatekeeper app prompt is too long.");
  }
  return prompt;
}
