import type { GatekeeperDeployment, SecretInput } from "../Gatekeeper.ts";

/** Configuration for the spotify gatekeeper. */
export interface SpotifyConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
}

/**
 * Deploy the spotify gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_SPOTIFY` bindings + `/gatekeeper/spotify` route).
 * Supplying the OAuth credentials is what installs it. Everything else
 * (entry, compat flags, Durable Objects) derives from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const Spotify = (config: SpotifyConfig): GatekeeperDeployment => ({
  name: "spotify",
  package: "@gadgets/spotify-gatekeeper",
  prebuild: "build:configurator",
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});

export default Spotify;
