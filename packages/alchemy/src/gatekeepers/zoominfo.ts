import type {
  EnvInput,
  GatekeeperDeployment,
  SecretInput,
} from "../Gatekeeper.ts";

/** Configuration for the zoominfo gatekeeper. */
export interface ZoomInfoConfig {
  /** The OAuth app's client ID. Deployed as a secret on the worker. */
  clientId: SecretInput;
  /** The OAuth app's client secret. Deployed as a secret on the worker. */
  clientSecret: SecretInput;
  /**
   * Override for ZoomInfo's GTM API base URL (`ZOOMINFO_API_BASE_URL`).
   * @default ZoomInfo's production API endpoint
   */
  apiBaseUrl?: string;
  /**
   * Override for the OAuth authorize URL (`ZOOMINFO_AUTHORIZE_URL`).
   * @default ZoomInfo's production authorize endpoint
   */
  authorizeUrl?: string;
  /**
   * Override for the OAuth token URL (`ZOOMINFO_TOKEN_URL`).
   * @default ZoomInfo's production token endpoint
   */
  tokenUrl?: string;
}

/**
 * Deploy the zoominfo gatekeeper as its own Worker, wired into the OS
 * (`GATEKEEPER_ZOOMINFO` bindings + `/gatekeeper/zoominfo` route).
 * Supplying the OAuth credentials is what installs it. The entry, compat
 * flags, and Durable Objects derive from the package's `wrangler.jsonc` at
 * deploy time.
 */
export const ZoomInfo = (config: ZoomInfoConfig): GatekeeperDeployment => {
  const env: Record<string, EnvInput> = {
    CLIENT_ID: config.clientId,
    CLIENT_SECRET: config.clientSecret,
  };
  if (config.apiBaseUrl !== undefined) {
    env.ZOOMINFO_API_BASE_URL = config.apiBaseUrl;
  }
  if (config.authorizeUrl !== undefined) {
    env.ZOOMINFO_AUTHORIZE_URL = config.authorizeUrl;
  }
  if (config.tokenUrl !== undefined) {
    env.ZOOMINFO_TOKEN_URL = config.tokenUrl;
  }
  return {
    name: "zoominfo",
    package: "@gadgets/zoominfo-gatekeeper",
    prebuild: "build:configurator",
    env,
    secrets: ["CLIENT_ID", "CLIENT_SECRET"],
  };
};

export default ZoomInfo;
