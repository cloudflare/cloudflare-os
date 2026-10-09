// The GitHub gatekeeper's deployment settings, shared by its entrypoints and Durable Objects.

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/** The worker's environment, with the settings a deployment may leave unset. */
export type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
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
