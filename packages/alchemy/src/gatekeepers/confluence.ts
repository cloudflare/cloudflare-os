import type { GatekeeperDeployment, SecretInput } from "../Gatekeeper.ts";

/** Configuration for the confluence gatekeeper. */
export interface ConfluenceConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
}

/**
 * Deploy the confluence gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_CONFLUENCE` bindings + `/gatekeeper/confluence` route).
 * Supplying the OAuth credentials is what installs it. Everything else
 * (entry, compat flags, Durable Objects) derives from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const Confluence = (config: ConfluenceConfig): GatekeeperDeployment => ({
  name: "confluence",
  package: "@gadgets/confluence-gatekeeper",
  prebuild: "build:configurator",
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});

export default Confluence;
