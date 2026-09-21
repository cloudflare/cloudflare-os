// Types shared between the MCP resource configurator UI module (which runs in a sandboxed iframe)
// and the `RpcTarget` that serves it from the gatekeeper Worker.

import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

/** Values collected by the configurator and turned into a resource URL. */
export type McpServerConfiguratorValues = {
  /**
   * `"all"` grants the whole server, so the binding follows it as tools are added. `"choose"` pins the
   * grant to `tools`.
   *
   * This is asked outright rather than inferred from whether every box happens to be ticked. The
   * difference between the two is what happens *next month*, which no arrangement of checkboxes can
   * show; and inferring it from a tool count fetched moments earlier would let a server publishing one
   * more tool mid-session silently turn "the whole server" into a frozen list.
   */
  mode?: string | null;
  /** Comma-separated, URI-encoded tool names the Gadget may call when `mode` is `"choose"`. */
  tools?: string | null;
};

/** Capability the configurator iframe is given, to describe the account's server. */
export interface McpServerConfiguratorRpc {
  /** The connected server's MCP endpoint URL, which the chosen scope is appended to. */
  getEndpoint(): Promise<string>;

  /** Every tool the server publishes, annotated with whether calls need approval. */
  listToolOptions(): Promise<ConfiguratorUIOption[]>;
}
