import type { GatekeeperDeployment, SecretInput } from "../Gatekeeper.ts";

/** Configuration for the cloudflare gatekeeper. */
export interface CloudflareConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
}

/**
 * Deploy the cloudflare gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_CLOUDFLARE` bindings + `/gatekeeper/cloudflare` route).
 * Supplying the OAuth credentials is what installs it. Everything else
 * (entry, compat flags, Durable Objects) derives from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const Cloudflare = (config: CloudflareConfig): GatekeeperDeployment => ({
  name: "cloudflare",
  package: "@gadgets/cloudflare-gatekeeper",
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});

export default Cloudflare;
