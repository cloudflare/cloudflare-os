// Cloudflare-gatekeeper-specific extension to the generic GatekeeperUser contract.
//
// The Cloudflare gatekeeper authenticates users (providesAuth) and, for the optional AI Gateway
// billing flow, lets the Workshop obtain a usable access token for the connected account. The
// Workshop holds the GatekeeperUser stub and narrows it to this interface to call the extra method.
// (More Cloudflare capabilities — Workers logs, R2, etc. — will be added here later.)

import { GatekeeperUser } from "./gatekeeper.js";

export interface CloudflareGatekeeperUser extends GatekeeperUser {
  /**
   * Returns a currently-usable (refreshed if needed) Cloudflare API access token for the connected
   * account, or null if the connection is broken/expired. Workshop-only — never exposed to gadgets
   * or agents. Used by the AI Gateway billing flow to read the credit balance and route BYOK
   * inference through the account's default AI Gateway.
   */
  getUsableAccessToken(): Promise<string | null>;
}
