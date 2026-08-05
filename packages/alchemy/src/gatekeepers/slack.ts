import type { GatekeeperDeployment, SecretInput } from "../Gatekeeper.ts";

/** Configuration for the slack gatekeeper. */
export interface SlackConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
}

/**
 * Deploy the slack gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_SLACK` bindings + `/gatekeeper/slack` route).
 * Supplying the OAuth credentials is what installs it. Everything else
 * (entry, compat flags, Durable Objects) derives from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const Slack = (config: SlackConfig): GatekeeperDeployment => ({
  name: "slack",
  package: "@gadgets/slack-gatekeeper",
  prebuild: "build:configurator",
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});

export default Slack;
