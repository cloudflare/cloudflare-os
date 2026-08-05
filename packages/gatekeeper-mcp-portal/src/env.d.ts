// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_PORTAL_URL?: string;
    MCP_PORTAL_NAME?: string;
    MCP_PORTAL_AUTH?: string;
    MCP_PORTAL_TOKEN?: string;
    MCP_PORTAL_TRUST_ANNOTATIONS?: string;
    MCP_CLIENT_NAME?: string;
    MCP_ALLOW_INSECURE?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./portal.js");
    durableNamespaces: "McpAccount" | "McpGatekeeperImpl";
  }
}

interface Env extends Cloudflare.Env {}
