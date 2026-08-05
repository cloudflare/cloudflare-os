import type { GatekeeperDeployment } from "../Gatekeeper.ts";

/**
 * Deploy the Home Assistant gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_HOMEASSISTANT` bindings + `/gatekeeper/homeassistant`
 * route). Zero-config to deploy — each user connects their own HA instance
 * by pasting its URL and a long-lived access token — but a niche consumer
 * surface, so it deploys only when listed. The entry, compat flags, and
 * Durable Objects derive from the package's `wrangler.jsonc` at deploy
 * time.
 */
export const HomeAssistant = (): GatekeeperDeployment => ({
  name: "homeassistant",
  package: "@gadgets/homeassistant-gatekeeper",
  prebuild: "build:configurator",
});

export default HomeAssistant;
