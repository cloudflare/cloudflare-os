// The upstream every request this gatekeeper makes to a connected MCP server, or to that server's
// authorization server, is sent and counted through. `@gadgets/mcp-shared` makes the requests and
// names them (see its `upstream` module); the vendor id is what this gatekeeper adds.

import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { MCP_UPSTREAM_OPTIONS } from "@gadgets/mcp-shared/upstream";

/**
 * This gatekeeper's upstream. Its calls are counted as subservice metrics under the source
 * `gatekeeper.mcp.api` and the service `mcp`: the connected server's host is never a service.
 */
export const mcpServerUpstream = defineUpstream({ vendorId: "mcp", ...MCP_UPSTREAM_OPTIONS });
