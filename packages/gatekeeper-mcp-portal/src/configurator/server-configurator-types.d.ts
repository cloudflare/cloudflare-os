// Types shared between the MCP resource configurator UI module (which runs in a sandboxed iframe)
// and the `RpcTarget` that serves it from the gatekeeper Worker.

import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

/** Values collected by the configurator and turned into a resource URL. */
export type McpServerConfiguratorValues = {
  /**
   * The chosen upstream server id. Null until one is picked.
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
   * There is deliberately no "this is a plain endpoint" state. Every grant this connector makes
   * names one upstream server, so an empty listing is ungrantable rather than a bare endpoint whose
   * grant would silently include servers added later.
   *
   * `"empty"` is a successful response with no direct upstream tools; `"unavailable"` is a failed
   * request. Both block the grant, but they require different remediation.
   */
  endpointKind?: "unknown" | "portal" | "empty" | "unavailable";
};

/** Capability the configurator iframe is given, to describe the account's server. */
export interface McpServerConfiguratorRpc {
  /** The connected server's MCP endpoint URL, which the chosen scope is appended to. */
  getEndpoint(): Promise<string>;

  /**
   * The upstream servers behind the portal.
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
   * Tools the grant may cover on one upstream server, annotated with whether calls need approval.
   */
  listToolOptions(serverId: string): Promise<ConfiguratorUIOption[]>;
}
