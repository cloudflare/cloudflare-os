// The words of the Google gatekeeper's subservice metrics: which service a request goes to, and
// the tree of paths from which a request is named. The client that counts each request with them
// is in `upstream.ts`.

import { ID, ONE, REST, routeOperation, type Routes } from "@gadgets/gatekeeper-kit/route-operation";

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
 * www.googleapis.com, of first path segments); `google-other` for any other, and for a request
 * that has no URL or one that cannot be parsed.
 */
export function googleService(url: URL | undefined): string {
  if (!url) return "google-other";
  if (url.hostname !== "www.googleapis.com") {
    return SERVICE_BY_HOST.get(url.hostname) ?? "google-other";
  }
  // An API's upload and batch endpoints sit one segment down, as in `/batch/drive/v3`.
  let [, first, second] = url.pathname.split("/");
  let api = first === "upload" || first === "batch" ? second : first;
  return SERVICE_BY_WWW_PATH.get(api) ?? "google-other";
}

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

/**
 * The name of a request to a Google API, from its HTTP method and URL: the one `ROUTES` give it
 * (`routeOperation`), with a suffix for a download (`alt=media`) and for the opening of an upload
 * session (`uploadType=resumable`). Undefined for a request `ROUTES` do not name, which is
 * counted under its HTTP method.
 * @param method The request's HTTP method, in upper case.
 * @param url The request's URL.
 * @returns The name, made of the tree's keys and the two suffixes alone, or undefined.
 */
export function googleOperation(method: string, url: URL): string | undefined {
  let name = routeOperation(ROUTES, method, url);
  if (name === undefined) return undefined;
  if (url.searchParams.get("alt") === "media") name += ".media";
  if (url.searchParams.get("uploadType") === "resumable") name += ".resumable";
  return name;
}
