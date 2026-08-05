import type {
  EnvInput,
  GatekeeperDeployment,
  SecretInput,
} from "../Gatekeeper.ts";

/** Configuration for the MCP Server Portals gatekeeper. */
export interface McpPortalConfig {
  /** The portal endpoint every user reaches MCP servers through (`MCP_PORTAL_URL`). */
  url: string;
  /** Display name for the portal (`MCP_PORTAL_NAME`). */
  name?: string;
  /** Auth mode expected by the portal (`MCP_PORTAL_AUTH`). */
  auth?: string;
  /**
   * Static bearer token, when the portal uses token auth
   * (`MCP_PORTAL_TOKEN`). Deployed as a secret on the worker.
   */
  token?: SecretInput;
  /**
   * Whether to trust tool annotations reported by the portal
   * (`MCP_PORTAL_TRUST_ANNOTATIONS`).
   */
  trustAnnotations?: boolean;
  /**
   * Allow a plaintext-HTTP portal endpoint (`MCP_ALLOW_INSECURE`).
   * @default false — the package's wrangler.jsonc default
   */
  allowInsecure?: boolean;
}

/**
 * Deploy the MCP Server Portals gatekeeper as its own Worker, wired into the
 * OS (`GATEKEEPER_MCP_PORTAL` bindings + `/gatekeeper/mcp-portal` route).
 * Configuring it is what installs it: an admin points the whole deployment
 * at one portal URL and every user reaches the organization's approved MCP
 * servers through it. The entry, compat flags, and Durable Objects derive
 * from the package's `wrangler.jsonc` at deploy time.
 */
export const McpPortal = (config: McpPortalConfig): GatekeeperDeployment => {
  const env: Record<string, EnvInput> = { MCP_PORTAL_URL: config.url };
  if (config.name !== undefined) env.MCP_PORTAL_NAME = config.name;
  if (config.auth !== undefined) env.MCP_PORTAL_AUTH = config.auth;
  if (config.token !== undefined) env.MCP_PORTAL_TOKEN = config.token;
  if (config.trustAnnotations !== undefined) {
    env.MCP_PORTAL_TRUST_ANNOTATIONS = String(config.trustAnnotations);
  }
  if (config.allowInsecure) env.MCP_ALLOW_INSECURE = "true";
  return {
    name: "mcp-portal",
    package: "@gadgets/mcp-portal-gatekeeper",
    prebuild: "build:configurator",
    env,
    secrets: ["MCP_PORTAL_TOKEN"],
  };
};

export default McpPortal;
