// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    MCP_ALLOW_INSECURE?: string;
    MCP_CLIENT_NAME?: string;
    CF_ACCESS_CLIENT_ID?: string;
    CF_ACCESS_CLIENT_SECRET?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./mcp.js");
    durableNamespaces: "McpAccount" | "McpGatekeeperImpl";
  }
}

interface Env extends Cloudflare.Env {}
