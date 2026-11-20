// The Google gatekeeper's subservice metrics: which service a request went to, and whether a call
// is written at once or summed into the tally of the work that made it.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  recordSubserviceCall, type SubserviceCallInput, type SubserviceTally,
} from "@gadgets/observability/metrics";

/** The `source` of every Google API point. */
export const GOOGLE_API_SOURCE = "gatekeeper.google.api";

// The service behind each API host the clients here call.
const SERVICE_BY_HOST = new Map([
  ["gmail.googleapis.com", "google-gmail"],
  ["docs.googleapis.com", "google-docs"],
  ["sheets.googleapis.com", "google-sheets"],
  ["slides.googleapis.com", "google-slides"],
  ["chat.googleapis.com", "google-chat"],
  ["people.googleapis.com", "google-people"],
  ["bigquery.googleapis.com", "google-bigquery"],
  ["workspaceevents.googleapis.com", "google-events"],
  ["oauth2.googleapis.com", "google-oauth"],
]);

// www.googleapis.com serves several APIs, each under its own first path segment.
const SERVICE_BY_WWW_PATH = new Map([
  ["drive", "google-drive"],
  ["calendar", "google-calendar"],
  ["oauth2", "google-oauth"],
]);

/**
 * The service a Google API URL belongs to, from a closed table of hosts (and, for
 * www.googleapis.com, of first path segments); `google-other` for any other.
 */
export function googleService(url: string): string {
  let parsed = URL.parse(url);
  if (!parsed) return "google-other";
  if (parsed.hostname !== "www.googleapis.com") {
    return SERVICE_BY_HOST.get(parsed.hostname) ?? "google-other";
  }
  // An API's upload and batch endpoints sit one segment down, as in `/batch/drive/v3`.
  let [, first, second] = parsed.pathname.split("/");
  let api = first === "upload" || first === "batch" ? second : first;
  return SERVICE_BY_WWW_PATH.get(api) ?? "google-other";
}

// The tally of the work now running, when `summedInto` started it.
const runningTally = new AsyncLocalStorage<SubserviceTally>();

/**
 * Records one call: summed into the tally `summedInto` is running under, written at once
 * otherwise.
 */
export function recordCall(input: SubserviceCallInput): void {
  let tally = runningTally.getStore();
  if (tally) tally.add(input);
  else recordSubserviceCall(input);
}

/**
 * Runs `work` with every `recordCall` made in it, however deep and across awaits, summed into
 * `tally` rather than written. Work it leaves running after it settles sums there still: what
 * that work records after the tally's last flush is never written. A stream that `work` returns
 * is read outside it: what reading it records is summed only where each read is made in
 * `summedInto` as well.
 */
export function summedInto<T>(tally: SubserviceTally, work: () => T): T {
  return runningTally.run(tally, work);
}
