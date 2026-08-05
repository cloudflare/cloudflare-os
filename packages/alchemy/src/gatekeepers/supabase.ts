import type { GatekeeperDeployment, SecretInput } from "../Gatekeeper.ts";

/** Configuration for the supabase gatekeeper. */
export interface SupabaseConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
}

/**
 * Deploy the supabase gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_SUPABASE` bindings + `/gatekeeper/supabase` route).
 * Supplying the OAuth credentials is what installs it. Everything else
 * (entry, compat flags, Durable Objects) derives from the package's
 * `wrangler.jsonc` at deploy time.
 */
export const Supabase = (config: SupabaseConfig): GatekeeperDeployment => ({
  name: "supabase",
  package: "@gadgets/supabase-gatekeeper",
  prebuild: "build:configurator",
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});

export default Supabase;
