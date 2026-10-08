// Whether a deployment the deploy flow installed has a newer release to take. The service that
// installed it describes the install in CLOUDFLARE_OS_DEPLOYMENT and answers the update check;
// AdminSettings stores the last check and reports it to admins.

import type { DeploymentUpdateStatus } from "@gadgets/workshop-shared/api";
import type { AdminConfig, UpdateCheck } from "./storage-schema/admin-settings-storage.js";

const HOUR_MS = 60 * 60 * 1000;
// How long a successful check is served before the next, and how long a failed one waits.
const CHECK_INTERVAL_MS = 6 * HOUR_MS;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5_000;
// The deploy service writes its times with toISOString().
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

/** The install, as the service that installed this deployment describes it. */
export type DeployServiceInstall = {
  /** The running release. */
  releaseId: string;
  /** The version tag every Worker of the deployment was uploaded with; "" when none was set. */
  versionTag: string;
  /**
   * The part every version tag of this installation ends with, whatever the release, so a Worker
   * with a tag that ends with it but is not `versionTag` runs another release of this installation.
   * Absent when the uploader did not record one: then no Worker reads as running another release.
   */
  versionTagSuffix?: string;
  /** The opaque link that opens the deploy flow for this installation. */
  updateUrl: string;
  /** Where to ask for the newest release. */
  updateCheckUrl: string;
};

function isHttpUrl(value: unknown): value is string {
  let protocol = typeof value === "string" ? URL.parse(value)?.protocol : undefined;
  return protocol === "http:" || protocol === "https:";
}

/**
 * The install CLOUDFLARE_OS_DEPLOYMENT describes, or null when this deployment was not installed
 * by the deploy flow. A value of any other shape, including the JSON as a string, is null too.
 */
export function deployServiceInstall(env: Cloudflare.Env): DeployServiceInstall | null {
  let value = env.CLOUDFLARE_OS_DEPLOYMENT;
  if (typeof value !== "object" || value === null) return null;
  let { releaseId, versionTag, versionTagSuffix, updateUrl, updateCheckUrl } =
      value as Record<string, unknown>;
  if (typeof releaseId !== "string" || releaseId === "" || typeof versionTag !== "string" ||
      (versionTagSuffix !== undefined &&
          (typeof versionTagSuffix !== "string" || versionTagSuffix === "")) ||
      !isHttpUrl(updateUrl) || !isHttpUrl(updateCheckUrl)) {
    return null;
  }
  return {
    releaseId, versionTag, ...(versionTagSuffix !== undefined && { versionTagSuffix }), updateUrl,
    updateCheckUrl,
  };
}

/**
 * The header the router sets to its own version tag ("" when it has none) on every request it
 * forwards to the backend, replacing any value the client sent. The router's copy of this name is
 * in packages/router/src/index.ts. It is a label shown to admins, never authority: any request
 * reaching the backend could carry it.
 */
export const ROUTER_VERSION_HEADER = "Cloudflare-OS-Router-Version";

/**
 * The router version tag `headers` carry ("" for a router with none), or undefined when they carry
 * none: the request did not come through the router.
 */
export function routerVersionTag(headers: Headers): string | undefined {
  return headers.get(ROUTER_VERSION_HEADER) ?? undefined;
}

/** Stands for a Worker that did not answer when asked for its version tag. */
export const NO_ANSWER: unique symbol = Symbol("no answer");

/**
 * What a Worker answered when asked for its version tag: the tag, "" or undefined when it has
 * none, or NO_ANSWER.
 */
export type VersionAnswer = string | undefined | typeof NO_ANSWER;

/**
 * How a Worker's version compares with `install`'s: "current" when its tag is the recorded one;
 * "unfinished" when it is another release of this installation, an update that stopped partway;
 * "modified" when it has no tag or one the deploy flow did not write; "unknown" when it did not
 * answer. Tags are only compared, never parsed.
 */
export function workerVersionState(answer: VersionAnswer, install: DeployServiceInstall)
    : "current" | "unfinished" | "modified" | "unknown" {
  if (answer === NO_ANSWER) return "unknown";
  if (!answer) return "modified";
  if (answer === install.versionTag) return "current";
  let suffix = install.versionTagSuffix;
  return suffix !== undefined && answer.endsWith(suffix) ? "unfinished" : "modified";
}

/**
 * Ask `updateCheckUrl` for the newest release, sending only the running release, and resolve to
 * the result an UpdateCheck stores. Throws on a failed request, and on any answer that is not a
 * release; the error never quotes the URL or the answer.
 */
export async function fetchLatestRelease(updateCheckUrl: string, runningReleaseId: string)
    : Promise<NonNullable<UpdateCheck["result"]>> {
  let url = new URL(updateCheckUrl);
  url.searchParams.set("from", runningReleaseId);
  let response = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!response.ok) {
    // An unread body holds its connection until it is garbage collected.
    await response.body?.cancel();
    throw new Error(`The update check answered with status ${response.status}.`);
  }
  // Read first, so a failed read (the timeout, a dropped connection) throws as itself.
  let text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A deploy service without the route answers its app's HTML, which is not a release.
  }
  let { releaseId, upgradeAvailable, availableSince } =
      (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  let since = typeof availableSince === "string" && ISO_UTC.test(availableSince)
      ? Date.parse(availableSince) : NaN;
  if (typeof releaseId !== "string" || releaseId === "" || typeof upgradeAvailable !== "boolean" ||
      (upgradeAvailable && Number.isNaN(since))) {
    throw new Error("The update check did not answer with a release.");
  }
  return {
    latestReleaseId: releaseId, upgradeAvailable, ...(upgradeAvailable && { availableSince: since }),
  };
}

/**
 * Whether to check again: the stored check is for another release, or its success is over 6 hours
 * old and its last attempt over 15 minutes old.
 */
export function updateCheckDue(check: UpdateCheck | null, releaseId: string, now: number): boolean {
  if (check?.from !== releaseId) return true;
  if (check.checkedAt !== undefined && now - check.checkedAt < CHECK_INTERVAL_MS) return false;
  return now - check.attemptedAt >= RETRY_INTERVAL_MS;
}

/** The deployment's settings for the update notice. */
export type UpdateSettings =
    Pick<AdminConfig, "updateChecksEnabled" | "updateMinimumAgeHours" | "updateNoticeSnoozeHours">;

/**
 * What admins are told about `install` under `settings`, from the stored check, if it was made for
 * the running release, and what each Worker of the deployment ("backend", "router", or a
 * gatekeeper's install slug) answered when asked for its version tag (see workerVersionState()).
 */
export function deploymentUpdateStatus(install: DeployServiceInstall, settings: UpdateSettings,
                                       check: UpdateCheck | null,
                                       versions: ReadonlyMap<string, VersionAnswer>, now: number)
    : DeploymentUpdateStatus {
  let current = check?.from === install.releaseId ? check : undefined;
  let result = current?.result;
  let workersIn = (state: ReturnType<typeof workerVersionState>) => [...versions]
      .filter(([, answer]) => workerVersionState(answer, install) === state)
      .map(([name]) => name).toSorted();
  let modifiedWorkers = workersIn("modified");
  let modified = modifiedWorkers.length > 0;
  let updateAvailable = result?.upgradeAvailable ?? false;
  let since = result?.availableSince;
  return {
    currentReleaseId: install.releaseId,
    ...(result && { latestReleaseId: result.latestReleaseId }),
    updateAvailable,
    ...(since !== undefined && { availableSince: new Date(since) }),
    notify: settings.updateChecksEnabled && updateAvailable && !modified && since !== undefined &&
        now - since >= settings.updateMinimumAgeHours * HOUR_MS,
    checksEnabled: settings.updateChecksEnabled,
    minimumAgeHours: settings.updateMinimumAgeHours,
    noticeSnoozeHours: settings.updateNoticeSnoozeHours,
    modified,
    modifiedWorkers,
    unfinishedWorkers: workersIn("unfinished"),
    updateUrl: install.updateUrl,
    ...(current?.checkedAt !== undefined && { checkedAt: new Date(current.checkedAt) }),
  };
}
