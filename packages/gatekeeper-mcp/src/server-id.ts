// Names a connected server for display: the suggested binding (`MCP_LINEAR`) and the readable half
// of the generated session type (`McpLinear4f2aSession`). Not an identity, since two hosts can slug
// the same way -- action-kind tags use the whole canonical endpoint instead (`endpointTag`, which
// keeps same-origin paths apart), and the session type is separated by a tag derived from the
// scoped resource URL. See `ConnectedServer.serverId` and `sessionTypeName`.

// Host labels that say nothing about which service this is.
const GENERIC_HOST_LABELS = new Set(["mcp", "api", "www", "server", "app"]);

/**
 * A readable slug for an endpoint: `https://mcp.linear.app/mcp` -> `linear`. Never empty, since the
 * result is interpolated into a TypeScript identifier.
 */
export function serverIdFromEndpoint(endpoint: string): string {
  const labels = new URL(endpoint).hostname.split(".");
  const chosen = labels.find(label => !GENERIC_HOST_LABELS.has(label)) ?? labels[0];
  return chosen.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}
