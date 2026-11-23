// Whether a deployment the deploy flow installed has a newer release to take. The service that
// installed it describes the install in CLOUDFLARE_OS_DEPLOYMENT and answers the update check;
// AdminSettings stores the last check and reports it to admins.

import { z } from "zod";
import type { DeploymentUpdateStatus } from "@gadgets/workshop-shared/api";
import type { AdminConfig, UpdateCheck } from "./storage-schema/admin-settings-storage.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// The longest a failed check waits before the next. A successful one waits the check interval.
const RETRY_INTERVAL_MS = 15 * MINUTE_MS;
const CHECK_TIMEOUT_MS = 5_000;

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

const HTTP_URL = z.url({ protocol: /^https?$/ });

const INSTALL_SCHEMA: z.ZodType<DeployServiceInstall> = z.object({
  releaseId: z.string().min(1),
  versionTag: z.string(),
  versionTagSuffix: z.string().min(1).optional(),
  updateUrl: HTTP_URL,
  updateCheckUrl: HTTP_URL,
});

// The update check's answer. The deploy service writes its times with toISOString().
const RELEASE_SCHEMA = z.discriminatedUnion("upgradeAvailable", [
  z.object({ releaseId: z.string().min(1), upgradeAvailable: z.literal(false) }),
  z.object({
    releaseId: z.string().min(1), upgradeAvailable: z.literal(true), availableSince: z.iso.datetime(),
  }),
]);

/**
 * The install CLOUDFLARE_OS_DEPLOYMENT describes, or null when this deployment was not installed
 * by the deploy flow. A value of any other shape, including the JSON as a string, is null too.
 */
export function deployServiceInstall(env: Cloudflare.Env): DeployServiceInstall | null {
  return INSTALL_SCHEMA.safeParse(env.CLOUDFLARE_OS_DEPLOYMENT).data ?? null;
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
  let release = RELEASE_SCHEMA.safeParse(body).data;
  if (!release) throw new Error("The update check did not answer with a release.");
  return {
    latestReleaseId: release.releaseId, upgradeAvailable: release.upgradeAvailable,
    ...(release.upgradeAvailable && { availableSince: Date.parse(release.availableSince) }),
  };
}

/**
 * Whether to check again: the stored check is for another release, or its success is over
 * `intervalMinutes` old and its last attempt is older than the interval or 15 minutes, whichever is
 * shorter. A success is its own last attempt, so only a failure makes the second wait.
 */
export function updateCheckDue(check: UpdateCheck | null, releaseId: string,
                               intervalMinutes: number, now: number): boolean {
  if (check?.from !== releaseId) return true;
  let interval = intervalMinutes * MINUTE_MS;
  if (check.checkedAt !== undefined && now - check.checkedAt < interval) return false;
  return now - check.attemptedAt >= Math.min(interval, RETRY_INTERVAL_MS);
}

/** The deployment's settings for the update notice. */
export type UpdateSettings = Pick<AdminConfig, "updateChecksEnabled" | "updateCheckIntervalMinutes" |
    "updateMinimumAgeHours" | "updateNoticeSnoozeHours">;

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
    checkIntervalMinutes: settings.updateCheckIntervalMinutes,
    minimumAgeHours: settings.updateMinimumAgeHours,
    noticeSnoozeHours: settings.updateNoticeSnoozeHours,
    modified,
    modifiedWorkers,
    unfinishedWorkers: workersIn("unfinished"),
    updateUrl: install.updateUrl,
    ...(current?.checkedAt !== undefined && { checkedAt: new Date(current.checkedAt) }),
  };
}
