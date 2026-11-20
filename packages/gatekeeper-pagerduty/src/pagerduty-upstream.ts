// PagerDuty as this gatekeeper's upstream: the REST paths it calls, by which a request is named,
// and the client every request to PagerDuty is sent through and counted by (`subservice/v1` points
// under the source `gatekeeper.pagerduty.api`). `PagerDutyApi` sends the REST API's requests
// through it, the OAuth client its token requests, and the ID-token check the fetch of the keys a
// token is signed with.

import { ID, type Routes, type Tree } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream, type RetryPolicy } from "@gadgets/gatekeeper-kit/upstream";
import { VENDOR_ID, apiOrigin } from "./pagerduty-env";

// What is called under a region's REST root. Shift-based schedules are served under `/v3`, by the
// names of the layer-based ones.
const REST_API: Tree = {
  users: { me: "GET", [ID]: {} },
  teams: { [ID]: { members: {} } },
  services: { [ID]: {} },
  escalation_policies: { [ID]: {} },
  priorities: {},
  oncalls: {},
  incidents: {
    [ID]: { notes: {}, alerts: {}, log_entries: {}, responder_requests: {}, status_updates: {}, snooze: "POST" },
  },
  schedules: { [ID]: { overrides: { [ID]: {} } } },
  v3: { schedules: { [ID]: { overrides: {} } } },
};

/**
 * The paths this gatekeeper calls, under the REST root of each region. A request is named by the
 * last resource of its path and what is done to it: `incidents.update`, `overrides.create`,
 * `users.me`, `incidents.snooze`. A request to a path that is not here is counted under its HTTP
 * method: add the path to name it.
 */
export const PAGERDUTY_ROUTES: Routes = [
  [`${apiOrigin("us")}/`, REST_API],
  [`${apiOrigin("eu")}/`, REST_API],
];

/**
 * The names given where a request is made, to one that is under no REST root: the fetch of the
 * keys PagerDuty signs its ID tokens with. The OAuth client names its own token requests.
 */
export const PAGERDUTY_OPERATIONS = ["certs.get"] as const;

/** A name given where a request is made: one of `PAGERDUTY_OPERATIONS`. */
export type PagerDutyOperation = (typeof PAGERDUTY_OPERATIONS)[number];

/**
 * The longest a read waits before it is sent again, which is the longest wait of the client's own
 * retry policy: a rate limit that resets later than this is the caller's to wait out.
 */
const MAX_WAIT_MS = 10_000;

/** The statuses of a failure that may pass, after which the client's own rule sends a read again. */
const TRANSIENT: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The seconds until PagerDuty's rate limit resets, as the `ratelimit-reset` of a 429 names them,
 * rounded up to whole ones.
 * @param headers The headers of the answer.
 * @returns The seconds, or undefined where the header is missing or holds no positive number.
 */
export function rateLimitResetSeconds(headers: Headers): number | undefined {
  const reset = Number(headers.get("ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : undefined;
}

/**
 * Whether an answer says that nothing is left of PagerDuty's rate limit, which it says on a
 * success too: a request sent before the limit resets is refused.
 * @param headers The headers of the answer.
 * @returns Whether its `ratelimit-remaining` is none.
 */
export function rateLimitSpent(headers: Headers): boolean {
  return headers.get("ratelimit-remaining")?.trim() === "0";
}

// A `Retry-After` that counts seconds, and one that is a date in the form a server sends it in
// (RFC 9110, 5.6.7), as `Sun, 06 Nov 1994 08:49:37 GMT`, which `Date.parse` reads.
const SECONDS = /^\d+$/;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/;

// The milliseconds a `Retry-After` asks to wait: its count of seconds, or the time left until its
// date, which is none once the date is past. Undefined for what is neither.
function retryAfterMs(retryAfter: string): number | undefined {
  const asked = retryAfter.trim();
  if (SECONDS.test(asked)) return Number(asked) * 1000;
  const at = HTTP_DATE.test(asked) ? Date.parse(asked) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(at - Date.now(), 0);
}

// The milliseconds a 429 asks to wait before its request is sent again: until the reset it names,
// or what its `Retry-After` asks where it carries one that asks for longer. Undefined where it
// names neither, and where its `Retry-After` is neither a count of seconds nor such a date: that
// one may ask for any wait.
function rateLimitWaitMs(headers: Headers): number | undefined {
  const reset = rateLimitResetSeconds(headers);
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) return reset === undefined ? undefined : reset * 1000;
  const asked = retryAfterMs(retryAfter);
  return asked === undefined ? undefined : Math.max((reset ?? 0) * 1000, asked);
}

/**
 * When a request to PagerDuty is sent again. PagerDuty says when a rate limit resets in the
 * `ratelimit-reset` of its 429, and a request sent before then is refused again: a read answered
 * 429 waits for the reset and is then sent again, where the wait is `MAX_WAIT_MS` at most, and is
 * handed back to its caller after the one send where the wait is longer or the answer names none.
 * A `Retry-After`, should a 429 carry one, is a wait it names too, in seconds or until a date, and
 * the longer of the two is the wait: one that asks for none has the read sent again at once, and
 * one that cannot be read hands the 429 back. A read answered 502, 503 or 504 is sent again by the
 * client's own rule and wait, and a write never is.
 */
const RETRY = {
  maxDelayMs: MAX_WAIT_MS,
  retryable: (status, request, headers) => {
    if (!request.idempotent) return false;
    if (status !== 429) return TRANSIENT.has(status);
    const wait = rateLimitWaitMs(headers);
    return wait !== undefined && wait <= MAX_WAIT_MS;
  },
  delayMs: response => response.status === 429 ? rateLimitWaitMs(response.headers) : undefined,
} satisfies RetryPolicy;

/**
 * The client every request to PagerDuty goes through: 30 seconds an attempt, no redirect followed,
 * and a GET sent again, three times at most, after a 502, 503 or 504, a network failure or a
 * timeout, and after a 429 once the rate limit has reset (`RETRY`). A write is sent once, being no
 * request that is safe to send twice: an action reads the failure of its own write (`once` in
 * pagerduty-actions.ts).
 */
export const pagerdutyUpstream = defineUpstream({ vendorId: VENDOR_ID, routes: PAGERDUTY_ROUTES, retry: RETRY });
