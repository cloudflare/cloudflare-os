export const MAX_GATEKEEPER_APP_PROMPT_LENGTH = 4_000;
export const MAX_GATEKEEPER_APP_PATH_LENGTH = 4_096;

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

/**
 * Validates an app-local path a sandboxed gatekeeper app asks to navigate to (see
 * `@gadgets/workshop-shared/gatekeeper-app`). The host pins it under the app's own
 * /gatekeepers/<appId> prefix, so only the path's own shape is checked here.
 */
export function parseGatekeeperAppPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError("Invalid gatekeeper app path.");
  }
  if (value.length > MAX_GATEKEEPER_APP_PATH_LENGTH) {
    throw new RangeError("Gatekeeper app path is too long.");
  }
  if (value === "/") return value;
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is rejected.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("Invalid gatekeeper app path.");
  for (const segment of value.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new TypeError("Invalid gatekeeper app path.");
    }
  }
  return value;
}
