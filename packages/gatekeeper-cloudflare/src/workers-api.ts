// The Workers API reads that pin a Worker binding to one Worker. Telemetry names the Worker that
// emitted an event only by the name it had then (`$metadata.service`), which a rename frees and a
// new Worker can take, so a binding records the Worker's immutable ID when it is created, and its
// reads resolve that ID here to the Worker's current name and versions. A version belongs to one
// Worker for good, so the version an event names (`$workers.scriptVersion.id`) shows which Worker
// emitted it, however names have moved since.
//
// The API answers a path segment with the Worker whose ID *or name* it is, and a Worker may be
// named like another Worker's ID, so every lookup checks the field it asked by.

import { pathSegment } from "@gadgets/gatekeeper-kit/endpoint";
import { obsContext } from "./observability.js";
import { CloudflareObservabilityApiError, requestAccountApi } from "./observability-api.js";
import { invalidResponse, isRecord } from "./observability-parse.js";
import { isWorkerId } from "./resources.js";
import { VENDOR_ID } from "./vendor.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.workers-api", vendorId: VENDOR_ID,
});

const VERSIONS_PER_PAGE = 100;
// Bounds the walk at 1,000 versions. A version past it is never listed, so its telemetry is dropped
// rather than trusted; a cap is required because the loop is driven by the provider's own paging.
const MAX_VERSION_PAGES = 10;

/** The Worker a binding's reads are pinned to, as resolved for one read. */
export type WorkerScope = {
  /** The Worker's immutable ID: the Workers API's `id`, the legacy Scripts API's `tag`. */
  workerId: string;
  /** The Worker's current name, the `$metadata.service` of what it emits now. */
  name: string;
  /** Every version the Worker has, as `$workers.scriptVersion.id` names them. */
  versionIds: ReadonlySet<string>;
};

/**
 * The account's Worker with this ID or name, or null when it has none: Cloudflare answers 404, or
 * with a Worker that has `ref` only as its other field. Throws CloudflareObservabilityApiError for
 * any other failure, so a caller can tell a denial from an outage.
 */
export async function getWorker(
  getToken: () => Promise<string | null>,
  accountId: string,
  ref: { workerId: string } | { name: string },
): Promise<{ workerId: string; name: string } | null> {
  const asked = "workerId" in ref ? ref.workerId : ref.name;
  let worker: unknown;
  try {
    ({ result: worker } = await requestAccountApi(
      getToken, accountId, "workers", `workers/workers/${pathSegment(asked)}`));
  } catch (error) {
    if (error instanceof CloudflareObservabilityApiError && error.status === 404) return null;
    throw error;
  }
  if (!isRecord(worker) || !isWorkerId(worker.id) || typeof worker.name !== "string") {
    throw invalidResponse();
  }
  const matches = "workerId" in ref ? worker.id === ref.workerId : worker.name === ref.name;
  return matches ? { workerId: worker.id, name: worker.name } : null;
}

/**
 * The IDs of every version the Worker this path segment names has, up to the page cap, or null when
 * it names none.
 */
async function listVersionIds(
  getToken: () => Promise<string | null>,
  accountId: string,
  workerId: string,
): Promise<Set<string> | null> {
  const versionIds = new Set<string>();
  for (let page = 1; page <= MAX_VERSION_PAGES; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: String(VERSIONS_PER_PAGE) });
    let envelope: Record<string, unknown>;
    try {
      envelope = await requestAccountApi(getToken, accountId, "worker-versions",
        `workers/workers/${pathSegment(workerId)}/versions?${query}`);
    } catch (error) {
      if (error instanceof CloudflareObservabilityApiError && error.status === 404) return null;
      throw error;
    }
    const { result, result_info: info } = envelope;
    if (!Array.isArray(result) ||
        !result.every(version => isRecord(version) && typeof version.id === "string")) {
      throw invalidResponse();
    }
    for (const version of result as Array<{ id: string }>) versionIds.add(version.id);
    // The provider reports the page size it actually used, which may be lower than requested.
    const perPage = isRecord(info) && typeof info.per_page === "number" && info.per_page > 0
      ? info.per_page : VERSIONS_PER_PAGE;
    if (result.length === 0 || result.length < perPage) return versionIds;
  }
  logger.warn("stopped listing Worker versions at the page cap", {
    event: "observability.worker.versions.truncated", versionsListed: versionIds.size,
  });
  return versionIds;
}

/**
 * The bound Worker's current name and versions, through the binding owner's credentials. Throws a
 * 404 CloudflareObservabilityApiError when the account no longer has the Worker, which leaves the
 * binding nothing it may read: another Worker that took its name is not it.
 */
export async function resolveWorkerScope(
  getToken: () => Promise<string | null>,
  accountId: string,
  workerId: string,
): Promise<WorkerScope> {
  const versionIds = await listVersionIds(getToken, accountId, workerId);
  // Looked up after the listing, because the versions path resolves names too: had the Worker been
  // deleted first, the path could have reached a Worker named like its ID, which this lookup refuses.
  const worker = versionIds && await getWorker(getToken, accountId, { workerId });
  if (!versionIds || !worker) {
    throw new CloudflareObservabilityApiError(404,
      `The bound Worker (ID ${workerId}) no longer exists, or this account can no longer see it.`);
  }
  return { workerId, name: worker.name, versionIds };
}
