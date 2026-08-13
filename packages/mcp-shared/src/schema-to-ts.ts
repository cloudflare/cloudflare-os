// Generates the `.d.ts` a Gadget's coding agent sees for one MCP server.
//
// The agent gets a named, typed method per tool, with JSDoc from the tool's own description, instead
// of a stringly typed escape hatch. `Gatekeeper.getTypeScriptTypes()` returns the result, and the
// Workshop feeds it to the agent's type database.
//
// The methods described here are installed by `session-methods.ts`, so both derive the name from
// `toMethodName` rather than each spelling the rule out: a type advertising a method that does not
// exist is worse than no type at all.
//
// `callTool` generates precise overloads for described tools plus a generic overload for names
// discovered later through `listTools`.

import type { JsonSchema } from "./client.js";
import { toMethodName, toolMethodNames } from "./session-methods.js";
import { MAX_SEARCH_RESULTS } from "./tool-search.js";
import type { ClassifiedTool, ServerTrust } from "./tools.js";

// Depth limit for recursive/self-referential schemas; deeper nodes degrade to `unknown`.
const MAX_DEPTH = 8;

// Total nodes one tool may render. `MAX_DEPTH` bounds nesting but not breadth, and every
// `anyOf`/`allOf`/`type` array re-renders its subtree once per member, so a schema well inside
// `MAX_TOOL_SCHEMA_CHARS` can still fan out past any wall clock. Exhausting it degrades the
// remainder to `unknown`.
const MAX_RENDER_NODES = 2000;

// Mutable and shared across one render, so the budget measures the whole tree, not one path.
type RenderBudget = { remaining: number };

// Longest description text copied into a JSDoc comment.
const MAX_DOC_LENGTH = 600;

function quote(value: string): string {
  return JSON.stringify(value);
}

// Turns an arbitrary MCP identifier into a PascalCase TypeScript identifier fragment.
function pascalCase(input: string): string {
  const parts = input.split(/[^A-Za-z0-9]+/).filter(part => part.length > 0);
  const joined = parts.map(part => part[0].toUpperCase() + part.slice(1)).join("");
  return /^[A-Za-z]/.test(joined) ? joined : `T${joined}`;
}

// A short, stable tag distinguishing one binding's generated types from another's.
//
// FNV-1a, because this has to be synchronous: `describe()` names the type and `generateSessionTypes`
// re-derives it, and the two must agree without either awaiting. Not a security boundary -- nothing
// is authorized by a type name -- so a non-cryptographic hash is the right tool, and a collision
// only returns two bindings to sharing a name as they did before.
function nameTag(discriminator: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < discriminator.length; i++) {
    hash ^= discriminator.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * The TypeScript interface name generated for one binding's session.
 *
 * `serverId` is a display slug and is not unique: two hosts can reduce to `acme`, and on a portal
 * two grants pinning different tools of one upstream server share both the slug and the endpoint.
 * Either way the agent would be shown two unrelated tool surfaces under one interface name, in
 * separate blocks it cannot compare. `discriminator` is the binding's scoped resource URL --
 * endpoint plus scope, the two things that actually determine the generated surface -- so bindings
 * that differ in what they can call differ in what their type is called.
 */
export function sessionTypeName(serverId: string, discriminator: string): string {
  return `Mcp${pascalCase(serverId)}${nameTag(discriminator)}Session`;
}

// Neutralizes the one sequence that can end a JSDoc block early.
//
// Tool descriptions, titles and server names are written by the endpoint. A description containing
// `*/` closes its own comment, and everything the server wrote after it stops being a comment and
// becomes declarations in a file the agent reads as this gatekeeper's own description of the API.
function commentSafe(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

// The same, for text interpolated into a single comment line, where a newline is the escape: what
// follows it would be read as generated source rather than as the server's own words.
function inlineCommentSafe(text: string): string {
  return commentSafe(text).replace(/[\r\n\u2028\u2029]+/g, " ");
}

function docComment(text: string | undefined, indent: string): string {
  if (!text) return "";
  const clipped = text.length > MAX_DOC_LENGTH ? `${text.slice(0, MAX_DOC_LENGTH)}...` : text;
  const lines = commentSafe(clipped).split(/\r?\n/).map(line => `${indent} * ${line}`.trimEnd());
  return `${indent}/**\n${lines.join("\n")}\n${indent} */\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unionTypes(types: string[]): string {
  const unique = [...new Set(types)];
  return unique.includes("unknown") ? "unknown" : unique.join(" | ");
}

// Renders one JSON Schema node as a TypeScript type expression. Unsupported constructs degrade to
// `unknown` rather than a guess, since the agent will trust a wrong type.
function renderType(
  schema: JsonSchema | undefined, indent: string, depth: number, budget: RenderBudget,
): string {
  if (!schema || depth > MAX_DEPTH || --budget.remaining < 0) return "unknown";
  if (schema.$ref !== undefined) return "unknown";

  if (schema.const !== undefined) return quoteLiteral(schema.const);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(quoteLiteral).join(" | ");
  }

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return unionTypes(alternatives.map(member => renderType(member, indent, depth + 1, budget)));
  }

  // allOf is only handled for the common "merge object shapes" case.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const rendered = schema.allOf.map(member => renderType(member, indent, depth + 1, budget));
    return rendered.join(" & ");
  }

  if (Array.isArray(schema.type)) {
    if (schema.type.length === 0) return "unknown";
    return unionTypes(
      schema.type.map(type => renderType({ ...schema, type }, indent, depth + 1, budget)));
  }

  const type = schema.type;

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map(item =>
          renderType(item, indent, depth + 1, budget)).join(", ")}]`;
      }
      const element = renderType(schema.items, indent, depth + 1, budget);
      return element.includes("|") || element.includes("&")
        ? `Array<${element}>`
        : `${element}[]`;
    }
    case "object":
      return renderObject(schema, indent, depth, budget);
    default:
      // No `type`, but object-ish keywords present: treat as an object.
      if (schema.properties) return renderObject(schema, indent, depth, budget);
      return "unknown";
  }
}

function quoteLiteral(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "unknown";
}

function renderObject(
  schema: JsonSchema, indent: string, depth: number, budget: RenderBudget,
): string {
  const properties = isPlainObject(schema.properties)
    ? schema.properties
    : undefined;

  if (!properties || Object.keys(properties).length === 0) {
    // A free-form object: preserve that it is an object without inventing members.
    return "Record<string, unknown>";
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const inner = `${indent}  `;
  const propertyTypes: string[] = [];
  const members = Object.entries(properties).map(([name, property]) => {
    const propertySchema = isPlainObject(property) ? property as JsonSchema : undefined;
    const optional = required.has(name) ? "" : "?";
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
    const rendered = renderType(propertySchema, inner, depth + 1, budget);
    propertyTypes.push(rendered);
    const description = typeof propertySchema?.description === "string"
      ? propertySchema.description
      : typeof propertySchema?.title === "string" ? propertySchema.title : undefined;
    return `${docComment(description, inner)}${inner}${key}${optional}: ${rendered};`;
  });

  const extra = schema.additionalProperties;
  if (extra === true) {
    members.push(`${inner}[key: string]: unknown;`);
  } else if (isPlainObject(extra)) {
    const optional = Object.keys(properties).some(name => !required.has(name));
    const types = [renderType(extra as JsonSchema, inner, depth + 1, budget), ...propertyTypes];
    if (optional) types.push("undefined");
    members.push(`${inner}[key: string]: ${unionTypes(types)};`);
  }

  return `{\n${members.join("\n")}\n${indent}}`;
}

// The JSDoc for one tool: the server's own description, plus what calling it will actually do.
function toolDoc(entry: ClassifiedTool, all: ClassifiedTool[]): string {
  const { tool, mode, autoApprovable } = entry;
  const detail = mode === "read"
    ? "Read-only: returns `{ status: \"ok\" }` and is recorded as an observation."
    : autoApprovable
      ? "Action: queued for approval, and may be auto-applied if you have opted in to its kind."
      : "Action: queued for approval; the result arrives via `getActionResult`.";
  const method = toMethodName(tool.name);
  // Say the wire name whenever it is not obvious from the method name, so an agent reading only this
  // comment can still reach the tool through `callTool`.
  const wire = method === tool.name || !toolMethodNames(all).has(method ?? "")
    ? undefined
    : `Calls \`${tool.name}\`.`;
  const description = tool.description ?? tool.title;
  return [...(description ? [description, ""] : []), detail, wire]
    .filter(part => part !== undefined)
    .join("\n");
}

// How a tool's arguments are expressed in its generated signature.
//
//   none      declares no inputs at all, so the parameter is omitted
//   freeform  accepts arbitrary keys but names none, so there is no interface worth generating
//   typed     declares properties, which become a named argument interface
type ArgumentStyle = "none" | "freeform" | "typed";

function argumentStyle(schema: JsonSchema | undefined): ArgumentStyle {
  if (!schema) return "none";

  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (properties && Object.keys(properties).length > 0) return "typed";

  // `additionalProperties` with nothing declared alongside it is how a tool says "any object".
  // Generating a no-argument method for one would make every valid call a type error, and the agent
  // trusts these signatures over the server's own description.
  const extra = schema.additionalProperties;
  return extra === true || isPlainObject(extra) ? "freeform" : "none";
}

// The interface name carrying each typed tool's arguments, keyed by wire name.
//
// `pascalCase` is lossy: `list_issues` and `list-issues` both reduce to `ListIssues`, so two tools
// can claim one interface name. Emitting both is not a harmless duplicate -- TypeScript merges
// same-named interfaces, and members that disagree turn the merge into a hard error, costing the
// agent the whole file rather than one tool. Colliding claims are therefore numbered.
//
// Ordered by wire name, not by catalog order: `tools/list` is unordered, so indexing by position
// would let the same two tools swap interfaces between one regeneration and the next.
function argsInterfaceNames(typeName: string, tools: ClassifiedTool[]): Map<string, string> {
  const claims = new Map<string, string[]>();
  for (const { tool } of tools) {
    if (argumentStyle(tool.inputSchema) !== "typed") continue;
    const base = `${typeName}_${pascalCase(tool.name)}Args`;
    const existing = claims.get(base);
    if (existing) existing.push(tool.name);
    else claims.set(base, [tool.name]);
  }

  const names = new Map<string, string>();
  for (const [base, wireNames] of claims) {
    if (wireNames.length === 1) {
      names.set(wireNames[0], base);
      continue;
    }
    wireNames.toSorted().forEach((wire, index) => {
      names.set(wire, base.replace(/Args$/, `${index + 1}Args`));
    });
  }
  return names;
}

/**
 * Renders the `.d.ts` for one server's session interface.
 *
 * `baseTypes` is prepended verbatim (see `types.d.ts`), because
 * `Gatekeeper.getTypeScriptTypes()` must return a self-contained file that exports every type named
 * by its `ResourceDescription`.
 */
export function generateSessionTypes(args: {
  baseTypes: string;
  serverId: string;
  serverName: string;
  endpoint: string;
  /**
   * This binding's scoped resource URL, which names the interface. Must be the same value the
   * connector passes to `sessionTypeName` in `describe()`, or the agent is told a type name the
   * generated file does not declare.
   */
  discriminator: string;
  trust: ServerTrust;
  tools: ClassifiedTool[];
}): string {
  const typeName = sessionTypeName(args.serverId, args.discriminator);
  const lines: string[] = [args.baseTypes.trimEnd(), ""];

  const methodNames = toolMethodNames(args.tools);
  const wireToMethod = new Map([...methodNames].map(([method, wire]) => [wire, method]));

  const serverName = inlineCommentSafe(args.serverName);
  const endpoint = inlineCommentSafe(args.endpoint);

  lines.push("// ---------------------------------------------------------------------------");
  lines.push(`// Generated from the tool catalog of "${serverName}" (${endpoint}).`);
  lines.push("// Regenerated when the server's catalog revision changes. A grant is a scope -- the");
  lines.push("// whole endpoint, one portal server, or a fixed list of tool names -- and not a");
  lines.push("// snapshot of this catalog: a tool the server adds later becomes callable too, unless");
  lines.push("// the grant named its tools explicitly.");
  lines.push("");

  // Per-tool argument interfaces, so agents can name and compose them.
  const argsNames = argsInterfaceNames(typeName, args.tools);
  for (const { tool } of args.tools) {
    if (argumentStyle(tool.inputSchema) !== "typed") continue;
    const argsName = argsNames.get(tool.name)!;
    lines.push(docComment(tool.description ?? tool.title, "").trimEnd());
    // Per tool, so one baroque schema degrades itself and not the rest of the catalog.
    const rendered = renderObject(tool.inputSchema!, "", 0, { remaining: MAX_RENDER_NODES });
    lines.push(`export interface ${argsName} ${rendered}`);
    lines.push("");
  }

  const readTools = args.tools.filter(entry => entry.mode === "read");
  const actionTools = args.tools.filter(entry => entry.mode === "action");


  lines.push("/**");
  lines.push(` * Session for the "${serverName}" MCP server.`);
  lines.push(" *");
  lines.push(` * Of the ${args.tools.length} currently described tool(s), ${readTools.length} are read-only`);
  lines.push(" * and return results immediately as observations. The remaining " + actionTools.length);
  lines.push(" * described tool(s) are treated as actions:");
  lines.push(" * `callTool` queues them for approval and returns `{ status: \"pending\" }`; the result");
  lines.push(" * becomes available through `getActionResult` once a human approves.");
  lines.push(" * When using this session from `executeCode`, return from that executeCode call as soon as");
  lines.push(" * an action is pending so its approval can appear in chat. Approval resumes the agent;");
  lines.push(" * denial ends the turn. Call `getActionResult` after approval.");
  if (args.trust === "byo") {
    lines.push(" *");
    lines.push(" * This server was supplied by the user, so no action is ever applied automatically.");
  }
  lines.push(" *");
  // Kept in the agent's view because the agent can otherwise build a share flow that cannot work.
  lines.push(" * Only the owner can open a workspace using this binding. To give it to someone else,");
  lines.push(" * publish it as a blueprint so they connect their own account.");
  lines.push(" */");
  lines.push(`export interface ${typeName} {`);
  lines.push("  /** Lists currently described tools. */");
  lines.push("  listTools(): Promise<McpToolInfo[]>;");
  lines.push(`  /** Searches for up to ${MAX_SEARCH_RESULTS} matching tool summaries. */`);
  lines.push("  listTools(options: { search: string; name?: never }): Promise<McpToolSummary[]>;");
  lines.push("  /** Returns zero or one exact granted tool definition by wire name. */");
  lines.push("  listTools(options: { name: string; search?: never }): Promise<McpToolInfo[]>;");
  lines.push("  listTools(options: McpToolListOptions): Promise<McpToolInfo[] | McpToolSummary[]>;");
  lines.push("");

  // One named method per tool, which is how a Gadget is expected to call them.
  for (const entry of args.tools) {
    const method = wireToMethod.get(entry.tool.name);
    if (!method) continue;
    lines.push(docComment(toolDoc(entry, args.tools), "  ").trimEnd());
    switch (argumentStyle(entry.tool.inputSchema)) {
      case "none":
        lines.push(`  ${method}(): Promise<McpCallResult>;`);
        break;
      case "freeform":
        lines.push(`  ${method}(args?: Record<string, unknown>): Promise<McpCallResult>;`);
        break;
      case "typed":
        lines.push(`  ${method}(args: ${argsNames.get(entry.tool.name)}): Promise<McpCallResult>;`);
        break;
    }
    lines.push("");
  }

  lines.push("  /**");
  lines.push("   * Calls a tool by its exact name, as the server publishes it.");
  lines.push("   *");
  lines.push("   * Equivalent to the named methods above, with static argument checking for tools that");
  lines.push("   * cannot have a named method.");
  lines.push("   */");
  for (const { tool } of args.tools) {
    switch (argumentStyle(tool.inputSchema)) {
      case "none":
        lines.push(`  callTool(name: ${quote(tool.name)}, args?: Record<string, never>): Promise<McpCallResult>;`);
        break;
      case "freeform":
        lines.push(`  callTool(name: ${quote(tool.name)}, args?: Record<string, unknown>): Promise<McpCallResult>;`);
        break;
      case "typed": {
        lines.push(`  callTool(name: ${quote(tool.name)}, args: ${argsNames.get(tool.name)}): Promise<McpCallResult>;`);
        break;
      }
    }
  }
  lines.push("  /** Calls a dynamically discovered tool by exact wire name. */");
  const knownToolNames = args.tools.map(({ tool }) => quote(tool.name)).join(" | ") || "never";
  lines.push("  callTool<Name extends string>(");
  lines.push("    name: Name,");
  lines.push(`    ...args: Name extends ${knownToolNames}`);
  lines.push("      ? [args: never]");
  lines.push("      : [args?: Record<string, unknown>]");
  lines.push("  ): Promise<McpCallResult>;");
  lines.push("");

  lines.push("  /**");
  lines.push("   * Fetches the result of a queued action.");
  lines.push("   *");
  lines.push("   * Returns `{ status: \"pending\" }` while the action is awaiting review, the completed");
  lines.push("   * result once applied, `{ status: \"rejected\" }` if denied, or `{ status: \"failed\" }`");
  lines.push("   * if the approved call failed.");
  lines.push("   */");
  lines.push("  getActionResult(actionId: number): Promise<McpCallResult>;");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}
