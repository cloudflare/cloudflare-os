// The base types prepended to every generated per-server `.d.ts`, as a string.
//
// A Worker's `Text` module rule cannot resolve an import across a package boundary, so this has to
// be an ordinary module rather than a `.txt` file both gatekeeper Workers import. The
// authoritative, typechecked copy is `types.d.ts` next to this file; `__tests__/base-types.test.ts`
// asserts the two are identical, so a change to one that misses the other fails CI rather than
// silently handing agents a stale type surface.
//
// Only the escaping differs: backticks are escaped for the template literal below.

export const MCP_BASE_TYPES = `// Base types for MCP-server sessions.
//
// These are prepended to every generated per-server \`.d.ts\` (see \`schema-to-ts.ts\`), so a workspace's
// coding agent always has them in scope. One method per tool and \`callTool\` overloads are generated
// from the server's own tool catalog and appended below this file's contents.

/** A block of content returned by an MCP tool. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

/**
 * Outcome of \`callTool\` or \`getActionResult\`.
 *
 * Read-only tools resolve to \`"ok"\` straight away. Everything else is an action: it is queued for
 * approval and resolves to \`"pending"\`, then to \`"ok"\`, \`"rejected"\`, or \`"failed"\`.
 */
export type McpCallResult =
  | {
      status: "ok";
      /** Content blocks as returned by the server. */
      content: McpContent[];
      /** All text blocks concatenated, for the common case where that is all you need. */
      text: string;
      /** Present when the tool declares an output schema and returned structured data. */
      structuredContent?: unknown;
      /** True when the tool itself reported failure (the call succeeded; the tool did not). */
      isError?: boolean;
    }
  | {
      status: "pending";
      /** Pass to \`getActionResult\` to collect the outcome once it has been decided. */
      actionId: number;
      /** Human-readable explanation to relay to the user. */
      message: string;
    }
  | {
      status: "rejected";
      /** Why the action was not performed. */
      message: string;
    }
  | {
      status: "failed";
      /** The approved call failed. Its message says whether it may have taken effect. */
      message: string;
    };

/** How this deployment classified one tool. */
export type McpToolMode =
  // Returns data immediately; every call is recorded as an observation.
  | "read"
  // Queued for approval before it runs.
  | "action";

/** Description of one tool exposed by the session. */
export type McpToolInfo = {
  /** Tool name, as passed to \`callTool\`. The generated method name is derived from it. */
  name: string;
  /** Display title, if the server supplied one. */
  title?: string;
  /** The server's own description of the tool. */
  description?: string;
  /** Whether calls are observations or approval-gated actions. */
  mode: McpToolMode;
  /**
   * Why the tool was classified this way: \`"server-annotation"\` when the server's own
   * \`readOnlyHint\` decided it, \`"default"\` when nothing was declared and it was treated as an
   * action. Recorded so an audit can find every call that was trusted on the server's word.
   */
  classifiedBy: "server-annotation" | "default";
  /** JSON Schema for the tool's arguments when it fits the connector's definition budget. */
  inputSchema?: unknown;
};

/** Bounded search result. Request the exact name through \`listTools({ name })\` for its schema. */
export type McpToolSummary = Omit<McpToolInfo, "inputSchema">;

/** Progressive catalog lookup through the existing \`listTools\` session method. */
export type McpToolListOptions =
  | { search: string; name?: never }
  | { name: string; search?: never };
`;
