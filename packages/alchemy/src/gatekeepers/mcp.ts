import type { GatekeeperDeployment } from "../Gatekeeper.ts";

/** Configuration for the mcp gatekeeper. */
export interface McpConfig {
  /** Set `false` to opt out of this default-enabled gatekeeper. */
  enabled?: boolean;
  /**
   * Allow plaintext-HTTP MCP endpoints (`MCP_ALLOW_INSECURE`).
   * @default false — the package's wrangler.jsonc default
   */
  allowInsecure?: boolean;
}

/**
 * Deploy the connect-any-MCP-server gatekeeper (core) as its own Worker,
 * wired into the OS (`GATEKEEPER_MCP` bindings + `/gatekeeper/mcp` route).
 * Deploys by default; disable with `Mcp({ enabled: false })`. The entry,
 * compat flags, and Durable Objects derive from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const Mcp = (config: McpConfig = {}): GatekeeperDeployment => ({
  name: "mcp",
  package: "@gadgets/mcp-gatekeeper",
  prebuild: "build:configurator",
  // Only override the wrangler-declared default when opting in.
  env: config.allowInsecure ? { MCP_ALLOW_INSECURE: "true" } : undefined,
  defaultEnabled: true,
  enabled: config.enabled,
});

export default Mcp;
