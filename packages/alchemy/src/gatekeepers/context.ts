import {
  PUBLIC_BASE_URL,
  type GatekeeperDeployment,
} from "../Gatekeeper.ts";

/** Configuration for the context gatekeeper. */
export interface ContextConfig {
  /** Set `false` to opt out of this default-enabled gatekeeper. */
  enabled?: boolean;
  /**
   * Isolates Context data shared by this deployment. Deployments with the
   * same sharing domain can share collections.
   * @default the deployment's public origin
   */
  sharingDomain?: string;
}

/**
 * Deploy the context-library gatekeeper (ambient, core) as its own Worker,
 * wired into the OS (`GATEKEEPER_CONTEXT` bindings + `/gatekeeper/context`
 * route). Deploys by default; disable with `Context({ enabled: false })`.
 * The entry, compat flags, Durable Objects, and its KV namespace derive
 * from the package's `wrangler.jsonc` at deploy time.
 */
export const Context = (config: ContextConfig = {}): GatekeeperDeployment => ({
  name: "context",
  package: "@gadgets/gatekeeper-context",
  prebuild: "build:app",
  // The gatekeeper reads the sharing domain from its vendor binding's
  // ctx.props; by default collections are shared per-origin.
  vendorProps: { sharingDomain: config.sharingDomain ?? PUBLIC_BASE_URL },
  defaultEnabled: true,
  enabled: config.enabled,
});

export default Context;
