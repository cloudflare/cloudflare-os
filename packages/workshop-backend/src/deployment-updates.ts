// Whether a deployment the deploy flow installed has a newer release to take. The service that
// installed it describes the install in CLOUDFLARE_OS_DEPLOYMENT and answers the update check;
// AdminSettings.getUpdateStatus() stores the last check and reports it to admins.

import { z } from "zod";
import {
  DEFAULT_UPDATE_MINIMUM_AGE_HOURS, DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS,
  type DeploymentUpdateStatus,
} from "@gadgets/workshop-shared/api";
import type { UpdateCheck } from "./storage-schema/admin-settings-storage.js";

const HOUR_MS = 60 * 60 * 1000;
// How long a successful check is served before the next, and how long a failed one waits.
const CHECK_INTERVAL_MS = 6 * HOUR_MS;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5_000;

/** The install, as the service that installed this deployment describes it. */
export type DeployServiceInstall = {
  /** The running release. */
  releaseId: string;
  /** The version tag the backend was uploaded with; "" when the uploader set none. */
  versionTag: string;
  /** The opaque link that opens the deploy flow for this installation. */
  updateUrl: string;
  /** Where to ask for the newest release. */
  updateCheckUrl: string;
};

const HTTP_URL = z.url({ protocol: /^https?$/ });

const INSTALL_SCHEMA: z.ZodType<DeployServiceInstall> = z.object({
  releaseId: z.string().min(1),
  versionTag: z.string(),
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
 * Whether to check again: the stored check is for another release, or its success is over 6 hours
 * old and its last attempt over 15 minutes old.
 */
export function updateCheckDue(check: UpdateCheck | null, releaseId: string, now: number): boolean {
  if (check?.from !== releaseId) return true;
  if (check.checkedAt !== undefined && now - check.checkedAt < CHECK_INTERVAL_MS) return false;
  return now - check.attemptedAt >= RETRY_INTERVAL_MS;
}

/**
 * What admins are told about `install`, from the stored check, if it was made for the running
 * release, and the running backend's version tag, which differs from the recorded one once the
 * backend was changed outside the deploy flow.
 */
export function deploymentUpdateStatus(install: DeployServiceInstall, check: UpdateCheck | null,
                                       runningTag: string | undefined, now: number)
    : DeploymentUpdateStatus {
  let current = check?.from === install.releaseId ? check : undefined;
  let result = current?.result;
  let modified = (runningTag ?? "") !== install.versionTag;
  let updateAvailable = result?.upgradeAvailable ?? false;
  let since = result?.availableSince;
  return {
    currentReleaseId: install.releaseId,
    ...(result && { latestReleaseId: result.latestReleaseId }),
    updateAvailable,
    ...(since !== undefined && { availableSince: new Date(since) }),
    notify: updateAvailable && !modified && since !== undefined &&
        now - since >= DEFAULT_UPDATE_MINIMUM_AGE_HOURS * HOUR_MS,
    noticeSnoozeHours: DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS,
    modified,
    updateUrl: install.updateUrl,
    ...(current?.checkedAt !== undefined && { checkedAt: new Date(current.checkedAt) }),
  };
}
