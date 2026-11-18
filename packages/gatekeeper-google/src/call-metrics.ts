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

/** An item's ID, which is never read. */
export const ID = "{id}";
/** An ID that is the rest of the path, as the name of a Chat attachment is. */
export const REST = "{id+}";
/** A resource that has no items: a GET of it is a `get`. */
export const ONE = "one";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Tree = { readonly [segment: string]: Tree | Method | typeof ONE };
export type Routes = readonly (readonly [prefix: string, tree: Tree])[];

/**
 * The paths the clients call, as a tree under each API's root, from which a request is named.
 * An object is a resource and `{id}` one of its items. A method is a verb the path spells out
 * (`/threads/{id}/modify`, or after a colon as in `/spaces:search`), with the method that calls
 * it. `ONE` is a resource that has no items. A request to a path that is not here is counted
 * under its HTTP method: add the path to name it. A URL is read under the first root it starts
 * with.
 */
export const ROUTES: Routes = [
  ["https://gmail.googleapis.com/gmail/v1/users/me/", {
    threads: { [ID]: { modify: "POST", trash: "POST", untrash: "POST" } },
    messages: { send: "POST", batchModify: "POST", [ID]: { attachments: { [ID]: {} } } },
    drafts: { send: "POST", [ID]: {} },
    labels: { [ID]: {} },
    history: {},
    profile: ONE,
    watch: "POST",
  }],
  ["https://www.googleapis.com/drive/v3/", {
    files: {
      generateIds: "GET",
      [ID]: { copy: "POST", permissions: { [ID]: {} }, comments: { [ID]: { replies: {} } } },
    },
    drives: {},
    about: ONE,
  }],
  ["https://www.googleapis.com/upload/drive/v3/", { files: { [ID]: {} } }],
  ["https://www.googleapis.com/calendar/v3/users/me/", { calendarList: { [ID]: {} } }],
  ["https://www.googleapis.com/calendar/v3/", {
    calendars: { [ID]: { events: { [ID]: {} } } },
    freeBusy: "POST",
  }],
  ["https://bigquery.googleapis.com/bigquery/v2/", {
    projects: { [ID]: {
      datasets: { [ID]: { tables: { [ID]: {} } } },
      queries: { [ID]: {} },
      jobs: { [ID]: { cancel: "POST" } },
    } },
  }],
  ["https://docs.googleapis.com/v1/", { documents: { [ID]: { ":batchUpdate": "POST" } } }],
  ["https://sheets.googleapis.com/v4/", {
    spreadsheets: { [ID]: {
      ":getByDataFilter": "POST", ":batchUpdate": "POST",
      values: { ":batchGet": "GET", ":batchGetByDataFilter": "POST" },
      developerMetadata: { [ID]: {} },
    } },
  }],
  ["https://slides.googleapis.com/v1/", {
    presentations: { [ID]: { ":batchUpdate": "POST", pages: { [ID]: { thumbnail: ONE } } } },
  }],
  ["https://chat.googleapis.com/v1/", {
    spaces: {
      ":search": "GET", ":findDirectMessage": "GET", ":findGroupChats": "GET", ":setup": "POST",
      [ID]: {
        messages: { ":search": "POST", [ID]: { reactions: { [ID]: {} } } },
        members: { [ID]: {} },
      },
    },
    media: { [REST]: {} },
  }],
  ["https://people.googleapis.com/v1/", {
    people: { ":searchDirectoryPeople": "GET", ":batchGet": "GET" },
  }],
  ["https://workspaceevents.googleapis.com/v1/", {
    subscriptions: { [ID]: { ":reactivate": "POST" } },
  }],
  ["https://www.googleapis.com/oauth2/v3/", { userinfo: ONE }],
  ["https://oauth2.googleapis.com/", { revoke: "POST" }],
];

// What a method does to a resource whose path has no verb of its own. A GET lists a resource and
// gets an item.
const METHOD_VERBS = new Map([
  ["POST", "create"], ["PUT", "update"], ["PATCH", "patch"], ["DELETE", "delete"],
]);

/**
 * The name `routes` give a request: the last resource in its path and what is done to it, as
 * `threads.modify` or `files.get`. What is done is the path's own verb where it has one, and the
 * method's otherwise: `list` for a GET of a resource and `get` of an item, `create`, `update`,
 * `patch` and `delete`. Undefined for a path that is not in `routes` and for a method with no
 * such verb. `method` is in upper case. A name is put together from the trees' keys alone, so
 * nothing a URL holds reaches one.
 */
export function routeOperation(routes: Routes, method: string, url: URL): string | undefined {
  let address = url.origin + url.pathname;
  let route = routes.find(([prefix]) => address.startsWith(prefix));
  if (!route) return undefined;
  // A `word:verb` segment is two steps, the verb keeping its colon.
  let steps = address.slice(route[0].length).split("/").flatMap(segment => {
    let colon = segment.indexOf(":");
    return colon < 0 ? segment : [segment.slice(0, colon), segment.slice(colon)];
  }).filter(step => step !== "");

  let node = route[1];
  let resource: string | undefined;
  let verb: string | undefined;
  // Whether the path ends at an item, and not at the resource that holds it.
  let item = false;
  for (let at = 0; at < steps.length; at++) {
    let step = steps[at];
    // An own property only, so that an ID spelling `constructor` finds no child. The keys in
    // braces are found by no step: a URL's path holds its braces percent-encoded.
    let child = Object.hasOwn(node, step) ? node[step] : undefined;
    let items = node[ID];
    if (typeof child === "object") {
      resource = step;
      item = false;
      node = child;
    } else if (child === ONE && at === steps.length - 1) {
      resource = step;
      item = true;
    } else if (child === method && at === steps.length - 1) {
      // A verb is one under its own method and at the end of the path, and an ID anywhere else.
      verb = step.startsWith(":") ? step.slice(1) : step;
    } else if (step.startsWith(":")) {
      return undefined;
    } else if (typeof items === "object") {
      item = true;
      node = items;
    } else if (Object.hasOwn(node, REST)) {
      item = true;
      break;
    } else {
      return undefined;
    }
  }

  if (verb === undefined) {
    // A method does what it does to a resource, and the path of a root alone has none.
    if (resource === undefined) return undefined;
    verb = method === "GET" ? (item ? "get" : "list") : METHOD_VERBS.get(method);
    if (verb === undefined) return undefined;
  }
  return resource === undefined ? verb : `${resource}.${verb}`;
}

/**
 * The name of a request to a Google API, from its HTTP method and URL: the one `ROUTES` give it
 * (`routeOperation`), with a suffix for a download (`alt=media`) and for the opening of an upload
 * session (`uploadType=resumable`). A request `ROUTES` do not name, and one to what is not a URL,
 * is named by its HTTP method alone. Never throws.
 */
export function googleOperation(method: string | undefined, url: string | URL): string {
  let fallback = (method ?? "GET").toUpperCase();
  let parsed = typeof url === "string" ? URL.parse(url) : url;
  let name = parsed ? routeOperation(ROUTES, fallback, parsed) : undefined;
  if (!parsed || name === undefined) return fallback;
  if (parsed.searchParams.get("alt") === "media") name += ".media";
  if (parsed.searchParams.get("uploadType") === "resumable") name += ".resumable";
  return name;
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
