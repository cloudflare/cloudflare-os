// The upstream every request this gatekeeper makes to the configured portal, or to the portal's
// authorization server, is sent and counted through. `@gadgets/mcp-shared` makes the requests and
// names them (see its `upstream` module); the vendor id is what this gatekeeper adds.

import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { MCP_UPSTREAM_OPTIONS } from "@gadgets/mcp-shared/upstream";

/**
 * This gatekeeper's upstream. Its calls are counted as subservice metrics under the source
 * `gatekeeper.mcp_portal.api` and the service `mcp_portal`: neither the portal's host nor a
 * server behind it is ever a service.
 */
export const portalUpstream = defineUpstream({ vendorId: "mcp_portal", ...MCP_UPSTREAM_OPTIONS });
