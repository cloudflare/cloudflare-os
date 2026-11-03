import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const OBSERVABILITY_SCOPE = "workers-observability.read";
// Lets a Worker binding read the Worker's immutable ID, current name and versions, which pin its
// telemetry to that one Worker (see workers-api.ts). Of the permissions the Workers API accepts for
// those reads, this is the narrowest an OAuth client can request: it also allows tailing live logs,
// but not reading script content, as `workers-scripts.read` would.
const WORKER_METADATA_SCOPE = "workers-tail.read";
const DASHBOARD_ORIGIN = "https://dash.cloudflare.com";
const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;
// How Cloudflare spells both an account ID and a Worker ID (the legacy Scripts API's `tag`).
const CANONICAL_ID_PATTERN = /^[a-f\d]{32}$/;

export const ACCOUNT_OBSERVABILITY_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/workers-and-pages/observability`,
  title: "Cloudflare account observability",
  description: "Query logs, metrics, invocations, and traces across an account's Workers.",
  grantable: true,
};

export const WORKER_OBSERVABILITY_RESOURCE: SupportedResource = {
  urlPattern:
    `${DASHBOARD_ORIGIN}/:accountId/workers/services/view/:workerName/production/observability`,
  title: "Cloudflare Worker observability",
  description: "Query logs, metrics, invocations, and traces for one Worker.",
  grantable: true,
};

export const OBSERVABILITY_RESOURCES = [
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
];

const RESOURCE_PATTERNS = new Set(OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern));

/** Validate and normalize a Cloudflare account ID at an external input boundary. */
export function assertCloudflareAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
  return accountId.toLowerCase();
}

/** Whether a value is a Worker ID as Cloudflare spells it. */
export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ID_PATTERN.test(value);
}

// What a read through a binding reports as its subresource: the account an account binding reads
// (`account/<accountId>`), or the one Worker a Worker binding reads
// (`account/<accountId>/worker/<workerId>`), named by its immutable ID.
const ACCOUNT_FRAGMENT = "account";
const WORKER_FRAGMENT = "worker";

/** The subresource ID of an account's telemetry, or of one Worker's within it. */
export function observabilitySubresourceId(accountId: string, workerId?: string): string {
  const fragments = [{ name: ACCOUNT_FRAGMENT, id: assertCloudflareAccountId(accountId) }];
  if (workerId !== undefined) {
    if (!isWorkerId(workerId)) throw new Error("Invalid Cloudflare Worker ID.");
    fragments.push({ name: WORKER_FRAGMENT, id: workerId });
  }
  return formatSubresourceId({ fragments });
}

/**
 * The account, and the Worker if any, an ID from observabilitySubresourceId names. Throws for any
 * other ID, another spelling of the same account's included.
 */
export function parseObservabilitySubresourceId(id: string): { accountId: string; workerId?: string } {
  const { namespace, fragments: [account, worker, ...rest] } = parseSubresourceId(id);
  if (namespace === undefined && rest.length === 0 && account.name === ACCOUNT_FRAGMENT &&
      CANONICAL_ID_PATTERN.test(account.id) &&
      (worker === undefined || (worker.name === WORKER_FRAGMENT && isWorkerId(worker.id)))) {
    return worker === undefined ? { accountId: account.id } : { accountId: account.id, workerId: worker.id };
  }
  throw new Error("Not a Cloudflare Workers Observability subresource.");
}

export function accountObservabilityUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers-and-pages/observability`;
}

export function workerObservabilityUrl(accountId: string, workerName: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers/services/view/` +
    `${encodeURIComponent(workerName)}/production/observability`;
}

export function parseObservabilityResourceUrl(url: string): {
  accountId: string;
  workerName?: string;
} {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== DASHBOARD_ORIGIN) throw new Error();
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountId = assertCloudflareAccountId(segments[0] ?? "");
    if (segments.length === 3 && segments[1] === "workers-and-pages" &&
        segments[2] === "observability") {
      return { accountId };
    }
    if (segments.length === 7 && segments[1] === "workers" && segments[2] === "services" &&
        segments[3] === "view" && segments[4] && segments[5] === "production" &&
        segments[6] === "observability") {
      return { accountId, workerName: segments[4] };
    }
  } catch {
    // Normalize URL, percent-decoding, and account-ID failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare observability URL: ${url}`);
}

/**
 * The observability scopes a connection needs for these resource types: telemetry for either, and
 * Worker metadata for a Worker binding. Omitted means every type; `[]` means none.
 */
export function observabilityScopesForResources(resourceUrlPatterns?: string[]): string[] {
  if (resourceUrlPatterns?.some(pattern => !RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  const patterns = resourceUrlPatterns ?? [...RESOURCE_PATTERNS];
  if (patterns.length === 0) return [];
  return patterns.includes(WORKER_OBSERVABILITY_RESOURCE.urlPattern)
    ? [OBSERVABILITY_SCOPE, WORKER_METADATA_SCOPE]
    : [OBSERVABILITY_SCOPE];
}

/**
 * The resource types granted scopes allow. A connection granted telemetry before Worker bindings
 * needed Worker metadata allows only the account type, so connecting a Worker asks for the rest.
 */
export function grantedObservabilityResourcePatterns(scopes: string[]): string[] {
  if (!scopes.includes(OBSERVABILITY_SCOPE)) return [];
  return scopes.includes(WORKER_METADATA_SCOPE)
    ? OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern)
    : [ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern];
}
