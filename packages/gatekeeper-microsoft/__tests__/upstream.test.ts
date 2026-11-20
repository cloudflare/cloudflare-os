// How each request to Microsoft is named and counted: the table of the kinds of request the
// gatekeeper makes against the route tree and the namer of graph-upstream.ts, and the metric
// points the client's own rules write (its throttles and their retry, the redirects it reads as
// successes, a download and a read of a copy's progress counted by whether the answer could be
// read).

import { env } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarApi } from "../src/calendar-graph";
import { resolveCalendarUrl } from "../src/calendar-resolve";
import { CalendarUrlError } from "../src/calendar-scope";
import { findUser, findUserByMail, organizationDomains } from "../src/directory";
import { DownloadTooLargeError, GraphApi, GraphThrottledError, GraphTransportError, withGraph } from "../src/graph-api";
import { GRAPH_ROUTES, HOST_OPERATIONS, SHAPE_OPERATIONS, graphUpstream } from "../src/graph-upstream";
import { MailApi } from "../src/outlook-graph";
import { probeMailUnits } from "../src/outlook-observers";
import { resolveOutlookUrl } from "../src/outlook-resolve";
import { OutlookUrlError } from "../src/outlook-scope";
import { probeUnits } from "../src/sharepoint-observers";
import {
  browseSites, getDrive, getItem, getItems, getList, getListItem, getPage, getRoot, getSite, listChildren, listColumns, listDrives, listItems,
  listLists, listPages, listSubsites, listVersions, listWorksheets, myOneDriveSite, readRange, searchAll, searchDrive, usedRangeShape,
} from "../src/sharepoint-reads";
import { OtherOrganizationError, UnresolvableUrlError, resolveSharePointUrl } from "../src/sharepoint-resolve";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ITEM = `${GRAPH}/drives/b!x/items/01ITEM`;
const LIST = `${GRAPH}/sites/contoso.sharepoint.com,1,2/lists/3`;

type Row = [method: string, url: string, name: string];

// A request under a mailbox's or calendar's owner, as the signed-in user and as someone else.
const owned = (method: string, path: string, name: string): Row[] =>
  [[method, `${GRAPH}/me${path}`, name], [method, `${GRAPH}/users/sarah%40contoso.com${path}`, name]];

// Each kind of request the gatekeeper makes to Graph, and the name it is counted under.
const REQUESTS: Row[] = [
  // The signed-in user, the directory, search, batches and change notifications.
  ["GET", `${GRAPH}/me?$select=id`, "me.get"],
  ["GET", `${GRAPH}/me/people?$search=x`, "people.list"],
  ["GET", `${GRAPH}/me/drive`, "drive.get"],
  ["GET", `${GRAPH}/me/followedSites`, "followedSites.list"],
  ["POST", `${GRAPH}/me/calendar/getSchedule`, "calendar.getSchedule"],
  ["GET", `${GRAPH}/organization`, "organization.list"],
  ["GET", `${GRAPH}/users?$filter=x`, "users.list"],
  ["GET", `${GRAPH}/users/sarah%40contoso.com`, "users.get"],
  ["POST", `${GRAPH}/search/query`, "search.query"],
  ["POST", `${GRAPH}/$batch`, "batch"],
  ["POST", `${GRAPH}/subscriptions`, "subscriptions.create"],
  ["PATCH", `${GRAPH}/subscriptions/sub-1`, "subscriptions.patch"],
  ["DELETE", `${GRAPH}/subscriptions/sub-1`, "subscriptions.delete"],

  // Mail.
  ...owned("GET", "/messages?$top=10", "messages.list"),
  ...owned("POST", "/messages", "messages.create"),
  ...owned("GET", "/messages/AAMk1", "messages.get"),
  ...owned("PATCH", "/messages/AAMk1", "messages.patch"),
  ...owned("POST", "/messages/AAMk1/send", "messages.send"),
  ...owned("POST", "/messages/AAMk1/move", "messages.move"),
  ...owned("POST", "/messages/AAMk1/createReply", "messages.createReply"),
  ...owned("POST", "/messages/AAMk1/createReplyAll", "messages.createReplyAll"),
  ...owned("POST", "/messages/AAMk1/createForward", "messages.createForward"),
  ...owned("GET", "/messages/AAMk1/attachments", "attachments.list"),
  ...owned("POST", "/messages/AAMk1/attachments", "attachments.create"),
  ...owned("DELETE", "/messages/AAMk1/attachments/AAMk2", "attachments.delete"),
  ...owned("GET", "/messages/AAMk1/attachments/AAMk2/$value", "attachments.value"),
  ...owned("GET", "/mailFolders", "mailFolders.list"),
  ...owned("POST", "/mailFolders", "mailFolders.create"),
  ...owned("GET", "/mailFolders/inbox", "mailFolders.get"),
  ...owned("DELETE", "/mailFolders/AAMk3", "mailFolders.delete"),
  ...owned("GET", "/mailFolders/AAMk3/childFolders", "childFolders.list"),
  ...owned("POST", "/mailFolders/AAMk3/childFolders", "childFolders.create"),
  ...owned("GET", "/mailFolders/sentitems/messages", "messages.list"),
  ...owned("GET", "/mailboxSettings?$select=timeZone", "mailboxSettings.get"),
  ...owned("PATCH", "/mailboxSettings", "mailboxSettings.patch"),
  ...owned("GET", "/mailboxSettings/timeZone", "timeZone.get"),
  ...owned("GET", "/outlook/masterCategories", "masterCategories.list"),
  // A `nextLink` may write an item as an OData key.
  ["GET", `${GRAPH}/me/mailFolders('inbox')/messages?$skip=10`, "messages.list"],
  ["GET", `${GRAPH}/users('sarah%40contoso.com')/mailFolders('AAMk3')/childFolders?$skip=10`, "childFolders.list"],
  ["GET", `${GRAPH}/me/calendars(%27AAMk4%27)/calendarView?$skip=10`, "calendarView.list"],

  // Calendars.
  ...owned("GET", "/calendar", "calendar.get"),
  ...owned("GET", "/calendars", "calendars.list"),
  ...owned("GET", "/calendars/AAMk4", "calendars.get"),
  ...owned("GET", "/calendars/AAMk4/calendarView?startDateTime=x", "calendarView.list"),
  ...owned("GET", "/calendars/AAMk4/calendarPermissions", "calendarPermissions.list"),
  ...owned("POST", "/calendars/AAMk4/events", "events.create"),
  ...owned("GET", "/events/AAMk5", "events.get"),
  ...owned("PATCH", "/events/AAMk5", "events.patch"),
  ...owned("DELETE", "/events/AAMk5", "events.delete"),
  ...owned("POST", "/events/AAMk5/cancel", "events.cancel"),
  ...owned("POST", "/events/AAMk5/accept", "events.accept"),
  ...owned("POST", "/events/AAMk5/decline", "events.decline"),
  ...owned("POST", "/events/AAMk5/tentativelyAccept", "events.tentativelyAccept"),

  // Sites, lists and pages.
  ["GET", `${GRAPH}/sites/root`, "sites.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2?$select=id`, "sites.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com:/sites/Engineering`, "sites.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com:/`, "sites.get"],
  // The path of a pasted link is asked for as it was written: a sharing link's has steps that end in a colon.
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com:/:w:/s/Engineering/EaBcDeFg?$select=id`, "sites.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com:/:f:/r/sites/Engineering`, "sites.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com:/sites/Engineering:/notes`, "sites.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2/drive`, "drive.get"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2/drives`, "drives.list"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2/sites`, "sites.list"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2/lists`, "lists.list"],
  ["GET", LIST, "lists.get"],
  ["GET", `${LIST}/drive`, "drive.get"],
  ["GET", `${LIST}/columns`, "columns.list"],
  ["GET", `${LIST}/items?$top=50`, "items.list"],
  ["POST", `${LIST}/items`, "items.create"],
  ["GET", `${LIST}/items/9?$expand=fields`, "items.get"],
  ["DELETE", `${LIST}/items/9`, "items.delete"],
  ["PATCH", `${LIST}/items/9/fields`, "fields.patch"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2/pages/microsoft.graph.sitePage?$top=1`, "pages.list"],
  ["GET", `${GRAPH}/sites/contoso.sharepoint.com,1,2/pages/4/microsoft.graph.sitePage`, "pages.get"],
  ["GET", `${GRAPH}/shares/u!aHR0/driveItem`, "driveItem.get"],
  ["GET", `${GRAPH}/shares/u!aHR0/list`, "list.get"],
  ["GET", `${GRAPH}/shares/u!aHR0/site`, "site.get"],
  ["GET", `${GRAPH}/shares/u!aHR0/listItem`, "listItem.get"],

  // Drives and files.
  ["GET", `${GRAPH}/drives/b!x`, "drives.get"],
  ["GET", `${GRAPH}/drives/b!x/root`, "root.get"],
  ["GET", `${GRAPH}/drives/b!x/root/search(q='plan')?$top=20`, "items.search"],
  // A `nextLink` may write the slash of a search's text as it is, whatever else the text holds.
  ["GET", `${GRAPH}/drives/b!x/root/search(q='plans/2026')?$skiptoken=x`, "items.search"],
  ["GET", `${GRAPH}/drives/b!x/root/search(q='https://contoso.example/plans')?$skiptoken=x`, "items.search"],
  ["GET", `${GRAPH}/drives/b!x/root/search(q='C:/plans/2026')?$skiptoken=x`, "items.search"],
  ["GET", `${GRAPH}/drives/b!x/root/search(q='f(x)/y')?$skiptoken=x`, "items.search"],
  ["GET", `${GRAPH}/drives/b!x/root/search(q=%27plans:/2026%20(final)/a%27)?$skiptoken=x`, "items.search"],
  ["GET", `${GRAPH}/drives('b!x')/root/search(q='plans/2026:/a')?$skiptoken=x`, "items.search"],
  ["GET", ITEM, "items.get"],
  ["PATCH", ITEM, "items.patch"],
  ["DELETE", ITEM, "items.delete"],
  ["GET", `${ITEM}:/notes%20(copy).txt?$select=id`, "items.get"],
  ["GET", `${ITEM}/children?$top=50`, "children.list"],
  ["POST", `${ITEM}/children`, "children.create"],
  ["GET", `${ITEM}/content?format=pdf`, "content.get"],
  ["PUT", `${ITEM}/content`, "content.update"],
  ["PUT", `${ITEM}:/book.xlsx:/content`, "content.update"],
  ["PUT", `${ITEM}:/draft(1.txt:/content`, "content.update"],
  // Under an item addressed by its path, a step that opens like a function call is a name's.
  ["PUT", `${ITEM}:/plans/range(address=A1/book.xlsx:/content`, "content.update"],
  ["POST", `${ITEM}/copy`, "items.copy"],
  ["GET", `${ITEM}/versions?$top=50`, "versions.list"],
  ["POST", `${ITEM}/versions/3.0/restoreVersion`, "versions.restoreVersion"],
  ["GET", `${ITEM}/listItem/fields`, "fields.get"],
  ["GET", `${ITEM}/workbook/worksheets`, "worksheets.list"],
  ["GET", `${ITEM}/workbook/worksheets/%7B1%7D/range(address='B2%3AC3')`, "range.get"],
  ["PATCH", `${ITEM}/workbook/worksheets/%7B1%7D/range(address='B2:C2')`, "range.patch"],
  // A parenthesis in the step of a worksheet opens no function call.
  ["GET", `${ITEM}/workbook/worksheets/Data(old/range(address='B2')`, "range.get"],
  ["GET", `${ITEM}/workbook/worksheets/%7B1%7D/usedRange(valuesOnly=true)`, "usedRange.get"],
  ["POST", `${ITEM}/workbook/application/calculate`, "application.calculate"],
  ["GET", `${GRAPH}/drives('b!x')/items('01ITEM')/children?$skiptoken=x`, "children.list"],
];

const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its source, service, operation, outcome, reason and HTTP status.
function calls() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
    SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// Each point written, as its operation, outcome, reason and HTTP status alone.
function counted() {
  return calls().map(([, , operation, outcome, reason, status]) => [operation, outcome, reason, status]);
}

// An answer made for the request it answers, from the init that request was sent with.
type Answering = (init: RequestInit | undefined) => Response | Promise<Response>;

// A client whose requests are answered from a script, in order; an error is thrown.
function scripted(...answers: (Response | Error | Answering)[]) {
  const sent: string[] = [];
  const api = new GraphApi("token", {
    fetch: async (input, init) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      const next = answers.shift();
      if (next === undefined) throw new Error(`unexpected request to ${String(input)}`);
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(init) : next;
    },
  });
  return { api, sent };
}

// A client whose requests are answered by the first route whose path their URL holds.
function routed(routes: [path: string, answer: () => Response][]) {
  return new GraphApi("token", {
    fetch: async input => {
      const route = routes.find(([path]) => String(input).includes(path));
      if (route === undefined) throw new Error(`unexpected request to ${String(input)}`);
      return route[1]();
    },
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Runs a request to completion while its retries wait on fake timers.
async function settle<T>(promise: Promise<T>): Promise<T | { error: unknown }> {
  const outcome = promise.catch((error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return await outcome;
}

// What a request threw, as its class and message, once its retries have waited on fake timers.
async function failure(promise: Promise<unknown>): Promise<[name: string, message: string]> {
  const outcome = promise.then(() => undefined, (caught: unknown) => caught);
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  const error = await outcome;
  if (!(error instanceof Error)) throw new Error("the request did not fail");
  return [error.name, error.message];
}

// Each call counted, as `counted` gives a point: a point that sums several calls is given once for each.
function countedCalls() {
  return counted().flatMap((call, at) => {
    const summed = Number(column(points[at] ?? {}, SUBSERVICE_V1_SLOTS.calls));
    return Array.from({ length: summed }, () => call);
  });
}

// Makes `AbortSignal.timeout` run on the fake clock, which does not reach the platform's own.
function fakeTimeouts() {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

// An answer whose body stops short: its first bytes, then the error of a connection that dropped.
function stoppedShort(): Response {
  let pulls = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("he"));
      else controller.error(new TypeError("reset"));
    },
  }));
}

// An answer whose body never ends, and fails once the signal of its attempt aborts, as the body of
// an attempt that its timeout cut off does.
const stalled: Answering = init => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => controller.error(signal.reason));
  },
}));

// No answer: the request fails once the signal of its attempt aborts, as `fetch` fails one, with
// the reason of the abort.
const unanswered: Answering = init => new Promise((_, reject) => {
  const signal = init?.signal;
  signal?.addEventListener("abort", () => reject(signal.reason));
});

// How long a request took on the fake clock, once it has ended either way.
function timed(send: () => Promise<unknown>) {
  const startedAt = Date.now();
  const ended: { after?: number } = {};
  const sending = send().finally(() => { ended.after = Date.now() - startedAt; });
  return { sending, ended };
}

// An answer that declares a file larger than the cap and arrives as the timeout of its attempt
// fires, so that its body has failed by the time it is released.
const lateAndLarge: Answering = init => {
  vi.advanceTimersByTime(60_000);
  const signal = init?.signal;
  return new Response(new ReadableStream<Uint8Array>({ start: controller => controller.error(signal?.reason) }),
    { headers: { "content-length": "4096" } });
};

const MONITOR = "https://contoso.sharepoint.com/_api/v2.0/monitor/copy-1";
// A finished copy, looked up by its name in the folder it went to.
const LANDED = "/drives/b!x/items/01FOLDER:/notes%20(copy).txt";
// A file's bytes, which Graph answers with a redirect to another host, and an attachment's, which it answers itself.
const CONTENT = "/drives/b!x/items/1/content";
const ATTACHMENT = "/me/messages/AAMk1/attachments/AAMk2/$value";
const redirected = () => new Response(null, { status: 302, headers: { location: "https://contoso.sharepoint.com/a" } });

// A success that is no 202 starts no copy the caller can follow: what `startCopy` throws for it,
// by the status of the answer.
const answeredWith = (status: number) => ({ name: "GraphApiError", status, message: `Microsoft Graph answered with HTTP ${status}.` });

// What a read of a copy's progress throws for an answer that holds no status, by the status the
// error is given.
const unreadableStatus = (status: number) => ({ name: "GraphApiError", status, message: "SharePoint sent an unreadable copy status." });

// Each kind of request the client sends: how it is sent, the name its answer is counted under, how
// often it is sent while every answer is a throttle that names no wait to speak of, how often
// while every answer is a 503 that names none, and the answers of the requests sent ahead of it.
const KINDS: [
  kind: string, send: (api: GraphApi) => Promise<unknown>, operation: string, throttledSends: number, failedSends: number,
  ahead: (() => Response)[],
][] = [
  ["a read", api => api.get("/me/messages"), "messages.list", 3, 3, []],
  ["a write", api => api.request("POST", "/me/messages", { body: {} }), "messages.create", 3, 1, []],
  ["a batch", api => api.batch([{ id: "a", method: "GET", url: "me/messages/1" }]), "batch", 3, 1, []],
  ["the start of a copy", api => api.startCopy("/drives/b!x/items/1/copy", { name: "copy.txt" }), "items.copy", 1, 1, []],
  ["a download Graph redirects", api => api.download(CONTENT, 1024), "content.get", 3, 3, []],
  ["a download from the host Graph redirects to", api => api.download(CONTENT, 1024), "content.download", 3, 3, [redirected]],
  ["a download Graph answers itself", api => api.download(ATTACHMENT, 1024), "attachments.value", 3, 3, []],
  ["a read of a copy's progress", api => api.copyProgress(MONITOR), "copy.progress", 3, 3, []],
];

describe("the names of Graph requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(graphUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree with a request of the table", () => {
    expect(routeEnds(GRAPH_ROUTES).length).toBeGreaterThan(0);
    expect(unreachedRouteEnds(GRAPH_ROUTES, REQUESTS)).toEqual([]);
  });

  it("gives every name of the namer to a request of the table", () => {
    const named = new Set(REQUESTS.map(([, , name]) => name));
    expect(SHAPE_OPERATIONS.filter(name => !named.has(name))).toEqual([]);
  });

  it.each([
    ["GET", `${GRAPH}/teams/1/channels`],
    ["POST", `${GRAPH}/me/sendMail`],
    ["DELETE", `${GRAPH}/drives/b!x/items/01ITEM:/a.txt:/content`],
    ["GET", `${GRAPH}/drives/b!x/items/01ITEM/workbook/worksheets/1/cell(row=1,column=1)`],
    ["GET", "https://graph.microsoft.com/beta/me"],
    ["GET", "https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=secret"],
  ])("names %s %s, which is no request of the gatekeeper's, by its method", (method, url) => {
    expect(graphUpstream.operationOf(method, url)).toBe(method);
  });

  it("puts nothing a URL holds into a name", () => {
    const words = new Set(REQUESTS.map(([method, url]) => graphUpstream.operationOf(method, url)));
    for (const word of words) expect(word).toMatch(/^[A-Za-z]+(\.[A-Za-z]+)?$/);
  });
});

describe("what the client counts", () => {
  it("counts a request under the gatekeeper's source and service", async () => {
    const { api } = scripted(json({ id: "1" }));
    await api.get("/me");
    expect(calls()).toEqual([["gatekeeper.microsoft.api", "microsoft", "me.get", "success", "", 200]]);
  });

  it("counts each send of a throttled request, and the answer it ends with", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api } = scripted(json({}, 429, { "retry-after": "1" }), json({}, 503, { "retry-after": "0" }), json({ id: "1" }, 201));
    await settle(api.request("POST", "/me/messages", { body: {} }));
    expect(counted()).toEqual([
      ["messages.create", "refused", "rate", 429], ["messages.create", "refused", "rate", 503], ["messages.create", "success", "", 201],
    ]);
  });

  it("counts once a throttle whose wait is longer than the client waits, which it hands back", async () => {
    const { api, sent } = scripted(json({}, 429, { "retry-after": "120" }));
    await expect(api.get("/me/messages")).rejects.toBeInstanceOf(GraphThrottledError);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["messages.list", "refused", "rate", 429]]);
  });

  it("counts a GET that got no answer as a network error for each of its three sends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(new TypeError("reset"), new TypeError("reset"), new TypeError("reset"));
    expect(await settle(api.get("/me/messages"))).toEqual({ error: expect.any(GraphTransportError) });
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual(Array.from({ length: 3 }, () => ["messages.list", "error", "network", 0]));
  });

  it("counts a status among `allow` by that status, and sends it once", async () => {
    const { api, sent } = scripted(json({ error: {} }, 404), json({}, 503));
    expect(await api.find("/me/messages/AAMk1")).toBeNull();
    expect(await api.request("GET", "/me/messages/AAMk1", { allow: [503] })).toBeNull();
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["messages.get", "error", "http", 404], ["messages.get", "error", "http", 503]]);
  });

  it.each(KINDS)("counts each send of %s that a 503 naming a wait throttles as refused for its rate", async (_kind, send, operation, sends, _failedSends, ahead) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(...ahead.map(answer => answer()), ...Array.from({ length: sends }, () => json({}, 503, { "retry-after": "0" })));
    expect(await settle(send(api))).toEqual({ error: expect.objectContaining({ status: 503 }) });
    expect(sent).toHaveLength(ahead.length + sends);
    expect(countedCalls().filter(([name]) => name === operation)).toEqual(Array.from({ length: sends }, () => [operation, "refused", "rate", 503]));
  });

  it.each(KINDS)("counts once %s that a 503 throttles for longer than the client waits, which it hands back", async (_kind, send, operation, _sends, _failedSends, ahead) => {
    const { api, sent } = scripted(...ahead.map(answer => answer()), json({}, 503, { "retry-after": "3600" }));
    await expect(send(api)).rejects.toMatchObject({ status: 503 });
    expect(sent).toHaveLength(ahead.length + 1);
    expect(countedCalls().filter(([name]) => name === operation)).toEqual([[operation, "refused", "rate", 503]]);
  });

  it.each(KINDS)("counts each send of %s that a 503 naming no wait answers as an error, by its status", async (_kind, send, operation, _sends, failedSends, ahead) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(...ahead.map(answer => answer()), ...Array.from({ length: failedSends }, () => json({}, 503)));
    expect(await settle(send(api))).toEqual({ error: expect.objectContaining({ status: 503 }) });
    expect(sent).toHaveLength(ahead.length + failedSends);
    expect(countedCalls().filter(([name]) => name === operation)).toEqual(Array.from({ length: failedSends }, () => [operation, "error", "http", 503]));
  });

  it("counts a throttle among `allow` as a throttle, and sends it once", async () => {
    const { api, sent } = scripted(json({}, 503, { "retry-after": "0" }));
    expect(await api.request("GET", "/me/messages/AAMk1", { allow: [503] })).toBeNull();
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["messages.get", "refused", "rate", 503]]);
  });

  it("sums the requests of one operation run with `withGraph` into a point per kind", async () => {
    vi.stubGlobal("fetch", async () => json({ value: [] }));
    await withGraph("token", async api => {
      for (let page = 0; page < 3; page++) await api.get("/me/messages", { query: { $skip: page } });
      await api.get("/me/mailFolders");
    });
    expect(counted()).toEqual([["messages.list", "success", "", 200], ["mailFolders.list", "success", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([3, 1]);
  });

  it("counts a batch whose answer holds no responses as an answer that cannot be read", async () => {
    const { api } = scripted(json({ value: [] }));
    await expect(api.batch([{ id: "a", method: "GET", url: "me/messages/1" }])).rejects.toMatchObject({ status: 502 });
    expect(counted()).toEqual([["batch", "error", "parse", 200]]);
  });

  it("counts a batch as one request, whatever its sub-requests answer", async () => {
    const { api } = scripted(json({ responses: [{ id: "a", status: 200, body: {} }, { id: "b", status: 404, body: {} }] }));
    await api.batch([{ id: "a", method: "GET", url: "me/messages/1" }, { id: "b", method: "GET", url: "me/messages/2" }]);
    expect(counted()).toEqual([["batch", "success", "", 200]]);
  });

  it("sums the sends of a batch whose throttled sub-requests are sent again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(
      json({ responses: [{ id: "a", status: 200, body: {} }, { id: "b", status: 429, headers: { "Retry-After": "1" } }] }),
      json({ responses: [{ id: "b", status: 200, body: {} }] }));
    await settle(api.batch([{ id: "a", method: "GET", url: "me/messages/1" }, { id: "b", method: "GET", url: "me/messages/2" }]));
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["batch", "success", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([2]);
  });

  it("counts the redirect of a download as its success, and the bytes read from another host under a name of their own", async () => {
    const { api } = scripted(
      new Response(null, { status: 302, headers: { location: "https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=x" } }),
      new Response("hello"));
    await api.download("/drives/b!x/items/1/content", 1024);
    expect(counted()).toEqual([["content.get", "success", "", 302], ["content.download", "success", "", 200]]);
  });

  it("counts a download's redirect to a host it does not follow as an error", async () => {
    const { api } = scripted(new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(api.download("/drives/b!x/items/1/content", 1024)).rejects.toMatchObject({ status: 502 });
    expect(counted()).toEqual([["content.get", "error", "http", 302]]);
  });

  it("gives each leg of a download a minute", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { api } = scripted(
      new Response(null, { status: 302, headers: { location: "https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=x" } }),
      new Response("hello"));
    await api.download("/drives/b!x/items/1/content", 1024);
    expect(timeout.mock.calls).toEqual([[60_000], [60_000]]);
  });

  it.each([
    ["a download from Graph", [json({}, 429, { "retry-after": "3600" })]],
    ["a download from the host Graph redirects to", [
      new Response(null, { status: 302, headers: { location: "https://contoso.sharepoint.com/a" } }),
      json({}, 503, { "retry-after": "11" }),
    ]],
  ])("hands back at once a throttle of %s whose wait is longer than the client waits", async (_leg, answers) => {
    const { api, sent } = scripted(...answers);
    await expect(api.download("/drives/b!x/items/1/content", 1024)).rejects.toBeInstanceOf(GraphThrottledError);
    expect(sent).toHaveLength(answers.length);
    expect(counted().at(-1)?.slice(1)).toEqual(["refused", "rate", answers.length === 1 ? 429 : 503]);
  });

  it("sends a download again after a throttle whose wait is short, and not after a 502", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(json({}, 429, { "retry-after": "1" }), new Response("hello"), json({}, 502));
    expect(await settle(api.download("/me/messages/AAMk1/attachments/AAMk2/$value", 1024))).toMatchObject({ contentType: expect.any(String) });
    expect(await settle(api.download("/me/messages/AAMk1/attachments/AAMk2/$value", 1024))).toEqual({ error: expect.objectContaining({ status: 502 }) });
    expect(sent).toHaveLength(3);
  });

  it("counts an attachment's bytes, which Graph answers itself", async () => {
    const { api } = scripted(new Response("hello"));
    await api.download("/me/messages/AAMk1/attachments/AAMk2/$value", 1024);
    expect(counted()).toEqual([["attachments.value", "success", "", 200]]);
  });

  it("counts a download Graph refuses by the status of the refusal, whether or not its explanation can be read", async () => {
    const { api, sent } = scripted(
      json({ error: { code: "itemNotFound" } }, 404), redirected(), json({ error: { code: "accessDenied" } }, 403),
      new Response(stoppedShort().body, { status: 500 }));
    await expect(api.download(ATTACHMENT, 1024)).rejects.toMatchObject({ status: 404, code: "itemNotFound" });
    await expect(api.download(CONTENT, 1024)).rejects.toMatchObject({ status: 403, code: "accessDenied" });
    expect(await failure(api.download(ATTACHMENT, 1024))).toEqual(["GraphApiError", "Microsoft Graph answered with HTTP 500."]);
    expect(sent).toHaveLength(4);
    expect(counted()).toEqual([
      ["attachments.value", "error", "http", 404], ["content.get", "success", "", 302], ["content.download", "error", "http", 403],
      ["attachments.value", "error", "http", 500],
    ]);
  });

  it("reports a download that got no answer as one not sent in time, and counts each of its three sends a network error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(new TypeError("reset"), new TypeError("reset"), new TypeError("reset"));
    expect(await failure(api.download(ATTACHMENT, 1024))).toEqual(["GraphTransportError", "Microsoft 365 did not send the file in time."]);
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual(Array.from({ length: 3 }, () => ["attachments.value", "error", "network", 0]));
  });

  it.each([
    ["Graph answers itself", ATTACHMENT, [], "attachments.value"],
    ["the host Graph redirects to answers", CONTENT, [redirected], "content.download"],
  ] as const)("counts a download %s whose bytes stop short as an answer that could not be read, and sends it once", async (_leg, path, ahead, operation) => {
    const { api, sent } = scripted(...ahead.map(answer => answer()), stoppedShort());
    expect(await failure(api.download(path, 1024))).toEqual(["GraphTransportError", "The file download was interrupted."]);
    expect(sent).toHaveLength(ahead.length + 1);
    expect(counted().at(-1)).toEqual([operation, "error", "parse", 200]);
    expect(counted()).toHaveLength(ahead.length + 1);
  });

  it.each([
    ["Graph answers itself, declared larger than the cap", ATTACHMENT, [], () => new Response("x".repeat(10), { headers: { "content-length": "4096" } }), "attachments.value"],
    ["Graph answers itself, found larger than the cap while it is read", ATTACHMENT, [], () => new Response("x".repeat(2048)), "attachments.value"],
    ["the host Graph redirects to answers, found larger than the cap while it is read", CONTENT, [redirected], () => new Response("x".repeat(2048)), "content.download"],
  ] as const)("counts a download %s as an error of its size, and sends it once", async (_what, path, ahead, large, operation) => {
    const { api, sent } = scripted(...ahead.map(answer => answer()), large());
    const error = await api.download(path, 1024).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DownloadTooLargeError);
    expect(error).toMatchObject({ maxBytes: 1024 });
    expect(sent).toHaveLength(ahead.length + 1);
    expect(counted().at(-1)).toEqual([operation, "error", "size", 200]);
    expect(counted()).toHaveLength(ahead.length + 1);
  });

  it.each([
    ["Graph answers itself", ATTACHMENT, [], "attachments.value"],
    ["the host Graph redirects to answers", CONTENT, [redirected], "content.download"],
  ] as const)("asks again for a download %s whose bytes its timeout cut off, and counts that attempt a timeout", async (_leg, path, ahead, operation) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(...ahead.map(answer => answer()), stalled, new Response("hello", { headers: { "content-type": "text/plain" } }));
    expect(await settle(api.download(path, 1024))).toEqual({ bytes: new TextEncoder().encode("hello"), contentType: "text/plain" });
    expect(sent).toHaveLength(ahead.length + 2);
    expect(sent.at(-1)).toBe(sent.at(-2));
    expect(counted().slice(ahead.length)).toEqual([[operation, "error", "timeout", 200], [operation, "success", "", 200]]);
  });

  it("gives up a download whose bytes its timeout cuts off on each of its three sends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(stalled, stalled, stalled);
    expect(await failure(api.download(ATTACHMENT, 1024))).toEqual(["GraphTransportError", "The file download was interrupted."]);
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual(Array.from({ length: 3 }, () => ["attachments.value", "error", "timeout", 200]));
  });

  it("sends a download three times at most, a send Graph throttled and one whose bytes its timeout cut off alike", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(json({}, 429, { "retry-after": "0" }), stalled, stalled);
    expect(await failure(api.download(ATTACHMENT, 1024))).toEqual(["GraphTransportError", "The file download was interrupted."]);
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual([
      ["attachments.value", "refused", "rate", 429], ["attachments.value", "error", "timeout", 200], ["attachments.value", "error", "timeout", 200],
    ]);
  });

  it.each<[string, () => (Response | Error)[], [name: string, message: unknown], unknown[][]]>([
    ["gets no answer", () => [new TypeError("reset"), new TypeError("reset")],
      ["GraphTransportError", "Microsoft 365 did not send the file in time."], [["error", "network", 0], ["error", "network", 0]]],
    ["is refused", () => [json({ error: { code: "itemNotFound" } }, 404)],
      ["GraphApiError", "That item doesn't exist, or you don't have access to it."], [["error", "http", 404]]],
    ["is throttled for longer than the client waits", () => [json({}, 429, { "retry-after": "3600" })],
      ["GraphThrottledError", expect.stringMatching(/^Microsoft 365 is limiting how fast this account can make requests\. Try again after /)],
      [["refused", "rate", 429]]],
    ["is served a file larger than the cap", () => [new Response("x".repeat(2048))],
      ["DownloadTooLargeError", "The file is larger than the 0 MB this can read."], [["error", "size", 200]]],
  ])("fails a download whose bytes its timeout cut off and that then %s as its last send ends, within three sends", async (_what, later, thrown, laterCounts) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const answers = later();
    const { api, sent } = scripted(stalled, ...answers);
    expect(await failure(api.download(ATTACHMENT, 1024))).toEqual(thrown);
    expect(sent).toHaveLength(1 + answers.length);
    expect(new Set(sent).size).toBe(1);
    expect(counted()).toEqual([
      ["attachments.value", "error", "timeout", 200], ...laterCounts.map(count => ["attachments.value", ...count]),
    ]);
  });

  it("refuses once a download declared larger than the cap whose body fails to release as its timeout fires, and throws that failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(lateAndLarge, new Response("hello"));
    expect(await failure(api.download(ATTACHMENT, 1024))).toEqual(["TimeoutError", "timed out"]);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["attachments.value", "error", "size", 200]]);
  });

  it("counts a copy's start and each read of its progress, a finished copy's redirect a success", async () => {
    const monitor = "https://contoso.sharepoint.com/_api/v2.0/monitor/copy-1";
    const { api } = scripted(
      new Response(null, { status: 202, headers: { location: monitor } }),
      json({ status: "inProgress" }),
      new Response(null, { status: 303, headers: { location: `${GRAPH}/drives/b!x/items/COPY` } }));
    expect(await api.startCopy("/drives/b!x/items/1/copy", { name: "copy.txt" })).toBe(monitor);
    expect(await api.copyProgress(monitor)).toEqual({ status: "inProgress" });
    expect(await api.copyProgress(monitor)).toEqual({ status: "completed", resourceId: "COPY" });
    expect(counted()).toEqual([
      ["items.copy", "success", "", 202], ["copy.progress", "success", "", 200], ["copy.progress", "success", "", 303],
    ]);
  });

  it("sends once the start of a copy that Graph throttles, a write whose retry is its caller's", async () => {
    const { api, sent } = scripted(json({}, 429, { "retry-after": "0" }), new Response(null, { status: 202 }));
    await expect(api.startCopy("/drives/b!x/items/1/copy", { name: "copy.txt" })).rejects.toBeInstanceOf(GraphThrottledError);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["items.copy", "refused", "rate", 429]]);
  });

  it("counts a copy started with no link to its progress as an answer that cannot be read", async () => {
    const { api } = scripted(new Response(null, { status: 202, headers: { location: "https://evil.example/monitor" } }));
    await expect(api.startCopy("/drives/b!x/items/1/copy", { name: "copy.txt" })).rejects.toMatchObject({ status: 502 });
    expect(counted()).toEqual([["items.copy", "error", "parse", 202]]);
  });

  it.each<[string, () => Response, number, { name: string; message: string }]>([
    ["a 200 that holds an item", () => json({ id: "COPY" }), 200, answeredWith(200)],
    ["a 200 that stops short", () => new Response(stoppedShort().body), 200,
      { name: "GraphTransportError", message: "Microsoft Graph's answer was cut off." }],
    ["a 201 with no body", () => new Response(null, { status: 201 }), 201, answeredWith(201)],
    ["a 204", () => new Response(null, { status: 204 }), 204, answeredWith(204)],
  ])("counts the start of a copy answered %s, a success that starts no copy, as an answer that cannot be read", async (_what, answer, status, thrown) => {
    const { api, sent } = scripted(answer(), new Response(null, { status: 202, headers: { location: MONITOR } }));
    const error = await api.startCopy("/drives/b!x/items/1/copy", { name: "copy.txt" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject(thrown);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["items.copy", "error", "parse", status]]);
  });

  it("counts the start of a copy that Graph refuses by the status of the refusal", async () => {
    const { api } = scripted(json({ error: { code: "itemNotFound" } }, 404));
    await expect(api.startCopy("/drives/b!x/items/1/copy", { name: "copy.txt" })).rejects.toMatchObject({ status: 404 });
    expect(counted()).toEqual([["items.copy", "error", "http", 404]]);
  });

  it("hands back at once a throttle of a copy's progress whose wait is longer than the client waits", async () => {
    const { api, sent } = scripted(json({}, 429, { "retry-after": "3600" }));
    await expect(api.copyProgress("https://contoso.sharepoint.com/_api/v2.0/monitor/copy-1")).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["copy.progress", "refused", "rate", 429]]);
  });

  it("ends a read of a copy's progress that gets no answer as its caller's wait runs out, each send made by then counted a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(unanswered, unanswered, unanswered);
    const { sending, ended } = timed(() => api.copyProgress(MONITOR, AbortSignal.timeout(45_000)));
    expect(await failure(sending)).toEqual(["GraphTransportError", "SharePoint did not report the copy's progress in time."]);
    expect(ended.after).toBe(45_000);
    // The first send has its own 30 seconds, and the second is cut off as the caller's wait ends.
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["copy.progress", "error", "timeout", 0], ["copy.progress", "error", "timeout", 0]]);
  });

  it("ends the wait before a throttled read of a copy's progress is sent again as its caller's wait runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(json({}, 429, { "retry-after": "10" }), json({ status: "completed", resourceId: "1" }));
    const { sending, ended } = timed(() => api.copyProgress(MONITOR, AbortSignal.timeout(4_000)));
    expect(await failure(sending)).toEqual(["GraphTransportError", "SharePoint did not report the copy's progress in time."]);
    expect(ended.after).toBe(4_000);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["copy.progress", "refused", "rate", 429]]);
  });

  it("reads a copy's progress from a send made again within its caller's wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(unanswered, json({ status: "completed", resourceId: "COPY" }));
    expect(await settle(api.copyProgress(MONITOR, AbortSignal.timeout(45_000)))).toEqual({ status: "completed", resourceId: "COPY" });
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["copy.progress", "error", "timeout", 0], ["copy.progress", "success", "", 200]]);
  });

  it("ends a lookup that gets no answer as its caller's wait runs out, each send made by then counted a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(unanswered, unanswered, unanswered);
    const { sending, ended } = timed(() => api.find(LANDED, { signal: AbortSignal.timeout(45_000) }));
    expect(await failure(sending)).toEqual(["GraphTransportError", "Microsoft Graph did not answer in time."]);
    expect(ended.after).toBe(45_000);
    // The first send has its own 30 seconds, and the second is cut off as the caller's wait ends.
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["items.get", "error", "timeout", 0], ["items.get", "error", "timeout", 0]]);
  });

  it("ends the wait before a throttled lookup is sent again as its caller's wait runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(json({}, 429, { "retry-after": "10" }), json({ id: "COPY" }));
    const { sending, ended } = timed(() => api.find(LANDED, { signal: AbortSignal.timeout(4_000) }));
    expect(await failure(sending)).toEqual(["GraphTransportError", "Microsoft Graph did not answer in time."]);
    expect(ended.after).toBe(4_000);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["items.get", "refused", "rate", 429]]);
  });

  it("answers a lookup from a send made again within its caller's wait, and a request whose caller's signal never aborts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(unanswered, json({ id: "COPY" }), json({ id: "COPY" }));
    expect(await settle(api.find(LANDED, { signal: AbortSignal.timeout(45_000) }))).toEqual({ id: "COPY" });
    expect(await settle(api.request("GET", LANDED, { signal: new AbortController().signal }))).toEqual({ id: "COPY" });
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual([["items.get", "error", "timeout", 0], ["items.get", "success", "", 200], ["items.get", "success", "", 200]]);
  });

  it("sends a lookup that gets no answer three times where its caller gives no signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(unanswered, unanswered, unanswered);
    const { sending, ended } = timed(() => api.find(LANDED));
    expect(await failure(sending)).toEqual(["GraphTransportError", "Microsoft Graph did not answer in time."]);
    expect(sent).toHaveLength(3);
    expect(ended.after).toBeGreaterThanOrEqual(90_000);
  });

  it.each<[string, () => Response]>([
    ["holds no status", () => json({})],
    ["holds a status that is no text", () => json({ status: 5, resourceId: "COPY" })],
    ["is no JSON", () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })],
    ["is empty", () => new Response(null)],
    ["is JSON null", () => json(null)],
    ["is a JSON list", () => json([{ status: "completed" }])],
    ["is JSON text", () => json("completed")],
  ])("counts a read of a copy's progress whose answer %s as an answer that cannot be read, and sends it once", async (_what, answer) => {
    const { api, sent } = scripted(answer(), json({ status: "completed", resourceId: "COPY" }));
    const error = await api.copyProgress(MONITOR).catch((caught: unknown) => caught);
    expect(error).toMatchObject(unreadableStatus(502));
    expect(sent).toEqual([`GET ${MONITOR}`]);
    expect(counted()).toEqual([["copy.progress", "error", "parse", 200]]);
  });

  it("counts a read of a copy's progress answered 204, which holds no status, as an answer that cannot be read, by that status", async () => {
    const { api, sent } = scripted(new Response(null, { status: 204 }), json({ status: "completed", resourceId: "COPY" }));
    const error = await api.copyProgress(MONITOR).catch((caught: unknown) => caught);
    expect(error).toMatchObject(unreadableStatus(502));
    expect(sent).toEqual([`GET ${MONITOR}`]);
    expect(counted()).toEqual([["copy.progress", "error", "parse", 204]]);
  });

  it("counts a read of a copy's progress whose answer stops short as an answer that could not be read, and sends it once", async () => {
    const { api, sent } = scripted(stoppedShort(), json({ status: "completed", resourceId: "COPY" }));
    expect(await failure(api.copyProgress(MONITOR))).toEqual(["GraphTransportError", "Microsoft Graph's answer was cut off."]);
    expect(sent).toEqual([`GET ${MONITOR}`]);
    expect(counted()).toEqual([["copy.progress", "error", "parse", 200]]);
  });

  it("counts a read of a copy's progress that SharePoint refuses by the status of the refusal, whether or not its explanation can be read", async () => {
    const { api, sent } = scripted(json({ error: { message: "gone" } }, 404), new Response(stoppedShort().body, { status: 500 }));
    const refused = await api.copyProgress(MONITOR).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ name: "GraphApiError", status: 404, message: "SharePoint sent an unreadable copy status." });
    expect(await failure(api.copyProgress(MONITOR))).toEqual(["GraphTransportError", "Microsoft Graph's answer was cut off."]);
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["copy.progress", "error", "http", 404], ["copy.progress", "error", "http", 500]]);
  });

  it("reads a finished copy's redirect that names no item as a finished copy, and counts it a success", async () => {
    const { api, sent } = scripted(new Response(null, { status: 302, headers: { location: "https://contoso.sharepoint.com/sites/a" } }));
    expect(await api.copyProgress(MONITOR)).toEqual({ status: "completed" });
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["copy.progress", "success", "", 302]]);
  });

  it("asks again for a copy's progress whose answer its timeout cut off, and counts that attempt a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(stalled, json({ status: "completed", resourceId: "COPY" }));
    expect(await settle(api.copyProgress(MONITOR))).toEqual({ status: "completed", resourceId: "COPY" });
    expect(sent).toEqual([`GET ${MONITOR}`, `GET ${MONITOR}`]);
    expect(counted()).toEqual([["copy.progress", "error", "timeout", 200], ["copy.progress", "success", "", 200]]);
  });

  it("sends a read of a copy's progress three times at most, a send SharePoint throttled and one whose answer its timeout cut off alike", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(json({}, 429, { "retry-after": "0" }), stalled, stalled, json({ status: "completed", resourceId: "COPY" }));
    expect(await failure(api.copyProgress(MONITOR))).toEqual(["GraphTransportError", "Microsoft Graph's answer was cut off."]);
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual([
      ["copy.progress", "refused", "rate", 429], ["copy.progress", "error", "timeout", 200], ["copy.progress", "error", "timeout", 200],
    ]);
  });

  it("counts a copy's progress larger than an answer may be as an answer that cannot be read, and sends it once", async () => {
    const { api, sent } = scripted(
      new Response("{}", { headers: { "content-type": "application/json", "content-length": String(8 * 1024 * 1024 + 1) } }),
      json({ status: "completed", resourceId: "COPY" }));
    const error = await api.copyProgress(MONITOR).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "GraphApiError", status: 502, message: "Microsoft Graph sent an answer too large to read." });
    expect(sent).toEqual([`GET ${MONITOR}`]);
    expect(counted()).toEqual([["copy.progress", "error", "parse", 200]]);
  });

  it("reports no answer in time for a copy's progress that is asked again after its timeout cut an answer off and then gets none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(stalled, new TypeError("reset"), new TypeError("reset"), json({ status: "completed", resourceId: "COPY" }));
    expect(await failure(api.copyProgress(MONITOR))).toEqual(["GraphTransportError", "SharePoint did not report the copy's progress in time."]);
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual([
      ["copy.progress", "error", "timeout", 200], ["copy.progress", "error", "network", 0], ["copy.progress", "error", "network", 0],
    ]);
  });

  it.each<[string, () => Response, { name: string; status: number; message: string }, unknown[]]>([
    ["refuses", () => json({ error: { message: "gone" } }, 404), unreadableStatus(404), ["error", "http", 404]],
    ["holds no status", () => json({}), unreadableStatus(502), ["error", "parse", 200]],
    ["throttles for longer than the client waits", () => json({}, 429, { "retry-after": "3600" }), unreadableStatus(429), ["refused", "rate", 429]],
  ])("throws what the later answer says for a copy's progress asked again after its timeout cut an answer off, where that answer %s", async (_what, later, thrown, laterCount) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(stalled, later(), json({ status: "completed", resourceId: "COPY" }));
    expect(await settle(api.copyProgress(MONITOR))).toMatchObject({ error: thrown });
    expect(sent).toEqual([`GET ${MONITOR}`, `GET ${MONITOR}`]);
    expect(counted()).toEqual([["copy.progress", "error", "timeout", 200], ["copy.progress", ...laterCount]]);
  });

  it("reads a copy's progress on the third send, after one its timeout cut off and one SharePoint throttled for a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fakeTimeouts();
    const { api, sent } = scripted(stalled, json({}, 429, { "retry-after": "0" }), json({ status: "inProgress" }));
    expect(await settle(api.copyProgress(MONITOR))).toEqual({ status: "inProgress" });
    expect(sent).toHaveLength(3);
    expect(counted()).toEqual([
      ["copy.progress", "error", "timeout", 200], ["copy.progress", "refused", "rate", 429], ["copy.progress", "success", "", 200],
    ]);
  });

  it("ends a read of a copy's progress whose answer stalls as its caller's wait runs out, counted a timeout and not sent again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    fakeTimeouts();
    const { api, sent } = scripted(stalled, json({ status: "completed", resourceId: "COPY" }));
    const { sending, ended } = timed(() => api.copyProgress(MONITOR, AbortSignal.timeout(4_000)));
    expect(await failure(sending)).toEqual(["GraphTransportError", "Microsoft Graph's answer was cut off."]);
    expect(ended.after).toBe(4_000);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["copy.progress", "error", "timeout", 200]]);
  });

  it("leaves uncounted a read of a copy's progress that its caller gives up while its answer is read", async () => {
    const gaveUp = new AbortController();
    const { api, sent } = scripted(init => {
      queueMicrotask(() => gaveUp.abort());
      return stalled(init);
    }, json({ status: "completed", resourceId: "COPY" }));
    expect(await failure(api.copyProgress(MONITOR, gaveUp.signal))).toEqual(["GraphTransportError", "Microsoft Graph's answer was cut off."]);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([]);
  });

  it("uses each name it gives a request to another host", async () => {
    const { api } = scripted(
      new Response(null, { status: 302, headers: { location: "https://contoso.sharepoint.com/a" } }), new Response("x"),
      json({ status: "completed", resourceId: "1" }));
    await api.download("/drives/b!x/items/1/content", 1024);
    await api.copyProgress("https://contoso.sharepoint.com/_api/v2.0/monitor/copy-1");
    const used = new Set(counted().map(([operation]) => operation));
    expect(HOST_OPERATIONS.filter(name => !used.has(name))).toEqual([]);
  });
});

// A site, a file in a library, a list and a page, as the reads address them.
const SITE = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";
const FILE = { driveId: "b!x", itemId: "01ITEM" };
const LISTED = { siteId: SITE, listId: "33333333-3333-3333-3333-333333333333" };
const PAGE = { siteId: SITE, pageId: "44444444-4444-4444-4444-444444444444" };
const USER = "aaaaaaaa-0000-0000-0000-000000000001";

const mailOf = (api: GraphApi) => new MailApi(api, { kind: "me" });
const calendarOf = (api: GraphApi) => new CalendarApi(api, { kind: "me" });

// The answer of a facet a link does not have.
const miss = () => json({ error: { code: "itemNotFound" } }, 404);

// What a read throws for a success that is not the shape it asked for.
const malformed = (what: string) => ({ name: "GraphApiError", status: 502, message: `Microsoft Graph sent a malformed ${what}.` });

// A page that links to its next page on a host that is not Graph's, and what the client throws when asked for that page.
const ELSEWHERE = "https://evil.example/next";
const leadingElsewhere = { value: [], "@odata.nextLink": ELSEWHERE };
const unfollowed = { name: "Error", message: "Refusing to send a Microsoft 365 credential outside Microsoft Graph." };

// Each read that checks what a success holds: how it is sent, the success it refuses, the name the
// request is counted under and what the read throws.
const REFUSED: [what: string, send: (api: GraphApi) => Promise<unknown>, answer: unknown, operation: string, thrown: { name: string; message: unknown }][] = [
  ["a folder's children that hold no list", api => listChildren(api, FILE, undefined, 10), {}, "children.list", malformed("folder list")],
  ["a folder's children whose next page is on another host", api => listChildren(api, FILE, undefined, 10),
    { value: [], "@odata.nextLink": "https://evil.example/next" }, "children.list",
    { name: "GraphApiError", message: "Microsoft Graph returned a continuation link to somewhere else." }],
  ["a later page of a folder's children that holds no list", api => listChildren(api, FILE, `${ITEM}/children?$skiptoken=x`, 10), {}, "children.list", malformed("folder list")],
  ["an item that names no drive", api => getItem(api, FILE), { id: "01ITEM", name: "a.txt" }, "items.get", malformed("file")],
  ["a drive's root that names no drive", api => getRoot(api, "b!x"), { id: "01ROOT" }, "root.get", malformed("file")],
  ["a drive search that holds no list", api => searchDrive(api, "b!x", "plan", undefined, 10), {}, "items.search", malformed("search result list")],
  ["a search that is no object", api => searchAll(api, "plan", undefined, 0, 25), ["hit"], "search.query", malformed("search response")],
  ["a file's versions that hold no list", api => listVersions(api, FILE), { value: "none" }, "versions.list", malformed("version list")],
  ["a drive that has no ID", api => getDrive(api, "b!x"), { name: "Documents" }, "drives.get", malformed("library")],
  ["a site that has no ID", api => getSite(api, SITE), { webUrl: "https://contoso.sharepoint.com" }, "sites.get", malformed("site")],
  ["a site's libraries that hold no list", api => listDrives(api, SITE), {}, "drives.list", malformed("library list")],
  ["a site's subsites that hold no list", api => listSubsites(api, SITE), {}, "sites.list", malformed("site list")],
  ["a list that has no ID", api => getList(api, LISTED), { displayName: "Tasks" }, "lists.get", malformed("list")],
  ["a list's columns that hold no list", api => listColumns(api, LISTED), {}, "columns.list", malformed("column list")],
  ["a list's items that hold no list", api => listItems(api, LISTED, {}, undefined, 10, false), {}, "items.list", malformed("list item list")],
  ["a list item that has no ID", api => getListItem(api, LISTED, "9"), { fields: {} }, "items.get", malformed("list item")],
  ["a site's pages that hold no list", api => listPages(api, SITE, undefined, 10), {}, "pages.list", malformed("page list")],
  ["a page that has no name", api => getPage(api, PAGE), { id: PAGE.pageId }, "pages.get", malformed("page")],
  ["a workbook's worksheets that hold no list", api => listWorksheets(api, FILE), {}, "worksheets.list", malformed("worksheet list")],
  ["a worksheet range that holds no values", api => readRange(api, FILE, "{1}", "A1:B2"), { address: "Sheet1!A1:B2" }, "range.get", malformed("worksheet range")],

  ["a mailbox's calendars that hold no list", api => calendarOf(api).calendars(), {}, "calendars.list", malformed("calendar list")],
  ["the default calendar with no entry ID", api => calendarOf(api).calendar("default"), { id: "AAMk4" }, "calendar.get", malformed("calendar")],
  ["a calendar with no entry ID", api => calendarOf(api).calendar("AAMk4"), { id: "AAMk4" }, "calendars.get", malformed("calendar")],
  ["an event with no start", api => calendarOf(api).event("AAMk5"), { id: "AAMk5" }, "events.get", malformed("event")],
  ["an event's placement that is no object", api => calendarOf(api).placement("AAMk5"), ["event"], "events.get", malformed("event")],
  ["a calendar's view that holds no list", api => calendarOf(api).view("AAMk4", 0, 1000, 10), {}, "calendarView.list", malformed("event list")],
  ["an event's body that is no object", api => calendarOf(api).body("AAMk5"), ["body"], "events.get", malformed("event")],
  ["a schedule that names nobody", api => calendarOf(api).schedules(["sarah@contoso.com"], 0, 1000), { value: [{}] }, "calendar.getSchedule", malformed("schedule")],
  ["a calendar's sharing list that holds no list", api => calendarOf(api).permissions("AAMk4"), {}, "calendarPermissions.list", malformed("calendar permission list")],
  ["a mailbox's calendars whose next page is on another host", api => calendarOf(api).calendars(), leadingElsewhere, "calendars.list", unfollowed],
  ["a calendar's sharing list whose next page is on another host", api => calendarOf(api).permissions("AAMk4"), leadingElsewhere, "calendarPermissions.list", unfollowed],
  ["a later page of a calendar's view that holds no list", api => calendarOf(api).view("AAMk4", 0, 1000, 10, `${GRAPH}/me/calendars('AAMk4')/calendarView?$skip=10`), {},
    "calendarView.list", malformed("event list")],
  ["a batch of events that leaves one out", api => calendarOf(api).parents(["AAMk5"]), { responses: [] }, "batch",
    { name: "GraphApiError", message: "Microsoft Graph left an event out of a batch." }],

  ["a message that has no ID", api => mailOf(api).message("AAMk1"), { subject: "Hello" }, "messages.get", malformed("message")],
  ["a draft that is no object", api => mailOf(api).draft("AAMk1"), ["draft"], "messages.get", malformed("message")],
  ["a mail folder that has no ID", api => mailOf(api).folder("inbox"), { displayName: "Inbox" }, "mailFolders.get", malformed("folder")],
  ["a mailbox's folders that hold no list", api => mailOf(api).childFolders(null), {}, "mailFolders.list", malformed("folder list")],
  ["a folder's subfolders that hold no list", api => mailOf(api).childFolders("AAMk3"), {}, "childFolders.list", malformed("folder list")],
  ["a message's body that is no object", api => mailOf(api).body("AAMk1"), ["body"], "messages.get", malformed("message")],
  ["a message's attachments that hold no list", api => mailOf(api).attachments("AAMk1"), {}, "attachments.list", malformed("attachment list")],
  ["a page of messages that holds no list", api => mailOf(api).page("/messages", row => row, "message"), {}, "messages.list", malformed("message list")],
  ["a later page of messages that holds no list", api => mailOf(api).page(`${GRAPH}/me/messages?$skip=10`, row => row, "message"), {}, "messages.list", malformed("message list")],
  ["a mailbox's folders whose next page is on another host", api => mailOf(api).childFolders(null), leadingElsewhere, "mailFolders.list", unfollowed],
  ["a folder's subfolders whose next page is on another host", api => mailOf(api).childFolders("AAMk3"), leadingElsewhere, "childFolders.list", unfollowed],
  ["a message's attachments whose next page is on another host", api => mailOf(api).attachments("AAMk1"), leadingElsewhere, "attachments.list", unfollowed],
  ["an organization's domains that are no list", api => organizationDomains(api), { value: "contoso.com" }, "organization.list",
    { name: "TypeError", message: expect.stringContaining("flatMap is not a function") }],
  ["a batch of messages that leaves one out", api => mailOf(api).messages(["AAMk1"]), { responses: [] }, "batch",
    { name: "GraphApiError", message: "Microsoft Graph left a message out of a batch." }],
  ["a batch of Outlook's own folders that leaves one out", api => mailOf(api).wellKnownFolders(), { responses: [] }, "batch",
    { name: "GraphApiError", message: "Microsoft Graph left a folder out of a batch." }],
  ["a batch of mail probes that leaves one out", api => probeMailUnits(api, [{ kind: "mailbox", userId: USER }]), { responses: [] }, "batch",
    { name: "AccessProbeError", message: "Microsoft Graph could not check access (HTTP 502)." }],
  ["a batch of SharePoint probes that leaves one out", api => probeUnits(api, [{ kind: "drive", driveId: "b!x" }]), { responses: [] }, "batch",
    { name: "AccessProbeError", message: "Microsoft Graph could not check access (HTTP 502)." }],
];

describe("what the client counts of a success that is not what its request was sent for", () => {
  it.each(REFUSED)("counts %s as an error of the API, by the status of the answer, and sends it once", async (_what, send, answer, operation, thrown) => {
    const { api, sent } = scripted(json(answer), json({ value: [], responses: [] }));
    const error = await send(api).catch((caught: unknown) => caught);
    expect(error).toMatchObject(thrown);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([[operation, "error", "api", 200]]);
  });

  it.each([
    ["a read", (api: GraphApi) => api.get("/me/messages"), 200, "messages.list"],
    ["a lookup", (api: GraphApi) => api.find("/me/messages/AAMk1"), 200, "messages.get"],
    ["a write", (api: GraphApi) => api.request("POST", "/me/messages", { body: {} }), 201, "messages.create"],
  ] as const)("counts %s answered a success that is no JSON as an answer that cannot be read, sends it once and answers nothing", async (_kind, send, status, operation) => {
    const { api, sent } = scripted(new Response("<html>Sign in</html>", { status, headers: { "content-type": "text/html" } }), json({ id: "1" }));
    expect(await send(api)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([[operation, "error", "parse", status]]);
  });

  it("counts a read whose success is no JSON as an answer that cannot be read, whatever the read then makes of it", async () => {
    const { api, sent } = scripted(new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }));
    expect(await failure(listDrives(api, SITE))).toEqual(["GraphApiError", "Microsoft Graph sent a malformed library list."]);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["drives.list", "error", "parse", 200]]);
  });

  it("counts a success with no content, and one with an empty body, as the success it is", async () => {
    const { api } = scripted(new Response(null, { status: 204 }), new Response("", { status: 202 }));
    expect(await api.request("DELETE", "/me/messages/AAMk1")).toBeNull();
    expect(await api.request("POST", "/me/messages/AAMk1/send")).toBeNull();
    expect(counted()).toEqual([["messages.delete", "success", "", 204], ["messages.send", "success", "", 202]]);
  });

  it("counts a refusal that is no JSON by its status alone, as one that is", async () => {
    const { api } = scripted(new Response("<html>Bad gateway</html>", { status: 404 }), new Response("<html>Sign in</html>", { status: 403 }));
    expect(await failure(api.get("/me/messages/AAMk1"))).toEqual(["GraphApiError", "That item doesn't exist, or you don't have access to it."]);
    expect(await getItem(api, FILE)).toBeNull();
    expect(counted()).toEqual([["messages.get", "error", "http", 404], ["items.get", "error", "http", 403]]);
  });

  it("counts a lookup Graph refuses by the status of the refusal, though its read is asked about nothing", async () => {
    const { api } = scripted(json({ error: { code: "itemNotFound" } }, 404), json({ error: { code: "ErrorItemNotFound" } }, 404));
    expect(await getDrive(api, "b!x")).toBeNull();
    expect(await mailOf(api).message("AAMk1")).toBeNull();
    expect(counted()).toEqual([["drives.get", "error", "http", 404], ["messages.get", "error", "http", 404]]);
  });

  it("counts the lookup of the user's own OneDrive that is no library, and of its site that is no site, as errors of the API, and forgives neither as it does a refusal", async () => {
    const drive = { id: "b!me", name: "OneDrive", webUrl: "https://contoso-my.sharepoint.com/personal/ada_contoso_com/Documents", driveType: "business" };
    const { api, sent } = scripted(json({ name: "OneDrive" }), json(drive), json({ displayName: "Ada" }), json({ error: {} }, 500), json(drive), json({ error: {} }, 500));
    expect(await failure(myOneDriveSite(api))).toEqual(["GraphApiError", "Microsoft Graph sent a malformed library."]);
    expect(await failure(myOneDriveSite(api))).toEqual(["GraphApiError", "Microsoft Graph sent a malformed site."]);
    expect(await myOneDriveSite(api)).toBeNull();
    expect(await myOneDriveSite(api)).toBeNull();
    expect(sent).toHaveLength(6);
    expect(counted()).toEqual([
      ["drive.get", "error", "api", 200], ["drive.get", "success", "", 200], ["sites.get", "error", "api", 200],
      ["drive.get", "error", "http", 500], ["drive.get", "success", "", 200], ["sites.get", "error", "http", 500],
    ]);
  });

  it("counts a site's lists by each of its two requests: the lists that hold no list an error of the API, the pages probe a success", async () => {
    const { api } = scripted(json({}), json({ value: [] }));
    expect(await failure(listLists(api, SITE))).toEqual(["GraphApiError", "Microsoft Graph sent a malformed list list."]);
    expect(counted().toSorted()).toEqual([["lists.list", "error", "api", 200], ["pages.list", "success", "", 200]]);
  });

  it("counts a batch that leaves a request out as a success where its caller reads that request as absent", async () => {
    const { api, sent } = scripted(json({ responses: [] }));
    expect(await getItems(api, [FILE])).toEqual([null]);
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["batch", "success", "", 200]]);
  });

  it("counts a batch whose caller refuses a request left out as a success where each request is answered, whatever each is answered", async () => {
    const { api } = scripted(
      json({ responses: [{ id: "0", status: 404, body: {} }] }), json({ responses: [{ id: "0", status: 500, body: {} }] }),
      json({ responses: [{ id: "0", status: 200, body: ["message"] }] }));
    expect(await mailOf(api).messages(["AAMk1"])).toEqual(new Map());
    expect(await failure(mailOf(api).messages(["AAMk1"]))).toEqual(["GraphApiError", "Microsoft Graph couldn't read some messages. Try again shortly."]);
    expect(await failure(mailOf(api).messages(["AAMk1"]))).toEqual(["GraphApiError", "Microsoft Graph sent a malformed message."]);
    expect(counted()).toEqual(Array.from({ length: 3 }, () => ["batch", "success", "", 200]));
  });

  it("counts each send of a batch that leaves out a request it answered a throttle for, and sends that request no third time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { api, sent } = scripted(
      json({ responses: [{ id: "0", status: 200, body: { id: "AAMk1" } }, { id: "1", status: 429, headers: { "Retry-After": "1" } }] }),
      json({ responses: [] }));
    expect(await failure(mailOf(api).messages(["AAMk1", "AAMk2"]))).toEqual(["GraphApiError", "Microsoft Graph left a message out of a batch."]);
    expect(sent).toHaveLength(2);
    expect(countedCalls()).toEqual([["batch", "success", "", 200], ["batch", "error", "api", 200]]);
  });

  // A link, the answers Graph gives the facets asked of it, and what resolving it comes to.
  const TENANT = { name: "contoso", id: "99999999-9999-9999-9999-999999999999" };
  const WEB = "https://contoso.sharepoint.com/sites/Engineering";
  const library = { id: LISTED.listId, displayName: "Documents", webUrl: `${WEB}/Shared%20Documents`, list: { template: "documentLibrary" }, parentReference: { siteId: SITE } };
  const unresolvable = { name: "UnresolvableUrlError", message: "That link doesn't lead to anything in SharePoint or OneDrive you can open." };

  it.each<[string, string, (() => Response)[], unknown, string, { name: string; message: string }]>([
    ["a site link whose site has no ID", WEB, [], { webUrl: WEB }, "site.get", malformed("site")],
    ["a file link whose item names no drive", `${WEB}/Shared%20Documents/a.txt`, [], { id: "01ITEM", name: "a.txt" }, "driveItem.get", malformed("file")],
    ["a list link whose list has no ID", `${WEB}/Lists/Tasks/AllItems.aspx`, [miss], { displayName: "Tasks" }, "list.get", malformed("list")],
    ["a web's link whose site has no ID", WEB, [miss, miss, miss], { webUrl: WEB }, "sites.get", malformed("site")],
    ["a library link whose library names no drive", `${WEB}/Shared%20Documents/Forms/AllItems.aspx`, [miss, () => json(library)], { name: "Documents" }, "drive.get", unresolvable],
    ["a file link whose item names no site", `${WEB}/Shared%20Documents/a.txt`, [], { id: "01ITEM", name: "a.txt", parentReference: { driveId: "b!x" } }, "driveItem.get", unresolvable],
    ["a list link whose list names no site", `${WEB}/Lists/Tasks/AllItems.aspx`, [miss], { id: LISTED.listId, displayName: "Tasks", webUrl: `${WEB}/Lists/Tasks` }, "list.get", unresolvable],
  ])("counts %s as an error of the API, by the status of the answer, and asks Graph nothing after it", async (_what, link, ahead, answer, operation, thrown) => {
    const { api, sent } = scripted(...ahead.map(reply => reply()), json(answer), json({ id: "b!x" }));
    const error = await resolveSharePointUrl(api, link, TENANT).catch((caught: unknown) => caught);
    expect(error).toMatchObject(thrown);
    expect(sent).toHaveLength(ahead.length + 1);
    expect(counted().at(-1)).toEqual([operation, "error", "api", 200]);
  });

  it("counts a link Graph places in another organization as the success its answer is, and refuses the link", async () => {
    const elsewhere = { sharepointIds: { tenantId: "88888888-8888-8888-8888-888888888888" } };
    const { api, sent } = scripted(json({ ...elsewhere, id: "01ITEM", name: "a.txt" }), json(elsewhere));
    expect(await resolveSharePointUrl(api, `${WEB}/Shared%20Documents/a.txt`, TENANT).catch((caught: unknown) => caught)).toBeInstanceOf(OtherOrganizationError);
    // An answer that is another organization's and not what was asked for either is refused as another organization's.
    expect(await resolveSharePointUrl(api, WEB, TENANT).catch((caught: unknown) => caught)).toBeInstanceOf(OtherOrganizationError);
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["driveItem.get", "success", "", 200], ["site.get", "success", "", 200]]);
  });

  it("counts a library link whose library has no drive by the status of that refusal", async () => {
    const { api } = scripted(miss(), json(library), miss());
    expect(await resolveSharePointUrl(api, `${WEB}/Shared%20Documents/Forms/AllItems.aspx`, TENANT).catch((caught: unknown) => caught)).toBeInstanceOf(UnresolvableUrlError);
    expect(counted().at(-1)).toEqual(["drive.get", "error", "http", 404]);
  });

  it("counts the lookup of a shared mailbox's owner who has no ID as an error of the API, and one that finds nobody by its status", async () => {
    const link = "https://outlook.office.com/mail/sarah@contoso.com/";
    const nobody = new OutlookUrlError("There's no mailbox sarah@contoso.com in your organization that you can open.");
    const { api, sent } = scripted(json({ mail: "sarah@contoso.com" }), json({ error: { code: "Request_ResourceNotFound" } }, 404));
    await expect(resolveOutlookUrl(api, link, "read", "ada@contoso.com")).rejects.toStrictEqual(nobody);
    await expect(resolveOutlookUrl(api, link, "read", "ada@contoso.com")).rejects.toStrictEqual(nobody);
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["users.get", "error", "api", 200], ["users.get", "error", "http", 404]]);
  });

  it("returns a page whose link to the next leaves Graph as it came, counts it as an error of the API, and sends nothing to that link", async () => {
    const { api, sent } = scripted(json({ value: [{ id: "AAMk1" }], "@odata.nextLink": ELSEWHERE }), json(leadingElsewhere), json({ value: [] }));
    expect(await mailOf(api).page("/messages", row => row, "message")).toEqual({ items: [{ id: "AAMk1" }], nextLink: ELSEWHERE });
    expect(await calendarOf(api).view("AAMk4", 0, 1000, 10)).toEqual({ items: [], nextLink: ELSEWHERE });
    expect(await failure(mailOf(api).page(ELSEWHERE, row => row, "message"))).toEqual([unfollowed.name, unfollowed.message]);
    expect(await failure(calendarOf(api).view("AAMk4", 0, 1000, 10, ELSEWHERE))).toEqual([unfollowed.name, unfollowed.message]);
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["messages.list", "error", "api", 200], ["calendarView.list", "error", "api", 200]]);
  });

  it("counts a page by whether the client refuses the link to the next: one that is no https URL, which Graph would be asked for as a path, is no refusal", async () => {
    const { api, sent } = scripted(json({ value: [], "@odata.nextLink": "http://evil.example/next" }), json({ value: [], "@odata.nextLink": "/me/messages?$skip=10" }));
    expect(await mailOf(api).page("/messages", row => row, "message")).toEqual({ items: [], nextLink: "http://evil.example/next" });
    expect(await calendarOf(api).view("AAMk4", 0, 1000, 10)).toEqual({ items: [], nextLink: "/me/messages?$skip=10" });
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["messages.list", "success", "", 200], ["calendarView.list", "success", "", 200]]);
  });

  it("counts a page whose link to the next is Graph's as the success it is, and the page that link leads to", async () => {
    const folder = { id: "AAMk3", displayName: "Vendors" };
    const { api, sent } = scripted(json({ value: [folder], "@odata.nextLink": `${GRAPH}/me/mailFolders?$skip=1` }), json({ value: [{ ...folder, id: "AAMk4" }] }));
    expect((await mailOf(api).childFolders(null)).map(found => found.id)).toEqual(["AAMk3", "AAMk4"]);
    expect(sent).toEqual([expect.stringContaining("/me/mailFolders?"), `GET ${GRAPH}/me/mailFolders?$skip=1`]);
    expect(counted()).toEqual([["mailFolders.list", "success", "", 200], ["mailFolders.list", "success", "", 200]]);
  });

  it.each<[string, () => Response, number]>([
    ["no content", () => new Response(null, { status: 204 }), 204],
    ["an empty body", () => new Response("", { status: 200 }), 200],
    ["an empty body and a status that names none", () => new Response("", { status: 202 }), 202],
    ["a JSON null", () => json(null), 200],
  ])("counts a GET answered a success with %s by whether its caller takes nothing for an answer, and sends it once", async (_what, answer, status) => {
    const { api, sent } = scripted(answer(), answer(), answer(), answer(), answer(), answer());
    // A caller that asks for what may not be there is answered the nothing, and the request is the success its status says.
    expect(await api.find("/me/messages/AAMk1")).toBeNull();
    expect(await api.request("GET", "/me/messages/AAMk1")).toBeNull();
    expect(await getDrive(api, "b!x")).toBeNull();
    expect(await mailOf(api).folder("inbox")).toBeNull();
    // One that asks for what it then reads is answered what it was not sent for, whatever it makes of the nothing.
    expect(await api.get("/me/messages")).toBeNull();
    expect(await failure(usedRangeShape(api, FILE, "{1}"))).toEqual(["TypeError", "Cannot read properties of null (reading 'address')"]);
    expect(sent).toHaveLength(6);
    expect(counted()).toEqual([
      ...["messages.get", "messages.get", "drives.get", "mailFolders.get"].map(operation => [operation, "success", "", status]),
      ["messages.list", "error", "api", status], ["usedRange.get", "error", "api", status],
    ]);
  });

  it("counts the read of who is signed in answered a success that holds nothing by its status, and takes the address for another person's", async () => {
    const address = "sarah@contoso.com";
    const { api, sent } = scripted(json({ id: USER, mail: address }), new Response("", { status: 200 }), miss());
    await expect(resolveCalendarUrl(api, `https://outlook.office.com/calendar/${address}/default`, "read", "ada@contoso.com"))
      .rejects.toBeInstanceOf(CalendarUrlError);
    // The calendar is then asked for as that person's.
    expect(sent.map(request => new URL(request.slice("GET ".length)).pathname))
      .toEqual([`/v1.0/users/${encodeURIComponent(address)}`, "/v1.0/me", `/v1.0/users/${USER}/calendar`]);
    expect(counted().slice(0, 2)).toEqual([["users.get", "success", "", 200], ["me.get", "success", "", 200]]);
  });

  it.each<[string, () => Response]>([
    ["holds no list of schedules", () => json({})],
    ["holds nothing", () => new Response(null, { status: 200 })],
  ])("counts a free/busy answer that %s as an error of the API, and answers each person asked about as unreadable", async (_what, answer) => {
    const { api, sent } = scripted(answer(), json({ value: [] }));
    const unreadable = { address: "sarah@contoso.com", items: [], error: "Their free/busy couldn't be read." };
    expect(await calendarOf(api).schedules(["sarah@contoso.com"], 0, 1000)).toEqual([unreadable]);
    // A list that leaves a person out is one Graph gave: the person is answered the same, and the request is a success.
    expect(await calendarOf(api).schedules(["sarah@contoso.com"], 0, 1000)).toEqual([unreadable]);
    expect(sent).toHaveLength(2);
    expect(counted()).toEqual([["calendar.getSchedule", "error", "api", 200], ["calendar.getSchedule", "success", "", 200]]);
  });

  it("counts a write answered a success that holds nothing, and a GET answered what it asked for, as the successes they are", async () => {
    const { api } = scripted(new Response("", { status: 200 }), json(null, 201), json({ address: "Sheet1!A1:B2", rowCount: 2, columnCount: 2 }));
    expect(await api.request("PATCH", "/me/messages/AAMk1", { body: {} })).toBeNull();
    expect(await api.request("POST", "/me/messages", { body: {} })).toBeNull();
    expect(await usedRangeShape(api, FILE, "{1}")).toEqual({ address: "Sheet1!A1:B2", rowCount: 2, columnCount: 2 });
    expect(counted()).toEqual([["messages.patch", "success", "", 200], ["messages.create", "success", "", 201], ["usedRange.get", "success", "", 200]]);
  });

  it("counts the lookup of a shared mailbox's owner answered a success that holds nothing by its status, and finds no mailbox as where Graph finds nobody", async () => {
    const { api, sent } = scripted(new Response("", { status: 200 }));
    await expect(resolveOutlookUrl(api, "https://outlook.office.com/mail/sarah@contoso.com/", "read", "ada@contoso.com"))
      .rejects.toStrictEqual(new OutlookUrlError("There's no mailbox sarah@contoso.com in your organization that you can open."));
    expect(sent).toHaveLength(1);
    expect(counted()).toEqual([["users.get", "success", "", 200]]);
  });

  it("counts a directory lookup answered a user with no ID as an error of the API, and searches for the address as it does where Graph finds nobody", async () => {
    const address = "sarah@contoso.com";
    const { api, sent } = scripted(
      json({ mail: address }), json({ value: [{ mail: address }] }),
      miss(), json({ value: [] }),
      miss(), json({ value: [{ id: USER, mail: address, displayName: "Sarah" }] }),
      json({ id: USER }));
    expect(await findUser(api, address)).toBeNull();
    expect(await findUser(api, address)).toBeNull();
    expect(await findUser(api, address)).toEqual({ id: USER, mail: address, displayName: "Sarah" });
    expect(await findUser(api, address)).toEqual({ id: USER, mail: address });
    expect(sent).toHaveLength(7);
    expect(counted()).toEqual([
      ["users.get", "error", "api", 200], ["users.list", "error", "api", 200],
      ["users.get", "error", "http", 404], ["users.list", "success", "", 200],
      ["users.get", "error", "http", 404], ["users.list", "success", "", 200],
      ["users.get", "success", "", 200],
    ]);
  });

  it("counts a directory search the grant cannot make by the status of its refusal, and one that is no list of users as the nobody it finds", async () => {
    const { api } = scripted(json({ error: { code: "Authorization_RequestDenied" } }, 403), json({}));
    expect(await findUserByMail(api, "sarah@contoso.com")).toBeNull();
    expect(await findUserByMail(api, "sarah@contoso.com")).toBeNull();
    expect(counted()).toEqual([["users.list", "error", "http", 403], ["users.list", "success", "", 200]]);
  });

  // The sites a browse is answered: the tenant's root site, the sites the user follows and Microsoft Search's.
  const root = { id: "contoso.sharepoint.com,00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002", displayName: "Contoso", webUrl: "https://contoso.sharepoint.com" };
  const noHits = { value: [{ hitsContainers: [{ hits: [] }] }] };

  it("counts the followed sites of a browse that hold no list as an error of the API, and browses on without them", async () => {
    const api = routed([["/sites/root", () => json(root)], ["/me/followedSites", () => json({})], ["/search/query", () => json(noHits)]]);
    expect((await browseSites(api, undefined, 0, 25)).sites.map(site => site.name)).toEqual(["Contoso"]);
    expect(counted().toSorted()).toEqual([["followedSites.list", "error", "api", 200], ["search.query", "success", "", 200], ["sites.get", "success", "", 200]]);
  });

  it("counts the site search of a browse that is no object as an error of the API, and reports it beside the sites the browse did find", async () => {
    const api = routed([["/sites/root", () => json(root)], ["/me/followedSites", () => json({ value: [] })], ["/search/query", () => json(["hit"])]]);
    const browsed = await browseSites(api, undefined, 0, 25);
    expect(browsed.sites.map(site => site.name)).toEqual(["Contoso"]);
    expect(browsed.searchError).toMatchObject(malformed("search response"));
    expect(counted().toSorted()).toEqual([["followedSites.list", "success", "", 200], ["search.query", "error", "api", 200], ["sites.get", "success", "", 200]]);
  });
});
