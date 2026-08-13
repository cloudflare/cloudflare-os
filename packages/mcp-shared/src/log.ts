// The field vocabulary both MCP connectors log against, so the two produce identically-named,
// queryable fields. Typed rather than `Record<string, unknown>` so that `ReservedLogField` makes
// `token`, `secret`, and `prompt` unloggable in a package that holds OAuth tokens.

import type { Logger } from "@gadgets/backend-utils/logger";
import type { ServerTrust } from "./tools.js";

/** Fields an MCP connector may attach to a log line, beyond the reserved ones every logger has. */
export type McpLogFields = {
  /** The gatekeeper's vendor id, set once on the module logger. */
  vendorId: string;
  /** Display slug of the connected server, or of the upstream server a grant is scoped to. */
  serverId: string;
  /** Endpoint host only. The path may encode tenant identifiers, so it is never logged. */
  serverHost: string;
  toolName: string;
  actionId: number;
  toolCount: number;
  catalogRevision: string;
  /** The tier in force for the operation, read from configuration at the time it ran. */
  trust: ServerTrust;
  /** Who chose the endpoint. Distinguishes a user-supplied server from a deployment's own gateway. */
  provenance: "user" | "deployment";
};

/** The logger this package expects to be handed. */
export type McpLog = Logger<McpLogFields>;
