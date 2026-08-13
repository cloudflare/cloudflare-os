// Types shared between the MCP resource configurator UI module (which runs in a sandboxed iframe)
// and the `RpcTarget` that serves it from the gatekeeper Worker.

import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

/** Values collected by the configurator and turned into a resource URL. */
export type McpServerConfiguratorValues = {
  /**
   * The chosen upstream server id, when the endpoint is a portal fronting several servers. Null
   * until one is picked; a plain MCP server never sets it.
   */
  server?: string | null;
  /**
   * `"all"` grants the whole upstream server, so the binding follows it as tools are added. `"choose"`
   * pins the grant to `tools`.
   *
   * This is asked outright rather than inferred from whether every box happens to be ticked. The
   * difference between the two is what happens *next month*, which no arrangement of checkboxes can
   * show; and inferring it from a tool count fetched moments earlier would let a server publishing one
   * more tool mid-session silently turn "the whole server" into a frozen list.
   */
  mode?: string | null;
  /**
   * Comma-separated, URI-encoded tool names the Gadget may call when `mode` is `"choose"`. Cleared
   * when the server changes.
   */
  tools?: string | null;
  /**
   * Whether the upstream server list has been retrieved yet, discovered after first paint.
   *
   * Only three states, and there is deliberately no "this is a plain endpoint" one. Every grant
   * this connector makes names one upstream server, so a listing that comes back empty is a portal
   * with nothing grantable rather than a bare endpoint to grant whole. A fourth state meaning the
   * latter is what previously let a portal with no current upstreams serialize to its bare URL,
   * taking in every server added to it later.
   *
   * `"unavailable"` is failure, and is deliberately distinct from `"portal"`: not being able to ask
   * which servers are behind the endpoint must block the grant.
   */
  endpointKind?: "unknown" | "portal" | "unavailable";
};

/** Capability the configurator iframe is given, to describe the account's server. */
export interface McpServerConfiguratorRpc {
  /** The connected server's MCP endpoint URL, which the chosen scope is appended to. */
  getEndpoint(): Promise<string>;

  /**
   * The upstream servers behind the portal, with tool counts.
   *
   * Empty covers both "this endpoint is not a portal" and "it is a portal fronting nothing right
   * now". The form deliberately does not distinguish them: every grant here names one upstream
   * server, so neither case has anything it can safely grant, and both leave the form
   * unsubmittable. A plain MCP endpoint belongs to `gatekeeper-mcp`.
   *
   * Rejecting is different again, and must not be read as either: see `endpointKind`.
   */
  listServerOptions(): Promise<ConfiguratorUIOption[]>;

  /**
   * Tools the grant may cover, annotated with whether calls need approval. Narrowed to one
   * upstream server when `serverId` is given.
   */
  listToolOptions(serverId?: string): Promise<ConfiguratorUIOption[]>;
}
