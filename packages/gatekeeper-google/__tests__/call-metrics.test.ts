import { env } from "cloudflare:workers";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeSubserviceCallPoint, subserviceTally, type SubserviceCallInput,
} from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOOGLE_API_SOURCE, googleOperation, googleService, ID, ONE, recordCall, REST, ROUTES, summedInto,
  type Tree,
} from "../src/call-metrics";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

const CALL: SubserviceCallInput = {
  source: GOOGLE_API_SOURCE, service: "google-drive", operation: "GET", outcome: "success",
  httpStatus: 200,
};

// Makes a call after an await, as a client deep in the work does.
async function later(operation: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1));
  recordCall({ ...CALL, operation });
}

describe("googleService", () => {
  // The base URL each client builds its requests on, as the file that holds it writes it.
  it.each([
    ["google-api.ts", "https://gmail.googleapis.com/gmail/v1/users/me/", "google-gmail"],
    ["google-api.ts", "https://www.googleapis.com/oauth2/v3/userinfo", "google-oauth"],
    ["google-api.ts", "https://oauth2.googleapis.com/token", "google-oauth"],
    ["google-api.ts", "https://oauth2.googleapis.com/revoke", "google-oauth"],
    ["drive-api.ts", "https://www.googleapis.com/drive/v3", "google-drive"],
    ["drive-api.ts", "https://www.googleapis.com/batch/drive/v3", "google-drive"],
    ["calendar-api.ts", "https://www.googleapis.com/calendar/v3", "google-calendar"],
    ["docs-api.ts", "https://docs.googleapis.com/v1/documents", "google-docs"],
    ["sheets-api.ts", "https://sheets.googleapis.com/v4/spreadsheets", "google-sheets"],
    ["slides-api.ts", "https://slides.googleapis.com/v1/presentations", "google-slides"],
    ["chat-api.ts", "https://chat.googleapis.com/v1", "google-chat"],
    ["chat-api.ts", "https://people.googleapis.com/v1", "google-people"],
    ["bigquery-api.ts", "https://bigquery.googleapis.com/bigquery/v2", "google-bigquery"],
    ["chat-hooks.ts", "https://workspaceevents.googleapis.com/v1", "google-events"],
  ])("%s: %s is %s", (file, base, service) => {
    expect(readFileSync(join(SOURCE_DIR, file), "utf8")).toContain(base);
    expect(googleService(base)).toBe(service);
    expect(googleService(`${base}/1aBcD:batchUpdate?fields=id&q=name`)).toBe(service);
  });

  it("names Drive's upload endpoint, one segment down like its batch endpoint", () => {
    expect(googleService("https://www.googleapis.com/upload/drive/v3/files?uploadType=media"))
        .toBe("google-drive");
  });

  it.each([
    "https://lh3.googleusercontent.com/a/thumbnail",
    "https://www.googleapis.com/storage/v1/b",
    "https://www.googleapis.com/batch",
    "https://www.googleapis.com/",
    "https://www.googleapis.com/constructor/v1",
    "https://gmail.googleapis.com.example.com/gmail/v1/users/me/profile",
    "https://example.com/drive/v3/files",
    "/drive/v3/files",
    "",
  ])("%j is google-other", url => {
    expect(googleService(url)).toBe("google-other");
  });
});

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const BIGQUERY = "https://bigquery.googleapis.com/bigquery/v2";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const CHAT = "https://chat.googleapis.com/v1";
const PEOPLE = "https://people.googleapis.com/v1";
const EVENTS = "https://workspaceevents.googleapis.com/v1";

// Each kind of request the clients make to a URL that names it: its method, its URL as the client
// builds it, and its name.
const REQUESTS: [method: string, url: string, name: string][] = [
  // Gmail
  ["GET", `${GMAIL}/threads?maxResults=20&q=is%3Aunread&includeSpamTrash=true`, "threads.list"],
  ["GET", `${GMAIL}/threads/18c2f0a1b2c3d4e5?format=minimal`, "threads.get"],
  ["POST", `${GMAIL}/threads/18c2f0a1b2c3d4e5/modify`, "threads.modify"],
  ["POST", `${GMAIL}/threads/18c2f0a1b2c3d4e5/trash`, "threads.trash"],
  ["POST", `${GMAIL}/threads/18c2f0a1b2c3d4e5/untrash`, "threads.untrash"],
  ["GET", `${GMAIL}/messages?maxResults=20&q=from%3Aada`, "messages.list"],
  ["GET", `${GMAIL}/messages/18c2f0a1b2c3d4e6?format=full`, "messages.get"],
  ["POST", `${GMAIL}/messages/batchModify`, "messages.batchModify"],
  ["POST", `${GMAIL}/messages/send`, "messages.send"],
  ["GET", `${GMAIL}/messages/18c2f0a1b2c3d4e6/attachments/ANGjdJ8?fields=data`, "attachments.get"],
  ["GET", `${GMAIL}/drafts?maxResults=20`, "drafts.list"],
  ["GET", `${GMAIL}/drafts/r-123?format=raw`, "drafts.get"],
  ["POST", `${GMAIL}/drafts`, "drafts.create"],
  ["PUT", `${GMAIL}/drafts/r-123`, "drafts.update"],
  ["DELETE", `${GMAIL}/drafts/r-123`, "drafts.delete"],
  ["POST", `${GMAIL}/drafts/send`, "drafts.send"],
  ["GET", `${GMAIL}/labels`, "labels.list"],
  ["GET", `${GMAIL}/labels/Label_1`, "labels.get"],
  ["POST", `${GMAIL}/labels`, "labels.create"],
  ["PATCH", `${GMAIL}/labels/Label_1`, "labels.patch"],
  ["DELETE", `${GMAIL}/labels/Label_1`, "labels.delete"],
  ["GET", `${GMAIL}/profile`, "profile.get"],
  ["POST", `${GMAIL}/watch`, "watch"],
  ["GET", `${GMAIL}/history?startHistoryId=42&historyTypes=messageAdded`, "history.list"],
  // Drive
  ["GET", `${DRIVE}/files?q=trashed%3Dfalse&pageSize=100`, "files.list"],
  ["GET", `${DRIVE}/files/1aBcD?fields=id&supportsAllDrives=true`, "files.get"],
  ["GET", `${DRIVE}/files/1aBcD?alt=media&supportsAllDrives=true`, "files.get.media"],
  ["GET", `${DRIVE}/files/generateIds?count=1&space=drive`, "files.generateIds"],
  ["POST", `${DRIVE}/files?fields=id&supportsAllDrives=true`, "files.create"],
  ["PATCH", `${DRIVE}/files/1aBcD?addParents=2eFgH&removeParents=3iJkL`, "files.patch"],
  ["POST", `${DRIVE}/files/1aBcD/copy?supportsAllDrives=true`, "files.copy"],
  ["POST", `${DRIVE_UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, "files.create.resumable"],
  ["PATCH", `${DRIVE_UPLOAD}/files/1aBcD?uploadType=resumable`, "files.patch.resumable"],
  ["GET", `${DRIVE}/drives?pageSize=100`, "drives.list"],
  ["GET", `${DRIVE}/about?fields=maxImportSizes`, "about.get"],
  ["GET", `${DRIVE}/files/1aBcD/permissions?pageSize=100`, "permissions.list"],
  ["POST", `${DRIVE}/files/1aBcD/permissions?sendNotificationEmail=true`, "permissions.create"],
  ["PATCH", `${DRIVE}/files/1aBcD/permissions/10000000000000000002`, "permissions.patch"],
  ["DELETE", `${DRIVE}/files/1aBcD/permissions/10000000000000000002`, "permissions.delete"],
  ["GET", `${DRIVE}/files/1aBcD/comments?pageSize=100`, "comments.list"],
  ["GET", `${DRIVE}/files/1aBcD/comments/AAAAxyz?fields=id`, "comments.get"],
  ["POST", `${DRIVE}/files/1aBcD/comments?fields=id`, "comments.create"],
  ["GET", `${DRIVE}/files/1aBcD/comments/AAAAxyz/replies?pageSize=100`, "replies.list"],
  ["POST", `${DRIVE}/files/1aBcD/comments/AAAAxyz/replies?fields=id`, "replies.create"],
  // Calendar
  ["GET", `${CALENDAR}/users/me/calendarList?maxResults=250`, "calendarList.list"],
  ["GET", `${CALENDAR}/users/me/calendarList/team%40group.calendar.google.com`, "calendarList.get"],
  ["GET", `${CALENDAR}/calendars/team%40group.calendar.google.com/events?singleEvents=true`, "events.list"],
  ["GET", `${CALENDAR}/calendars/primary/events/evt123`, "events.get"],
  ["POST", `${CALENDAR}/calendars/primary/events?sendUpdates=all`, "events.create"],
  ["PATCH", `${CALENDAR}/calendars/primary/events/evt123?sendUpdates=all`, "events.patch"],
  ["DELETE", `${CALENDAR}/calendars/primary/events/evt123?sendUpdates=all`, "events.delete"],
  ["POST", `${CALENDAR}/freeBusy`, "freeBusy"],
  // BigQuery
  ["GET", `${BIGQUERY}/projects?maxResults=1000`, "projects.list"],
  ["GET", `${BIGQUERY}/projects/example.com%3Awarehouse/datasets?maxResults=1000`, "datasets.list"],
  ["GET", `${BIGQUERY}/projects/warehouse/datasets/sales`, "datasets.get"],
  ["GET", `${BIGQUERY}/projects/warehouse/datasets/sales/tables?maxResults=1000`, "tables.list"],
  ["GET", `${BIGQUERY}/projects/warehouse/datasets/sales/tables/orders`, "tables.get"],
  ["POST", `${BIGQUERY}/projects/warehouse/queries`, "queries.create"],
  ["GET", `${BIGQUERY}/projects/warehouse/queries/job_abc?location=US`, "queries.get"],
  ["POST", `${BIGQUERY}/projects/warehouse/jobs`, "jobs.create"],
  ["POST", `${BIGQUERY}/projects/warehouse/jobs/job_abc/cancel?location=US`, "jobs.cancel"],
  // Docs, Sheets and Slides
  ["POST", `${DOCS}?fields=documentId`, "documents.create"],
  ["GET", `${DOCS}/1aBcD?includeTabsContent=true`, "documents.get"],
  ["POST", `${DOCS}/1aBcD:batchUpdate`, "documents.batchUpdate"],
  ["POST", `${SHEETS}?fields=spreadsheetId`, "spreadsheets.create"],
  ["GET", `${SHEETS}/1aBcD?fields=properties`, "spreadsheets.get"],
  ["POST", `${SHEETS}/1aBcD:getByDataFilter?fields=sheets`, "spreadsheets.getByDataFilter"],
  ["POST", `${SHEETS}/1aBcD:batchUpdate`, "spreadsheets.batchUpdate"],
  ["GET", `${SHEETS}/1aBcD/values:batchGet?ranges=Sheet1!A1%3AB2`, "values.batchGet"],
  ["POST", `${SHEETS}/1aBcD/values:batchGetByDataFilter`, "values.batchGetByDataFilter"],
  ["GET", `${SHEETS}/1aBcD/developerMetadata/7?fields=metadataValue`, "developerMetadata.get"],
  ["POST", `${SLIDES}?fields=presentationId`, "presentations.create"],
  ["GET", `${SLIDES}/1aBcD?fields=title`, "presentations.get"],
  ["POST", `${SLIDES}/1aBcD:batchUpdate`, "presentations.batchUpdate"],
  ["GET", `${SLIDES}/1aBcD/pages/g1f2e3?fields=objectId`, "pages.get"],
  ["GET", `${SLIDES}/1aBcD/pages/g1f2e3/thumbnail?thumbnailProperties.mimeType=PNG`, "thumbnail.get"],
  // Chat's attachments, People and Workspace Events
  ["GET", `${CHAT}/media/spaces/AAAA/messages/BBB.CCC/attachments/DDD?alt=media`, "media.get.media"],
  ["GET", `${PEOPLE}/people:searchDirectoryPeople?query=ada&readMask=names`, "people.searchDirectoryPeople"],
  ["GET", `${PEOPLE}/people:batchGet?personFields=names&resourceNames=people%2F1`, "people.batchGet"],
  ["POST", `${EVENTS}/subscriptions`, "subscriptions.create"],
  ["GET", `${EVENTS}/subscriptions?filter=event_types%3A%22x%22`, "subscriptions.list"],
  ["GET", `${EVENTS}/subscriptions/chat-spaces-abc`, "subscriptions.get"],
  ["POST", `${EVENTS}/subscriptions/chat-spaces-abc:reactivate`, "subscriptions.reactivate"],
  ["PATCH", `${EVENTS}/subscriptions/chat-spaces-abc?updateMask=ttl`, "subscriptions.patch"],
  ["DELETE", `${EVENTS}/subscriptions/chat-spaces-abc`, "subscriptions.delete"],
  // OAuth
  ["GET", "https://www.googleapis.com/oauth2/v3/userinfo", "userinfo.get"],
  ["POST", "https://oauth2.googleapis.com/revoke", "revoke"],
];

// Chat's requests, whose names were once passed by each caller: what production wrote then.
const CHAT_REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${CHAT}/spaces?pageSize=100`, "spaces.list"],
  ["GET", `${CHAT}/spaces:search?query=customer`, "spaces.search"],
  ["GET", `${CHAT}/spaces/AAAA`, "spaces.get"],
  ["GET", `${CHAT}/spaces:findDirectMessage?name=users%2F1`, "spaces.findDirectMessage"],
  ["GET", `${CHAT}/spaces:findGroupChats?users=users%2F1&users=users%2F2`, "spaces.findGroupChats"],
  ["POST", `${CHAT}/spaces:setup`, "spaces.setup"],
  ["GET", `${CHAT}/spaces/AAAA/messages?pageSize=100&orderBy=createTime+desc`, "messages.list"],
  ["POST", `${CHAT}/spaces/-/messages:search`, "messages.search"],
  ["GET", `${CHAT}/spaces/AAAA/messages/BBB.CCC`, "messages.get"],
  ["POST", `${CHAT}/spaces/AAAA/messages?requestId=r1&messageId=client-1`, "messages.create"],
  ["PATCH", `${CHAT}/spaces/AAAA/messages/BBB.CCC?updateMask=text`, "messages.patch"],
  ["DELETE", `${CHAT}/spaces/AAAA/messages/BBB.CCC`, "messages.delete"],
  ["GET", `${CHAT}/spaces/AAAA/members?pageSize=100`, "members.list"],
  ["GET", `${CHAT}/spaces/AAAA/members/ada%40example.com`, "members.get"],
  ["GET", `${CHAT}/spaces/AAAA/messages/BBB.CCC/reactions?pageSize=100`, "reactions.list"],
  ["POST", `${CHAT}/spaces/AAAA/messages/BBB.CCC/reactions`, "reactions.create"],
  ["DELETE", `${CHAT}/spaces/AAAA/messages/BBB.CCC/reactions/RRR`, "reactions.delete"],
];

// Where each path of the tree ends: the URLs that end there and, at a verb, its method.
type End = { path: string; url: RegExp; method?: string };
function ends(tree: Tree, path: string): End[] {
  let children = Object.entries(tree);
  if (children.length === 0) return [{ path, url: urlsOf(path) }];
  return children.flatMap(([key, child]) => {
    let to = key.startsWith(":") ? path + key : `${path}/${key}`;
    if (typeof child === "object") return ends(child, to);
    return [{ path: to, url: urlsOf(to), method: child === ONE ? undefined : child }];
  });
}
function urlsOf(path: string): RegExp {
  let source = path.split(/(\{id\+?\})/).map(part =>
    part === REST ? ".+" : part === ID ? "[^/:]+" : part.replaceAll(".", "\\.")).join("");
  return new RegExp(`^${source}$`);
}
const ENDS = ROUTES.flatMap(([root, tree]) => ends(tree, root.slice(0, -1)));

function keys(tree: Tree): string[] {
  return Object.entries(tree).flatMap(([key, child]) =>
    [key, ...(typeof child === "object" ? keys(child) : [])]);
}
// Every word a name can be made of: the tree's keys, the verbs an HTTP method stands for and the
// two suffixes.
const WORDS = new Set([
  ...ROUTES.flatMap(([, tree]) => keys(tree)).filter(key => key !== ID && key !== REST)
      .map(key => key.replace(":", "")),
  "list", "get", "create", "update", "patch", "delete", "media", "resumable",
]);

// URLs that say nothing of what their request does, each named by its method.
const UNNAMED: [method: string, url: string][] = [
  // The same URL exchanges a code and refreshes a token, and a batch is of any request.
  ["POST", "https://oauth2.googleapis.com/token"],
  ["POST", "https://www.googleapis.com/batch/drive/v3"],
  ["GET", "https://www.googleapis.com/oauth2/v3/certs"],
  // A resource or a verb that is not in the tree, anywhere in the path.
  ["GET", `${DRIVE}/files/1aBcD/revisions`],
  ["GET", `${DRIVE}/files/1aBcD/revisions/7`],
  ["GET", `${DRIVE}/files/1aBcD/export?mimeType=application%2Fpdf`],
  ["POST", `${DRIVE}/files/1aBcD:archive`],
  ["POST", "https://chat.googleapis.com/upload/v1/spaces/AAAA/attachments:upload"],
  ["POST", `${GMAIL}/threads/18c2f0a1b2c3d4e5/modify/again`],
  ["GET", "https://www.googleapis.com/storage/v1/b"],
  // And as the path's first resource, whatever known word follows it, an ID's included.
  ["POST", `${DRIVE}/changes/watch`],
  ["GET", "https://www.googleapis.com/storage/v1/b/files/o"],
  ["GET", "https://gmail.googleapis.com/gmail/v1/users/ada%40example.com/threads"],
  ["GET", `${CHAT}/customEmojis/files`],
  // A path that is not in the tree, though each of its words is.
  ["GET", `${DRIVE}/drives/0AAbCd`],
  ["GET", `${DRIVE}/files/1aBcD/replies`],
  // A verb under a method that is not its own, where the path has no ID.
  ["GET", `${GMAIL}/threads/18c2f0a1b2c3d4e5/modify`],
  ["GET", `${GMAIL}/watch`],
  ["GET", `${CHAT}/spaces/AAAA/messages:search`],
  // A property every object has, where the path has no ID.
  ["GET", `${DRIVE}/constructor`],
  ["GET", `${DRIVE}/files/1aBcD/__proto__`],
  ["POST", `${GMAIL}/toString`],
  // A method that does nothing the names have a word for.
  ["HEAD", `${DRIVE}/files/1aBcD`],
  // A URL that is not of a Google API, or not a URL.
  ["GET", "https://lh3.googleusercontent.com/files/1aBcD"],
  ["GET", "https://gmail.googleapis.com.example.com/gmail/v1/users/me/profile"],
  ["GET", "https://example.com/drive/v3/files"],
  ["GET", "/drive/v3/files"],
  ["GET", ""],
];

describe("googleOperation", () => {
  it.each(REQUESTS)("%s %s is %s", (method, url, name) => {
    expect(googleOperation(method, url)).toBe(name);
  });

  it.each(CHAT_REQUESTS)("names Chat's %s %s %s, as its caller did", (method, url, name) => {
    expect(googleService(url)).toBe("google-chat");
    expect(googleOperation(method, url)).toBe(name);
  });

  it.each(UNNAMED)("names %s %j by its method", (method, url) => {
    expect(googleOperation(method, url)).toBe(method);
  });

  it("reads the method in either case, a GET where none is given, and a URL of either type", () => {
    expect(googleOperation("patch", `${GMAIL}/labels/Label_1`)).toBe("labels.patch");
    expect(googleOperation(undefined, new URL(`${GMAIL}/labels`))).toBe("labels.list");
    expect(googleOperation("post", "https://oauth2.googleapis.com/token")).toBe("POST");
  });

  // An ID is passed over where the path has one, whatever it spells.
  it.each([
    ["GET", `${DRIVE}/files/root`, "files.get"],
    ["GET", `${DRIVE}/files/files/permissions/permissions`, "permissions.get"],
    ["GET", `${DRIVE}/files/about/comments/replies/replies`, "replies.list"],
    ["GET", `${CALENDAR}/calendars/primary/events`, "events.list"],
    ["GET", `${CALENDAR}/calendars/events/events/calendars`, "events.get"],
    ["GET", `${BIGQUERY}/projects/datasets/datasets/tables/tables`, "tables.list"],
    ["GET", `${BIGQUERY}/projects/jobs/datasets/tables/tables/tables`, "tables.get"],
    ["GET", `${CHAT}/spaces/spaces/messages/messages`, "messages.get"],
    ["GET", `${CHAT}/media/files/list/get?alt=media`, "media.get.media"],
    ["DELETE", `${GMAIL}/labels/labels`, "labels.delete"],
    // An ID that spells a verb is an ID still, where its collection has no such verb.
    ["GET", `${BIGQUERY}/projects/warehouse/datasets/cancel`, "datasets.get"],
    ["GET", `${BIGQUERY}/projects/warehouse/datasets/search/tables`, "tables.list"],
    ["PATCH", `${CALENDAR}/calendars/primary/events/search`, "events.patch"],
    ["GET", `${CALENDAR}/calendars/send/events/watch`, "events.get"],
    ["GET", `${DRIVE}/files/copy/comments/generateIds`, "comments.get"],
    // And where it has one, under any method but the verb's own.
    ["GET", `${CHAT}/spaces/AAAA/messages/send`, "messages.get"],
    ["GET", `${GMAIL}/messages/batchModify?format=full`, "messages.get"],
    ["DELETE", `${GMAIL}/drafts/send`, "drafts.delete"],
    ["PATCH", `${DRIVE}/files/generateIds`, "files.patch"],
    ["POST", `${DRIVE}/files/generateIds/copy`, "files.copy"],
    // Or under its method anywhere but at the verb's own endpoint.
    ["POST", `${CHAT}/spaces/AAAA/messages/send/reactions`, "reactions.create"],
    ["POST", `${CHAT}/spaces/AAAA/messages/send`, "messages.create"],
    ["POST", `${CHAT}/spaces/AAAA/messages/batchModify/reactions`, "reactions.create"],
    ["GET", `${DRIVE}/files/1aBcD/comments/generateIds/replies`, "replies.list"],
    ["POST", `${GMAIL}/messages/send/attachments`, "attachments.create"],
    // An ID that spells a property every object has, or the tree's own word for an ID.
    ["GET", `${DRIVE}/files/constructor`, "files.get"],
    ["GET", `${DRIVE}/files/__proto__/permissions`, "permissions.list"],
    ["DELETE", `${GMAIL}/labels/toString`, "labels.delete"],
    ["GET", `${DRIVE}/files/{id}`, "files.get"],
    ["GET", `${CHAT}/media/{id+}`, "media.get"],
  ])("%s %s is %s, with no ID in it", (method, url, name) => {
    expect(googleOperation(method, url)).toBe(name);
  });

  // So that the tree and the rows above cannot drift apart.
  it.each(ENDS)("has a row above for $path", ({ url, method }) => {
    let rows = [...REQUESTS, ...CHAT_REQUESTS].filter(([rowMethod, rowUrl]) =>
      (method ?? rowMethod) === rowMethod && url.test(rowUrl.split("?")[0]));
    expect(rows).not.toEqual([]);
  });

  it("makes a name of the tree's words alone, which the metrics write as given", () => {
    let names = [...REQUESTS, ...CHAT_REQUESTS].map(([, , name]) => name);
    // Each ID a path can hold, where a word is looked for and where an ID is.
    let ids = ["secret-id", "ada%40example.com", "users%2F123", "a.b", "a:b", "1aBcD:batchUpdate", "-"];
    for (let method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      for (let id of ids) {
        for (let url of [
          `${DRIVE}/files/${id}`, `${DRIVE}/${id}/files`, `${DRIVE}/files/${id}/${id}`,
          `${DRIVE}/files/${id}/comments/${id}/replies/${id}`, `${CHAT}/spaces/${id}/messages/${id}`,
          `${CHAT}/media/${id}/${id}`, `${CHAT}/${id}`,
        ]) {
          names.push(googleOperation(method, `${url}?alt=${id}&q=${id}`));
        }
      }
    }
    for (let name of new Set(names)) {
      if (["GET", "POST", "PATCH", "PUT", "DELETE"].includes(name)) continue;
      expect(name.split(".").filter(word => !WORDS.has(word)), name).toEqual([]);
      expect(encodeSubserviceCallPoint({ ...CALL, operation: name }).blobs![9]).toBe(name);
    }
  });
});

describe("recordCall", () => {
  let ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];
  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    ambient.SUBSERVICE_METRICS = "true";
  });
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  // The `calls` column of each point written, beside its operation.
  function written(): [unknown, unknown][] {
    return points.map(point => [point.blobs![9], point.doubles![4]]);
  }

  it("writes a call at once outside `summedInto`", () => {
    recordCall(CALL);
    expect(written()).toEqual([["GET", 1]]);
  });

  it("sums the calls made in `summedInto`, across an await and in a nested call", async () => {
    let tally = subserviceTally();
    let answer = await summedInto(tally, async () => {
      recordCall(CALL);
      await later("GET");
      await Promise.all([later("GET"), later("POST")]);
      return "answer";
    });
    expect(answer).toBe("answer");
    expect(written()).toEqual([]);

    tally.flush();
    expect(written()).toEqual([["GET", 3], ["POST", 1]]);
  });

  it("keeps apart the calls of two tallies at once, and of work under neither", async () => {
    let first = subserviceTally();
    let second = subserviceTally();
    await Promise.all([
      summedInto(first, () => later("GET")),
      summedInto(second, async () => { await later("POST"); await later("POST"); }),
      later("DELETE"),
    ]);
    expect(written()).toEqual([["DELETE", 1]]);

    first.flush();
    second.flush();
    expect(written()).toEqual([["DELETE", 1], ["GET", 1], ["POST", 2]]);
  });
});
