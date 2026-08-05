// One module per built-in gatekeeper, each exporting a plugin function that
// returns the gatekeeper's `GatekeeperDeployment` manifest.
//
// These live here (rather than in each gatekeeper package) as the
// conservative choice — the gatekeeper packages' export surfaces stay
// untouched. Moving each module into its package (`@gadgets/<pkg>/deploy`)
// so the gatekeeper owns its deployment is the natural follow-up proposal.
export { Cloudflare, type CloudflareConfig } from "./cloudflare.ts";
export { Confluence, type ConfluenceConfig } from "./confluence.ts";
export { Context, type ContextConfig } from "./context.ts";
export { GitHub, type GitHubConfig } from "./github.ts";
export { Google, type GoogleConfig } from "./google.ts";
export { HomeAssistant } from "./homeassistant.ts";
export { Linear, type LinearConfig } from "./linear.ts";
export { Mcp, type McpConfig } from "./mcp.ts";
export { McpPortal, type McpPortalConfig } from "./mcp-portal.ts";
export { Notion, type NotionConfig } from "./notion.ts";
export { Scheduler, type SchedulerConfig } from "./scheduler.ts";
export { Slack, type SlackConfig } from "./slack.ts";
export { Spotify, type SpotifyConfig } from "./spotify.ts";
export { Supabase, type SupabaseConfig } from "./supabase.ts";
export { ZoomInfo, type ZoomInfoConfig } from "./zoominfo.ts";
