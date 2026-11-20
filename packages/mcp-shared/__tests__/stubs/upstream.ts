// The upstream the library's tests hand it, declared the way a gatekeeper declares its own.

import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";

import { MCP_UPSTREAM_OPTIONS } from "../../src/upstream.js";

/** An MCP gatekeeper's upstream, under the vendor id `mcp`. */
export const upstream = defineUpstream({ vendorId: "mcp", ...MCP_UPSTREAM_OPTIONS });
