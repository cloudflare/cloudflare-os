// The one client every call to Microsoft is sent through (`graphUpstream`), and how each call is
// named for its subservice metric point: the tree of the Graph paths this gatekeeper calls, a namer
// for the shapes of Graph's addressing that a tree cannot spell, and the literal names of the
// requests to hosts other than Graph. A name is a key of the tree or a literal of this file, so no
// ID, path, host or query reaches a point.

import { ID, ONE, routeOperation, type Routes, type Tree } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { GRAPH_BASE, VENDOR_ID } from "./vendor";

/** The root every Graph path is under. */
const GRAPH_ROOT = `${GRAPH_BASE}/`;

/** What is under a mailbox's or a calendar's owner: `/me`, or `/users/{id}` for someone else's. */
const OWNER: Tree = {
  messages: {
    [ID]: {
      attachments: { [ID]: {} },
      send: "POST", move: "POST", createReply: "POST", createReplyAll: "POST", createForward: "POST",
    },
  },
  mailFolders: { [ID]: { childFolders: {}, messages: {} } },
  mailboxSettings: { timeZone: ONE },
  outlook: { masterCategories: {} },
  calendars: { [ID]: { calendarView: {}, calendarPermissions: {}, events: {} } },
  events: { [ID]: { cancel: "POST", accept: "POST", decline: "POST", tentativelyAccept: "POST" } },
};

/**
 * The Graph paths this gatekeeper calls, by which a request is named: `messages.list`,
 * `items.copy`, `content.get`. The paths a tree cannot spell are named by `graphOperation`.
 */
export const GRAPH_ROUTES: Routes = [[GRAPH_ROOT, {
  me: { ...OWNER, people: {}, drive: ONE, followedSites: {}, calendar: { getSchedule: "POST" } },
  users: { [ID]: OWNER },
  organization: {},
  search: { query: "POST" },
  subscriptions: { [ID]: {} },
  shares: { [ID]: { driveItem: ONE, list: ONE, site: ONE, listItem: ONE } },
  sites: {
    [ID]: {
      drive: ONE, drives: {}, sites: {},
      lists: { [ID]: { drive: ONE, columns: {}, items: { [ID]: { fields: ONE } } } },
    },
  },
  drives: {
    [ID]: {
      root: ONE,
      items: {
        [ID]: {
          children: {}, content: ONE, copy: "POST",
          versions: { [ID]: { restoreVersion: "POST" } },
          listItem: { fields: ONE },
          workbook: { worksheets: {}, application: { calculate: "POST" } },
        },
      },
    },
  },
}]];

/**
 * The names `graphOperation` gives the Graph requests whose paths `GRAPH_ROUTES` cannot spell: a
 * `$batch`, a resource that is one thing and has paths under it, an item addressed by its path
 * (`items/{id}:/a/b`, `sites/{host}:/sites/a`), a function call (`search(q='…')`), a type cast
 * (`microsoft.graph.sitePage`) and an attachment's `$value`.
 */
export const SHAPE_OPERATIONS = [
  "batch", "me.get", "calendar.get", "mailboxSettings.get", "sites.get", "items.get", "content.update",
  "items.search", "range.get", "range.patch", "usedRange.get", "attachments.value", "pages.list", "pages.get",
] as const;

/** A name of `SHAPE_OPERATIONS`. */
export type ShapeOperation = typeof SHAPE_OPERATIONS[number];

/**
 * The names of the requests sent to hosts other than Graph, each a literal where it is sent: the
 * progress of a copy, read from its monitor URL, and a file's bytes, read from the pre-authenticated
 * URL a content request redirects to.
 */
export const HOST_OPERATIONS = ["copy.progress", "content.download"] as const;

/** A name of `HOST_OPERATIONS`. */
export type HostOperation = typeof HOST_OPERATIONS[number];

/** An OData key in parentheses, as a `nextLink` writes an item: `mailFolders('id')`, its quotes as they are or percent-encoded. */
const KEYED = /^([A-Za-z]+)\((?:'|%27)(.+)(?:'|%27)\)$/;
/** A function call, the last step of its path: `range(address='A1:B2')`. */
const CALLED = /^([A-Za-z]+)\(.*\)$/;
/** The opening of a function call, which names its argument where an OData key names none: `search(q=`, `range(address=`. */
const CALL_OPENED = /^[A-Za-z]+\([A-Za-z]+=/;

/** The name of a path's shape that a tree cannot spell, from its steps under the Graph root. */
function shapeOperation(method: string, steps: readonly string[]): ShapeOperation | undefined {
  const get = method === "GET";
  const last = steps.at(-1) ?? "";
  if (steps.length === 1 && last === "$batch") return method === "POST" ? "batch" : undefined;
  if (steps.length === 1 && last === "me") return get ? "me.get" : undefined;

  // `{item}:/{path}` is the item at a path under another, and `{item}:/{path}:/content` its content.
  const opened = steps.findIndex(step => step.endsWith(":"));
  if (opened >= 0) {
    const resource = steps[opened - 1];
    // All that follows `sites/{host}:` is the path of a web, as a pasted link wrote it: a step of
    // it may end in a colon too, as the `:w:` of a sharing link does, and closes nothing.
    if (opened === 1 && resource === "sites") return get ? "sites.get" : undefined;
    const closed = steps.findIndex((step, at) => at > opened && step.endsWith(":"));
    if (closed < 0) return get && resource === "items" ? "items.get" : undefined;
    const under = steps.slice(closed + 1);
    return method === "PUT" && resource === "items" && under.length === 1 && under[0] === "content"
      ? "content.update" : undefined;
  }

  const called = CALLED.exec(last)?.[1];
  if (called === "search") return get ? "items.search" : undefined;
  if (called === "usedRange") return get ? "usedRange.get" : undefined;
  if (called === "range") return get ? "range.get" : method === "PATCH" ? "range.patch" : undefined;
  if (!get) return undefined;

  if (last === "$value") return steps.at(-3) === "attachments" ? "attachments.value" : undefined;
  if (last === "microsoft.graph.sitePage") {
    if (steps.at(-2) === "pages") return "pages.list";
    return steps.at(-3) === "pages" ? "pages.get" : undefined;
  }
  // An owner's default calendar and mailbox settings are each one thing, with paths under them.
  const owned = steps[0] === "me" ? 2 : steps[0] === "users" ? 3 : undefined;
  if (steps.length === owned && last === "calendar") return "calendar.get";
  return steps.length === owned && last === "mailboxSettings" ? "mailboxSettings.get" : undefined;
}

/**
 * Names the Graph requests `GRAPH_ROUTES` cannot: one of `SHAPE_OPERATIONS` for a shape a tree
 * cannot spell, and the tree's own name for a path that writes an item as an OData key
 * (`mailFolders('id')/messages`, as a `nextLink` may), read as `mailFolders/id/messages`.
 * @param method The HTTP method, in upper case.
 * @param url The request's URL.
 * @returns The name, or undefined for a request that is the tree's to name or is not Graph's.
 */
export function graphOperation(method: string, url: URL): string | undefined {
  const address = url.origin + url.pathname;
  if (!address.startsWith(GRAPH_ROOT)) return undefined;
  const split = address.slice(GRAPH_ROOT.length).split("/").filter(step => step !== "");
  // A function call is the last step of its path, whatever its argument holds: a slash in it
  // splits the call over several steps, of which one may end in a colon or close a parenthesis,
  // as those of `search(q='https://a/f(x)')` do. Under an item addressed by its path there is no
  // call: a step that opens like one there is a name's.
  const call = split.findIndex(step => CALL_OPENED.test(step));
  const addressed = split.findIndex(step => step.endsWith(":"));
  const calls = call >= 0 && (addressed < 0 || addressed >= call);
  const written = calls ? [...split.slice(0, call), split.slice(call).join("/")] : split;
  const steps = written.flatMap(step => {
    const keyed = KEYED.exec(step);
    return keyed ? [keyed[1] ?? "", keyed[2] ?? ""] : [step];
  });
  const shape = shapeOperation(method, steps);
  if (shape !== undefined || steps.length === written.length) return shape;
  const plain = URL.parse(GRAPH_ROOT + steps.join("/"));
  return plain ? routeOperation(GRAPH_ROUTES, method, plain) : undefined;
}

/**
 * The client every request to Microsoft is sent through: Graph, the SharePoint hosts a download or
 * a copy's progress is read from, and the Entra token endpoint. Each attempt is one subservice
 * metric point under the source `gatekeeper.microsoft.api` and the service `microsoft`. No
 * redirect is followed and each attempt has 30 seconds unless its request says otherwise. The
 * requests `GraphApi` sends again after an answer are those of its throttle rule (see
 * `GraphApi.request`), in place of the upstream's default, and a GET that got no answer (a network
 * failure, a timeout) is sent three times, one given its caller's signal only while that caller's
 * wait lasts, as a read of a copy's progress and the lookup of a finished copy are. `GraphApi`
 * counts an attempt Graph throttled as `refused` for its `rate`, a 503 that names a wait as a 429,
 * a download and a read of a copy's progress by whether the answer could be read, and a success
 * that is no JSON, or is not what its request was sent for, as an error (see `GraphApi.request`).
 */
export const graphUpstream = defineUpstream({
  vendorId: VENDOR_ID,
  routes: GRAPH_ROUTES,
  operation: graphOperation,
});
