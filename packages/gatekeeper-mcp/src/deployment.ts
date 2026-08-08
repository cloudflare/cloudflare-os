import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectedServer } from "@gadgets/mcp-shared/account";

import { serverIdFromEndpoint } from "./server-id.js";

/** A deployment-owned MCP server reached only through a Workers service binding. */
export type FixedMcpService = {
  endpoint: string;
  name: string;
  server: ConnectedServer;
  resource: SupportedResource;
};

/**
 * Reads the optional fixed-service configuration.
 *
 * The URL is a stable MCP resource identifier and supplies the request path to the bound Worker.
 * It is never fetched through the public Internet when MCP_SERVICE is present.
 */
export function readFixedMcpService(env: Env): FixedMcpService | null {
  const raw = env.MCP_SERVER_URL?.trim();
  if (!raw || !env.MCP_SERVICE) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;

  const endpoint = url.toString();
  const name = env.MCP_SERVER_NAME?.trim() || url.hostname;
  const serverId = env.MCP_SERVER_ID?.trim() || serverIdFromEndpoint(endpoint);
  return {
    endpoint,
    name,
    server: {
      endpoint,
      serverId,
      serverName: name,
      provenance: "deployment",
      auth: "none",
    },
    resource: {
      urlPattern: `${url.origin}/*`,
      title: name,
      description:
        "Company capabilities provided through an internal Workers service binding. Writes need approval.",
    },
  };
}
