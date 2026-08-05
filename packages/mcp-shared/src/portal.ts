// Recovers the upstream servers behind an aggregator endpoint, such as a Cloudflare MCP server
// portal, which flattens every upstream server's tools into one `tools/list`.
//
// Two facts from the portal's documented contract carry this. Every tool is named
// `{server_id}_{original_name}`, split on the FIRST underscore only, and an alias replaces the tool
// name but never the prefix; so membership is a string test that cannot fail open on a network
// error. And portals expose their own `portal_*` tools, one of which identifies the endpoint as a
// portal. See the MCP Server Portals connector's README.

import type { McpTool } from "./client.js";
import { MAX_TOOLS_PER_SERVER } from "./tools.js";

// The portal's built-in server-listing tool. Its presence in `tools/list` is what identifies an
// endpoint as a portal.
//
// Calling it yields display names, ordering and enabled state, but not authority: membership is
// decided by the `{server_id}_` prefix on each tool name, which is what `scopeAllows` enforces. A
// server the listing omits still owns its prefixed tools, and one it invents owns nothing. See
// `reconcilePortalServers`.
export const PORTAL_LIST_SERVERS_TOOL = "portal_list_servers";

// Prefix the portal reserves for its own session-management tools.
const PORTAL_NATIVE_PREFIX = "portal_";

// One upstream server behind a portal, as the portal itself reports it.
export type PortalServer = {
  // The server id that prefixes every one of its tool names.
  id: string;
  // Display name, falling back to the id.
  name: string;
  // Whether the server is currently enabled in this portal session.
  enabled: boolean;
};

// True for the portal's own tools, which are excluded from every grant: `portal_toggle_servers` and
// friends change which upstream servers the session can reach, so granting one would let a Gadget
// widen its own authority.
export function isPortalNativeTool(name: string): boolean {
  return name.startsWith(PORTAL_NATIVE_PREFIX);
}

// True when this tool list came from a portal.
//
// A truncated catalog counts as a portal regardless of what is in it: `tools/list` is unordered, so
// answering "not a portal" because the evidence fell past the cut would fail open on the `portal_*`
// exclusion above -- a real portal would be granted at its bare endpoint, and a Gadget holding that
// grant could call `portal_toggle_servers` to widen its own reach. `truncated` covers the byte
// budget as well as the tool count, which stops the listing without leaving a short array behind.
export function looksLikePortal(
  tools: Pick<McpTool, "name">[], truncated = false,
): boolean {
  if (truncated || tools.length >= MAX_TOOLS_PER_SERVER) return true;
  return tools.some(tool => tool.name === PORTAL_LIST_SERVERS_TOOL);
}

// The upstream server id a portal tool name belongs to, or null if it carries no prefix. Split on
// the first underscore only, so an upstream tool name may itself contain underscores.
function serverIdOfTool(name: string): string | null {
  const separator = name.indexOf("_");
  if (separator <= 0 || separator === name.length - 1) return null;
  return name.slice(0, separator);
}

// Whether `toolName` belongs to upstream server `serverId`. Syntactic, so enforcing a server scope
// never depends on reaching the portal.
export function toolBelongsToServer(toolName: string, serverId: string): boolean {
  return serverIdOfTool(toolName) === serverId;
}

// Groups a portal's tools by upstream server id, dropping the portal's own tools.
export function groupToolsByServer<T extends Pick<McpTool, "name">>(
  tools: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const tool of tools) {
    if (isPortalNativeTool(tool.name)) continue;
    const serverId = serverIdOfTool(tool.name);
    if (!serverId) continue;
    const existing = groups.get(serverId);
    if (existing) existing.push(tool);
    else groups.set(serverId, [tool]);
  }
  return groups;
}

// `portal_list_servers` answers in prose, not JSON. A Cloudflare portal replies with bullet lines of
// the form `- {display name} ({server id}): {status}`:
//
//   Available MCP Servers:
//
//   - Cloudflare documentation (test): \u2713 enabled
//   - Linear (linear): \u2713 enabled
//
// Display metadata only, so an unrecognized line is skipped rather than raised;
// `reconcilePortalServers` recovers any server the prose failed to describe.
function parseServerLine(line: string): PortalServer | null {
  const bulletLine = line.trimStart();
  if (bulletLine[0] !== "-" && bulletLine[0] !== "*" && bulletLine[0] !== "\u2022") return null;

  const content = bulletLine.slice(1);
  let nameStart = 0;
  while (nameStart < content.length && content[nameStart].trim().length === 0) ++nameStart;

  let open = -1;
  let closedOpen = -1;
  let close = -1;
  for (let index = nameStart; index < content.length; ++index) {
    const character = content[index];
    if (close >= 0) {
      if (character === ":") {
        const name = content.slice(nameStart, closedOpen).trimEnd();
        if (!name && nameStart === 0) return null;
        const id = content.slice(closedOpen + 1, close);
        return {
          id,
          name: name || id,
          enabled: !/disabled|\u2717|\u2718/i.test(content.slice(index + 1)),
        };
      }
      if (character.trim().length === 0) continue;
      close = -1;
      closedOpen = -1;
    }

    if (character === "(") {
      open = index;
    } else if (open >= 0 && character === ")") {
      if (index > open + 1) {
        closedOpen = open;
        close = index;
      }
      open = -1;
    } else if (open >= 0 && character.trim().length === 0) {
      open = -1;
    }
  }
  return null;
}

function parseServerLines(text: string): PortalServer[] {
  const servers: PortalServer[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const server = parseServerLine(line);
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    servers.push(server);
  }
  return servers;
}

// A `structuredContent` payload, if a future portal version supplies one. Read literally as an array
// of `{ id, name, enabled }`, with no guessing at alternative spellings.
function parseStructured(value: unknown): PortalServer[] {
  if (!Array.isArray(value)) return [];
  const servers: PortalServer[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    servers.push({
      id,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
      enabled: record.enabled !== false,
    });
  }
  return servers;
}

// Parses the upstream server list out of a `portal_list_servers` result. Empty when nothing
// parseable is present; callers fall back to the ids recovered from tool-name prefixes.
// Typed by what it reads rather than as `McpToolCallResult`, which a result satisfies: this is an
// untrusted reply and every field is re-checked here, so the loose type is the honest one.
export function parsePortalServers(
  result: { structuredContent?: unknown; content?: unknown },
): PortalServer[] {
  const structured = parseStructured(result.structuredContent);
  if (structured.length > 0) return structured;

  for (const block of Array.isArray(result.content) ? result.content : []) {
    const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
    if (type !== "text" || typeof text !== "string") continue;
    const servers = parseServerLines(text);
    if (servers.length > 0) return servers;
  }
  return [];
}

// Merges the portal's reported servers with the ids present in the tool list. With a complete
// catalog, tool names are the authority and reported empty servers are dropped. With a truncated
// catalog, absence is not evidence, so reported servers are retained for server-wide grants.
export function reconcilePortalServers(
  reported: PortalServer[], tools: Pick<McpTool, "name">[], truncated = false,
): PortalServer[] {
  const grouped = groupToolsByServer(tools);
  const byId = new Map(reported.map(server => [server.id, server]));
  const servers: PortalServer[] = [];
  const ids = truncated
    ? new Set([...reported.map(server => server.id), ...grouped.keys()])
    : grouped.keys();
  for (const id of ids) {
    servers.push(byId.get(id) ?? { id, name: id, enabled: true });
  }
  return servers.toSorted((a, b) => a.name.localeCompare(b.name));
}
