// The GitHub gatekeeper's deployment settings, shared by its entrypoints and Durable Objects.

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/** The worker's environment, with the settings a deployment may leave unset. */
export type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  /** Browser-facing GitHub instance, defaulting to github.com. */
  GITHUB_URL?: string;
  /** Worker-facing origin when different from GITHUB_URL. */
  GITHUB_API_URL?: string;
  /**
   * The public origin GitHub delivers webhooks to, such as `https://gadgets.example.com`: the
   * deployment's own, or a tunnel's in local development. GitHub hooks are refused while it is
   * unset.
   */
  WEBHOOK_ORIGIN?: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function instanceOrigin(name: "GITHUB_URL" | "GITHUB_API_URL", raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${name} must use https (http is accepted on localhost only).`);
  }
  if (url.username || url.password) throw new Error(`${name} must not include credentials.`);
  if (stripTrailingSlashes(url.pathname) !== "" || url.search || url.hash) {
    throw new Error(`${name} must be an origin (scheme and host only).`);
  }
  return url.origin;
}

/** The origin users visit and resource URLs name. */
export function instanceUrl(env: Env): string {
  return instanceOrigin("GITHUB_URL", env.GITHUB_URL || "https://github.com");
}

/** Worker-facing endpoints for the configured instance. */
export function githubInstance(env: Env): GitHubInstance {
  const webOrigin = instanceUrl(env);
  const apiOrigin = env.GITHUB_API_URL ? instanceOrigin("GITHUB_API_URL", env.GITHUB_API_URL) : webOrigin;
  const cloud = webOrigin === "https://github.com" && !env.GITHUB_API_URL;
  return { webOrigin, apiOrigin, restBase: cloud ? "https://api.github.com" : `${apiOrigin}/api/v3`,
    graphqlUrl: cloud ? "https://api.github.com/graphql" : `${apiOrigin}/api/graphql` };
}

export type GitHubInstance = {
  webOrigin: string;
  apiOrigin: string;
  restBase: string;
  graphqlUrl: string;
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
