// The GitHub gatekeeper's deployment settings, shared by its entrypoints and Durable Objects.

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/** The worker's environment, with the settings a deployment may leave unset. */
export type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  /**
   * The public origin GitHub delivers webhooks to, such as `https://gadgets.example.com`: the
   * deployment's own, or a tunnel's in local development. GitHub hooks are refused while it is
   * unset.
   */
  WEBHOOK_ORIGIN?: string;
};

/** Where browsers reach this worker, e.g. `https://gadgets.example.com/gatekeeper/github`. */
export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/github");
}

/** The path every request this worker serves starts with: `getBaseUrl()`'s, or `""` at the root. */
export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/**
 * The origin GitHub delivers webhooks to, or undefined when this deployment has not configured
 * GitHub hooks.
 * @throws If `WEBHOOK_ORIGIN` is not an `https` origin.
 */
export function webhookOrigin(env: Env): string | undefined {
  if (env.WEBHOOK_ORIGIN === undefined) return undefined;
  const origin = URL.parse(env.WEBHOOK_ORIGIN);
  if (origin?.protocol !== "https:" || origin.href !== `${origin.origin}/`) {
    throw new Error("WEBHOOK_ORIGIN must be an https origin, such as https://gadgets.example.com.");
  }
  return origin.origin;
}
