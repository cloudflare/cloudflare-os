import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { encodeSubserviceCallPoint } from "@gadgets/observability/metrics";
import { describe, expect, it } from "vitest";
import { googleService, ROUTES } from "../src/call-metrics";
import { googleUpstream, NAMED_OPERATIONS } from "../src/upstream";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

// The service `url` is counted under, as the upstream is given it: parsed, or not at all.
function serviceOf(url: string): string {
  return googleService(URL.parse(url) ?? undefined);
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
    expect(serviceOf(base)).toBe(service);
    expect(serviceOf(`${base}/1aBcD:batchUpdate?fields=id&q=name`)).toBe(service);
  });

  it("names Drive's upload endpoint, one segment down like its batch endpoint", () => {
    expect(serviceOf("https://www.googleapis.com/upload/drive/v3/files?uploadType=media"))
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
    expect(serviceOf(url)).toBe("google-other");
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

// The service each API's requests are counted under, by the base the rows above are built on.
const SERVICES: [base: string, service: string][] = [
  [GMAIL, "google-gmail"], [DRIVE, "google-drive"], [DRIVE_UPLOAD, "google-drive"],
  [CALENDAR, "google-calendar"], [BIGQUERY, "google-bigquery"], [DOCS, "google-docs"],
  [SHEETS, "google-sheets"], [SLIDES, "google-slides"], [CHAT, "google-chat"],
  [PEOPLE, "google-people"], [EVENTS, "google-events"],
  ["https://www.googleapis.com/oauth2/v3", "google-oauth"], ["https://oauth2.googleapis.com", "google-oauth"],
];

describe("the name of a request", () => {
  it.each(REQUESTS)("%s %s is %s", (method, url, name) => {
    expect(googleUpstream.operationOf(method, url)).toBe(name);
    let service = SERVICES.find(([base]) => url.startsWith(base))?.[1];
    expect(service).toBeDefined();
    expect(serviceOf(url)).toBe(service);
  });

  it.each(CHAT_REQUESTS)("names Chat's %s %s %s, as its caller did", (method, url, name) => {
    expect(serviceOf(url)).toBe("google-chat");
    expect(googleUpstream.operationOf(method, url)).toBe(name);
  });

  it.each(UNNAMED)("names %s %j by its method", (method, url) => {
    expect(googleUpstream.operationOf(method, url)).toBe(method);
  });

  // So that the tree and the rows above cannot drift apart.
  it("has a row above for the end of every path of the tree", () => {
    expect(unreachedRouteEnds(ROUTES, [...REQUESTS, ...CHAT_REQUESTS])).toEqual([]);
  });

  it("adds a suffix for `alt=media` and for `uploadType=resumable`, and for no other value", () => {
    let file = `${DRIVE}/files/1aBcD`;
    expect(googleUpstream.operationOf("GET", `${file}?alt=media`)).toBe("files.get.media");
    expect(googleUpstream.operationOf("GET", `${file}?alt=json&q=media`)).toBe("files.get");
    expect(googleUpstream.operationOf("GET", `${file}?alt=1aBcD`)).toBe("files.get");
    expect(googleUpstream.operationOf("PATCH", `${DRIVE_UPLOAD}/files/1aBcD?uploadType=resumable`))
        .toBe("files.patch.resumable");
    expect(googleUpstream.operationOf("PATCH", `${DRIVE_UPLOAD}/files/1aBcD?uploadType=media`))
        .toBe("files.patch");
    // A URL the tree does not name gets no suffix either.
    expect(googleUpstream.operationOf("GET", `${DRIVE}/files/1aBcD/revisions/7?alt=media`)).toBe("GET");
  });

  it("gives names that the metrics write as given", () => {
    let names = [...REQUESTS, ...CHAT_REQUESTS].map(([, , name]) => name);
    for (let name of new Set([...names, ...NAMED_OPERATIONS])) {
      let point = encodeSubserviceCallPoint({
        source: googleUpstream.source, service: "google-drive", operation: name, outcome: "success",
      });
      expect(point.blobs?.[9]).toBe(name);
    }
  });
});

describe("the names given where a request is made", () => {
  // Every `.ts` file of the clients, but the one that lists the names.
  let sources = readdirSync(SOURCE_DIR)
      .filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts") && file !== "upstream.ts")
      .map(file => readFileSync(join(SOURCE_DIR, file), "utf8"));

  it.each(NAMED_OPERATIONS)("%s is given by a request", name => {
    expect(sources.some(source => source.includes(`"${name}"`))).toBe(true);
  });

  it.each(NAMED_OPERATIONS)("%s is no name the tree gives a URL", name => {
    let rows = [...REQUESTS, ...CHAT_REQUESTS].filter(([, , row]) => row === name);
    expect(rows).toEqual([]);
  });
});
