// Configuration shared by every part of the Acme Service gatekeeper: the Worker's environment and
// the provider's origins.

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import type { AuthEnv } from "./acme-auth";

/** The vendor id: the router's `/gatekeeper/acme/` path segment, and the log attribution. */
export const VENDOR_ID = "acme";

/** The Worker's environment. */
export type Env = Cloudflare.Env & AuthEnv & {
  /** This Worker's public base URL, ending in `/gatekeeper/acme`. */
  BASE_URL?: string;
  // #if hooks-app
  /**
   * The secret the provider signs its webhook's deliveries to `{BASE_URL}/webhook` with. Hooks are
   * refused while it is unset.
   */
  ACME_WEBHOOK_SECRET?: string;
  // #endif
};

// STOP(origins): The provider's API and web origins. If either varies by account (a region, a
// tenant subdomain, a self-hosted instance), carry what selects it in the identity and the
// binding's props instead of a constant.
/** Where API requests go. */
export const API_ORIGIN = "https://api.acme.example";
/** The web app, whose links name resources. */
export const WEB_ORIGIN = "https://acme.example";

/** This Worker's public base URL, without a trailing slash. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/acme");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}
