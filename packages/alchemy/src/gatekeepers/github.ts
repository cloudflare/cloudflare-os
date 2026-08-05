import type { GatekeeperDeployment, SecretInput } from "../Gatekeeper.ts";

/** Configuration for the github gatekeeper. */
export interface GitHubConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
}

/**
 * Deploy the github gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_GITHUB` bindings + `/gatekeeper/github` route).
 * Supplying the OAuth credentials is what installs it. Everything else
 * (entry, compat flags, Durable Objects) derives from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const GitHub = (config: GitHubConfig): GatekeeperDeployment => ({
  name: "github",
  package: "@gadgets/github-gatekeeper",
  prebuild: "build:configurator",
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});

export default GitHub;
