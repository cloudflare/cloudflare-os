// A request whose answer has a success status and holds what could be read, and which the
// helper that sent it rejects all the same: the answer lacks what the request was sent for, is
// for something else than was asked, or carries Google's own failure. Its attempt is counted an
// error with the reason `api` and the answer's status, the request is sent once, and the helper
// throws what it throws.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readCheckedWithAuthRetry, type AccessTokenRequest } from "../src/auth-retry";
import { BigQueryApi } from "../src/bigquery-api";
import { GoogleCalendarApi } from "../src/calendar-api";
import { ChatApi } from "../src/chat-api";
import { DocsCommentNotSavedError, GoogleDocsApi } from "../src/docs-api";
import { DriveApi, DriveApiRequestError } from "../src/drive-api";
import { GmailApi } from "../src/google-api";
import { GoogleSheetsApi } from "../src/sheets-api";
import { GoogleSlidesApi } from "../src/slides-api";
import { unbindWrittenCalls, writtenCalls } from "./written-calls";

const token = async () => "token";
const DOC = "application/vnd.google-apps.document";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RANGE = { startIndex: 1, endIndex: 2, tabId: "t.0" };
const SNAPSHOT = {
  key: "0.1", messageId: "m1", attachmentId: "a1",
  info: { filename: null, mimeType: "text/plain", size: 3, disposition: null, readable: true },
};
const MESSAGE = "spaces/s1/messages/m1";
const WINDOW = { timeMin: new Date(0), timeMax: new Date(60_000) };

const bigquery = () => new BigQueryApi(token);
const calendar = () => new GoogleCalendarApi(token);
const chat = () => new ChatApi(token);
const docs = () => new GoogleDocsApi(token);
const drive = () => new DriveApi(token);
const gmail = () => new GmailApi("ada@example.com", token);
const sheets = () => new GoogleSheetsApi(token);
const slides = () => new GoogleSlidesApi(token);

// Stubs a fetch that answers each request with what `answer` makes of it, and records each.
function answering(answer: (url: URL, init: RequestInit) => Response) {
  let fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => answer(new URL(url), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// The requests a stubbed fetch was sent, as their method and path.
const sent = (fetch: ReturnType<typeof answering>) => fetch.mock.calls
  .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(url).pathname}`);

// A file's content, in one chunk.
const fileOf = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  },
});

// A `multipart/mixed` answer to a batch of `files.get`, one part for each of `parts` in order.
function batchOf(...parts: { status: number; body: unknown }[]): Response {
  let text = parts.map(({ status, body }, index) => [
    "--batch", "Content-Type: application/http", `Content-ID: <response-item-${index}>`, "",
    `HTTP/1.1 ${status} Answer`, "Content-Type: application/json", "", JSON.stringify(body), "",
  ].join("\r\n")).join("");
  return new Response(`${text}--batch--\r\n`, { headers: { "Content-Type": "multipart/mixed; boundary=batch" } });
}

const partRefusal = (status: number, reason: string) => ({ status, body: { error: { errors: [{ reason }] } } });

afterEach(() => {
  unbindWrittenCalls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Each rejection: what is answered, the name its request is counted under, how it is sent, the
// JSON of the 200 it is answered, and what the helper throws.
type Rejection = [what: string, operation: string, send: () => Promise<unknown>, body: unknown, thrown: string];

const DRIVE_READS: Rejection[] = [
  ["a list of files that is no object", "files.list", () => drive().listFiles(), [],
    "Invalid Google Drive file-list response"],
  ["a list of files Drive could not complete", "files.list", () => drive().listFiles(), { incompleteSearch: true },
    "Google Drive could not complete this search. Try again."],
  ["a list of files that holds no list", "files.list", () => drive().listFiles(), { files: {} },
    "Invalid Google Drive file-list response"],
  ["a list of files one of which has no name", "files.list", () => drive().listFiles(), { files: [{ id: "file1" }] },
    "Invalid Google Drive file response"],
  ["a file with no ID", "files.get", () => drive().getFile("file1"), { name: "Plan" },
    "Invalid Google Drive file response"],
  ["no generated ID", "files.generateIds", () => drive().generateFileId(), { ids: [] },
    "Invalid Google Drive generated ID response"],
  ["a list of shared drives that holds no list", "drives.list", () => drive().listSharedDrives(), { drives: {} },
    "Invalid Google Drive shared-drive list response"],
  ["a shared drive with no name", "drives.list", () => drive().listSharedDrives(), { drives: [{ id: "drive1" }] },
    "Invalid Google Drive shared drive"],
  ["capabilities that are no object, asked whether a file can be edited", "files.get",
    () => drive().canEdit("file1"), { capabilities: 1 }, "Invalid Google Drive file capabilities"],
  ["a conversion source with no name", "files.get", () => drive().getConversionSource("file1"), { id: "file1" },
    "Invalid Google Drive file response"],
  ["a converted copy with no name", "files.get", () => drive().getConvertedCopy("file1"), { id: "file1" },
    "Invalid Google Drive file response"],
  ["a list of converted copies that holds no list", "files.list",
    () => drive().findConvertedCopies("file1", DOC), { files: {} }, "Invalid Google Drive file-list response"],
  ["capabilities that are no object, asked whether a folder takes files", "files.get",
    () => drive().canAddChildren("folder1"), { capabilities: 1 }, "Invalid Google Drive file capabilities"],
  ["an import size that is no string", "about.get", () => drive().getMaxImportSize(DOC),
    { maxImportSizes: { [DOC]: 10 } }, "Invalid Google Drive maxImportSizes"],
  ["a file that is no object, asked for a capability", "files.get", () => drive().canComment("file1"), [],
    "Invalid Google Drive file response"],
  ["an account with no permission ID", "about.get", () => drive().getAccountIdentity(), { user: {} },
    "Invalid Google Drive account identity response"],
  ["a list of permissions that holds no list", "permissions.list", () => drive().listPermissions("file1"),
    { permissions: {} }, "Invalid Google Drive permissions list response"],
  ["a list of comments one of which has no ID", "comments.list", () => drive().listComments("file1"),
    { comments: [{}] }, "Invalid Google Drive comment response"],
  ["another comment than was asked for", "comments.get", () => drive().getComment("file1", "comment1"),
    { id: "comment2", createdTime: "2026-01-01T00:00:00Z", author: {} }, "Google Drive returned a different comment"],
  ["a list of replies that holds no list", "replies.list", () => drive().listReplies("file1", "comment1"),
    { replies: {} }, "Invalid Google Drive replies list response"],
];

const DRIVE_WRITES: Rejection[] = [
  ["a created permission with no ID", "permissions.create",
    () => drive().createPermission("file1", { type: "anyone", role: "reader" }, { notify: false }),
    { type: "anyone", role: "reader" }, "Invalid Google Drive permission response"],
  ["an updated permission that belongs to a view", "permissions.patch",
    () => drive().updatePermission("file1", "permission1", "reader"),
    { id: "permission1", type: "anyone", role: "reader", view: "published" }, "Invalid Google Drive permission response"],
  ["a move of another file", "files.patch",
    () => drive().swapParent("file1", { addParent: "folder2", removeParent: "folder1" }),
    { id: "file2", parents: ["folder2"] }, "Google Drive answered a move for a different file"],
  ["a move that names no parents", "files.patch",
    () => drive().swapParent("file1", { addParent: "folder2", removeParent: "folder1" }),
    { id: "file1" }, "Google Drive answered a move without the file's parents"],
  ["a created comment with no ID", "comments.create", () => drive().createComment("file1", "Looks good"),
    { content: "Looks good" }, "Invalid Google Drive comment response"],
  ["a created reply with no ID", "replies.create",
    () => drive().createReply("file1", "comment1", { content: "Agreed" }),
    { content: "Agreed" }, "Invalid Google Drive reply response"],
];

const DOCS: Rejection[] = [
  ["a created document with no ID", "documents.create", () => docs().createDocument("Plan"), {},
    "Google Docs returned no document ID"],
  ["another document than was asked for", "documents.get", () => docs().getDocument("doc1"),
    { documentId: "doc2", tabs: [] }, "Google Docs returned a different document"],
  ["a document whose tabs are no list", "documents.get", () => docs().getDocument("doc1"),
    { documentId: "doc1", tabs: {} }, "Google Docs returned"],
  ["the metadata of another document", "documents.get", () => docs().getDocumentMetadata("doc1"),
    { documentId: "doc2" }, "Google Docs returned a different document"],
  ["another document than was asked for, with its suggestions", "documents.get",
    () => docs().getDocumentWithSuggestions("doc1"), { documentId: "doc2" },
    "Google Docs returned a different document"],
  ["suggestions that are no list", "documents.get",
    () => docs().getDocumentWithSuggestions("doc1"), { documentId: "doc1", suggestions: {} }, "Google Docs returned"],
  ["a comment Google did not save", "documents.batchUpdate",
    () => docs().insertComment("doc1", "Looks good", RANGE), { commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" },
    "Google Docs did not save the comment."],
  ["an inserted comment with no ID", "documents.batchUpdate",
    () => docs().insertComment("doc1", "Looks good", RANGE), { replies: [{}] },
    "Google Docs returned no comment ID"],
  ["a suggestion that names no suggestion made", "documents.batchUpdate",
    () => docs().suggest("doc1", [{}]), { suggestionResponses: [] },
    "Google Docs did not return the one suggestion it made"],
  ["a reply to a suggestion that Google did not save", "documents.batchUpdate",
    () => docs().replyToSuggestion("doc1", "suggestion1", "Agreed"), { commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" },
    "Google Docs did not save the comment."],
  ["the comment threads of another document", "documents.get", () => docs().getCommentThreads("doc1"),
    { documentId: "doc2" }, "Google Docs returned a different document"],
  ["comment threads that are no list", "documents.get", () => docs().getCommentThreads("doc1"),
    { documentId: "doc1", comments: {} }, "Google Docs returned"],
  ["a reply to a comment with no ID", "documents.batchUpdate",
    () => docs().replyToComment("doc1", "comment1", "Agreed"), { replies: [{}] },
    "Google Docs returned no reply ID"],
];

const SHEETS: Rejection[] = [
  ["a created spreadsheet with no ID", "spreadsheets.create", () => sheets().createSpreadsheet("Plan"), {},
    "Google Sheets returned no spreadsheet ID"],
  ["a range with a cell that is no value", "values.batchGet", () => sheets().readRanges("sheet1", ["Sheet1!A1"]),
    { valueRanges: [{ values: [[{}]] }] }, "Google Sheets returned an unsupported cell value."],
  ["formats of no sheet", "spreadsheets.get", () => sheets().readFormats("sheet1", "Sheet1!A1"), { sheets: [] },
    "Google Sheets did not return the range it was asked for."],
];

const SLIDES: Rejection[] = [
  ["a created presentation with no ID", "presentations.create", () => slides().createPresentation("Plan"), {},
    "Google Slides returned no presentation ID"],
  ["another presentation than was asked for", "presentations.get", () => slides().getPresentation("deck1"),
    { presentationId: "deck2" }, "Google Slides returned a different presentation"],
  ["the title of another presentation", "presentations.get", () => slides().getPresentationTitle("deck1"),
    { presentationId: "deck2" }, "Google Slides returned a different presentation"],
  ["the outline of another presentation", "presentations.get", () => slides().getOutline("deck1"),
    { presentationId: "deck2" }, "Google Slides returned a different presentation"],
  ["another slide than was asked for", "pages.get", () => slides().getSlide("deck1", "slide1"),
    { objectId: "slide2" }, "Google Slides returned a different slide"],
  ["another layout than was asked for", "pages.get", () => slides().getLayout("deck1", "layout1"),
    { objectId: "layout2" }, "Google Slides returned a different layout"],
  ["a thumbnail on another host than Google's", "thumbnail.get", () => slides().getThumbnail("deck1", "page1", "SMALL"),
    { contentUrl: "https://images.example/thumbnail" }, "Google Slides returned an unexpected thumbnail location"],
  ["no thumbnail location", "thumbnail.get", () => slides().getThumbnail("deck1", "page1", "SMALL"), {},
    "Google Slides returned an unexpected thumbnail location"],
];

const CHAT: Rejection[] = [
  ["a list of spaces one of which has no name", "spaces.list", () => chat().listSpaces(), { spaces: [{}] },
    "Google Chat returned a space with no resource name."],
  ["a search of spaces one of which has no name", "spaces.search", () => chat().searchSpaces("Plans"),
    { results: [{ space: {} }] }, "Google Chat returned a space with no resource name."],
  ["a space with no name", "spaces.get", () => chat().getSpace("spaces/s1"), {},
    "Google Chat returned a space with no resource name."],
  ["a direct message with no name", "spaces.findDirectMessage", () => chat().findDirectMessage("users/1"), {},
    "Google Chat returned a space with no resource name."],
  ["a conversation set up with no name", "spaces.setup", () => chat().setupConversation(["users/1"], "request1"), {},
    "Google Chat returned a space with no resource name."],
  ["a conversation set up under a name that is no space's", "spaces.setup",
    () => chat().setupConversation(["users/1"], "request1"), { name: "rooms/r1" },
    "Expected a space resource name of the form spaces/{space}."],
  ["a list of messages one of which has no name", "messages.list", () => chat().listMessages("spaces/s1"),
    { messages: [{}] }, "Google Chat returned a message with no resource name."],
  ["a search of messages one of which has no name", "messages.search",
    () => chat().searchMessages({ filter: "space.name = \"spaces/s1\"" }), { results: [{ message: {} }] },
    "Google Chat returned a message with no resource name."],
  ["a message with no name", "messages.get", () => chat().getMessage(MESSAGE), {},
    "Google Chat returned a message with no resource name."],
  ["a created message with no name", "messages.create", () => chat().createMessage("spaces/s1", { text: "Hello" }), {},
    "Google Chat returned a message with no resource name."],
  ["a list of members one of which has no name", "members.list", () => chat().listMembers("spaces/s1"),
    { memberships: [{}] }, "Google Chat returned a membership with no resource name."],
  ["a membership with no name", "members.get", () => chat().getMembership("spaces/s1", "users/1"), {},
    "Google Chat returned a membership with no resource name."],
  ["a list of reactions one of which has no name", "reactions.list", () => chat().listReactions(MESSAGE),
    { reactions: [{}] }, "Google Chat returned a reaction with no resource name."],
  ["a created reaction with no name", "reactions.create", () => chat().createReaction(MESSAGE, "👍"), {},
    "Google Chat returned a reaction with no resource name."],
];

const OTHERS: Rejection[] = [
  ["a Gmail attachment with no data", "attachments.get", () => gmail().getAttachmentContent(SNAPSHOT), {},
    "Attachment content is no longer available."],
  ["a Gmail attachment whose data is no base64", "attachments.get", () => gmail().getAttachmentContent(SNAPSHOT),
    { data: "!" }, "Invalid base64url data."],
  ["a free/busy answer in which Google reports an error of a calendar", "freeBusy",
    () => calendar().hasFreeBusyAccess(["ada@example.com"]),
    { calendars: { "ada@example.com": { errors: [{ domain: "global", reason: "internalError" }] } } },
    "Google Calendar free/busy access check failed for ada@example.com: internalError"],
];

// What a method throws where it takes apart, or reads a member of, an answer that is no object.
const apart = (member: string) => `Cannot destructure property '${member}' of '(intermediate value)' as it is null.`;
const reading = (member: string, of: "null" | "undefined" = "null") => `Cannot read properties of ${of} (reading '${member}')`;

describe("a 200 that the helper rejects for what it holds", () => {
  it.each([...DRIVE_READS, ...DRIVE_WRITES, ...DOCS, ...SHEETS, ...SLIDES, ...CHAT, ...OTHERS])(
    "is an error of the request, sent once: %s", async (_what, operation, send, body, thrown) => {
      let written = writtenCalls();
      let fetch = answering(() => Response.json(body));

      await expect(send()).rejects.toThrow(thrown);

      expect(written.answers(/./)).toEqual([[operation, "error", "api", 200]]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

  it("throws the helper's own error class", async () => {
    answering(() => Response.json({ commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" }));

    await expect(docs().insertComment("doc1", "Looks good", RANGE)).rejects.toBeInstanceOf(DocsCommentNotSavedError);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    ["a document", "documents.get", () => docs().getDocument("doc1")],
    ["a Docs write", "documents.batchUpdate", () => docs().batchUpdate("doc1", [{}])],
    ["a calendar", "calendarList.get", () => calendar().getCalendar("primary")],
    ["a calendar's event", "events.get", () => calendar().getEvent("primary", "event1")],
    ["a spreadsheet's metadata", "spreadsheets.get", () => sheets().getMetadata("sheet1")],
    ["an edit of a Chat message", "messages.patch", () => chat().updateMessageText(MESSAGE, "Hello")],
    ["a search of the directory", "people.searchDirectoryPeople", () => chat().searchDirectory("ada")],
  ])("is an error where what is answered for %s is JSON the helper cannot read as one", async (_what, operation, send) => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(null));

    await expect(send()).rejects.toBeInstanceOf(TypeError);

    expect(written.answers(/./)).toEqual([[operation, "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, () => Promise<unknown>, unknown, string]>([
    ["a created document answered null", "documents.create", () => docs().createDocument("Plan"), null, apart("documentId")],
    ["a document answered null", "documents.get", () => docs().getDocument("doc1"), null, apart("documentId")],
    ["a created spreadsheet answered null", "spreadsheets.create", () => sheets().createSpreadsheet("Plan"), null,
      apart("spreadsheetId")],
    ["a created presentation answered null", "presentations.create", () => slides().createPresentation("Plan"), null,
      apart("presentationId")],
    ["a thumbnail answered null", "thumbnail.get", () => slides().getThumbnail("deck1", "page1", "SMALL"), null,
      apart("contentUrl")],
    ["a page of group chats answered null", "spaces.findGroupChats", () => chat().findGroupChat(["users/1"]), null,
      reading("spaces")],
    ["a list of BigQuery projects answered null", "projects.list", () => bigquery().listProjects(), null,
      reading("projects")],
    ["a BigQuery project that is null", "projects.list", () => bigquery().listProjects(), { projects: [null] },
      reading("projectReference")],
    ["a list of datasets answered null", "datasets.list", () => bigquery().listDatasets("project"), null,
      reading("datasets")],
    ["a listed dataset that names none", "datasets.list", () => bigquery().listDatasets("project"), { datasets: [{}] },
      reading("datasetId", "undefined")],
    ["a dataset that names none", "datasets.get", () => bigquery().getDataset("project", "dataset"), {},
      reading("datasetId", "undefined")],
    ["a list of tables answered null", "tables.list", () => bigquery().listTables("project", "dataset"), null,
      reading("tables")],
    ["a listed table that names none", "tables.list", () => bigquery().listTables("project", "dataset"), { tables: [{}] },
      reading("tableId", "undefined")],
    ["a table that names none", "tables.get", () => bigquery().getTable("project", "dataset", "table"), {},
      reading("tableId", "undefined")],
    ["a query's submission that names neither a result nor a job to poll", "queries.create",
      () => bigquery().query("project", "SELECT 1"), {}, reading("projectId", "undefined")],
    ["a complete query that names no job", "queries.create", () => bigquery().query("project", "SELECT 1"),
      { jobComplete: true }, reading("jobId", "undefined")],
    ["a complete query one of whose rows is null", "queries.create", () => bigquery().query("project", "SELECT 1"),
      { jobReference: { projectId: "project", jobId: "job-1" }, jobComplete: true, schema: { fields: [{ name: "n", type: "STRING" }] }, rows: [null] },
      reading("f")],
    ["a dry run one of whose referenced tables is null", "jobs.create", () => bigquery().dryRun("project", "SELECT 1"),
      { statistics: { query: { referencedTables: [null] } } }, reading("projectId")],
    ["a list of events one of which is null", "events.list", () => calendar().listEvents("primary", WINDOW),
      { items: [null] }, reading("id")],
    ["a list of calendars that holds no list", "calendarList.list", () => calendar().listCalendars(),
      { items: 5 }, "Spread syntax requires ...iterable[Symbol.iterator] to be a function"],
  ])("is an error where the method cannot take its answer apart, and throws as it reads it: %s", async (_what, operation, send, body, thrown) => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(body));

    let error = await send().then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toHaveProperty("message", thrown);
    expect(written.answers(/./)).toEqual([[operation, "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is an error of a poll of a query that names neither a result nor a job, after a submission that succeeded", async () => {
    let written = writtenCalls();
    let answers = [Response.json({ jobReference: { projectId: "project", jobId: "job-1" }, jobComplete: false })];
    let fetch = answering(() => answers.shift() ?? Response.json({}));

    let error = await bigquery().query("project", "SELECT 1").then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toHaveProperty("message", reading("projectId", "undefined"));
    expect(written.answers(/./)).toEqual([["queries.create", "success", "", 200], ["queries.get", "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is an error of a page of group chats answered a 204, which holds no page", async () => {
    let written = writtenCalls();
    let fetch = answering(() => new Response(null, { status: 204 }));

    let error = await chat().findGroupChat(["users/1"]).then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toHaveProperty("message", reading("spaces", "undefined"));
    expect(written.answers(/./)).toEqual([["spaces.findGroupChats", "error", "api", 204]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is an error of a write answered a 204, which holds nothing of what it made", async () => {
    let written = writtenCalls();
    let fetch = answering(() => new Response(null, { status: 204 }));

    await expect(drive().createComment("file1", "Looks good")).rejects.toThrow("Invalid Google Drive comment response");

    expect(written.answers(/./)).toEqual([["comments.create", "error", "api", 204]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("an answer the helper takes", () => {
  it("is a success where it holds what the request was sent for", async () => {
    let written = writtenCalls();
    answering(url => Response.json(url.pathname.endsWith("/about")
      ? { user: { permissionId: "p1" } }
      : url.hostname === "docs.googleapis.com" ? { documentId: "doc1" } : { name: "spaces/s1" }));

    await expect(drive().getAccountIdentity()).resolves.toEqual({ permissionId: "p1" });
    await expect(docs().createDocument("Plan")).resolves.toBe("doc1");
    await expect(chat().getSpace("spaces/s1")).resolves.toMatchObject({ id: "spaces/s1" });

    expect(written.answers(/./)).toEqual([
      ["about.get", "success", "", 200], ["documents.create", "success", "", 200], ["spaces.get", "success", "", 200],
    ]);
  });

  it.each<[string, unknown, string]>([
    ["shown only to someone", { name: MESSAGE, privateMessageViewer: { name: "users/1" } },
      "This Google Chat message is not available through this connection."],
    ["deleted", { name: MESSAGE, deleteTime: "2026-01-01T00:00:00Z" }, "This Google Chat message has been deleted."],
  ])("is a success of a Chat message that is %s, which the gatekeeper does not show", async (_what, message, said) => {
    let written = writtenCalls();
    answering(() => Response.json(message));

    await expect(chat().getMessage(MESSAGE)).rejects.toThrow(said);
    await expect(chat().getRawMessage(MESSAGE)).rejects.toThrow(said);

    expect(written.answers(/./)).toEqual([["messages.get", "success", "", 200], ["messages.get", "success", "", 200]]);
  });

  it("is a success of a free/busy answer whose errors are given to the caller, and of a calendar that is not found", async () => {
    let written = writtenCalls();
    answering(() => Response.json({
      calendars: { "ada@example.com": { errors: [{ reason: "internalError" }] }, "bob@example.com": { errors: [{ reason: "notFound" }] } },
    }));
    let window = { timeMin: new Date(0), timeMax: new Date(60_000) };

    await expect(calendar().freeBusy({ people: ["ada@example.com"], ...window }))
      .resolves.toEqual([{ email: "ada@example.com", busy: [], error: "internalError" }]);
    await expect(calendar().hasFreeBusyAccess(["bob@example.com"])).resolves.toEqual([false]);

    expect(written.answers(/./)).toEqual([["freeBusy", "success", "", 200], ["freeBusy", "success", "", 200]]);
  });

  it("is a success of a page of more events than a listing holds, which the client refuses unread", async () => {
    let written = writtenCalls();
    // No event of the page is one that could be read.
    let fetch = answering(() => Response.json({ items: Array.from({ length: 2501 }, () => null) }));

    await expect(calendar().listEvents("primary", WINDOW)).rejects.toThrow("Too many events in the requested window.");

    expect(written.answers(/./)).toEqual([["events.list", "success", "", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is a success of a page of group chats, and of BigQuery's lists and reads", async () => {
    let written = writtenCalls();
    let reference = { projectId: "project", datasetId: "dataset", tableId: "table" };
    answering(url => Response.json(url.pathname.endsWith("findGroupChats") ? { spaces: [] }
      : url.pathname.endsWith("/tables/table") ? { tableReference: reference }
        : url.pathname.endsWith("/tables") ? { tables: [{ tableReference: reference }] }
          : url.pathname.endsWith("/datasets/dataset") ? { datasetReference: reference }
            : url.pathname.endsWith("/datasets") ? { datasets: [{ datasetReference: reference }] }
              : { projects: [{ id: "project" }] }));

    await expect(chat().findGroupChat(["users/1"])).resolves.toBeNull();
    await expect(bigquery().listProjects()).resolves.toEqual([{ projectId: "project" }]);
    await expect(bigquery().listDatasets("project")).resolves.toEqual([{ projectId: "project", datasetId: "dataset" }]);
    await expect(bigquery().getDataset("project", "dataset")).resolves.toEqual({ projectId: "project", datasetId: "dataset" });
    await expect(bigquery().listTables("project", "dataset")).resolves.toEqual([{ ...reference, type: "TABLE" }]);
    await expect(bigquery().getTable("project", "dataset", "table"))
      .resolves.toEqual({ table: { ...reference, type: "TABLE" }, schema: [] });

    expect(written.answers(/./)).toEqual([
      "spaces.findGroupChats", "projects.list", "datasets.list", "datasets.get", "tables.list", "tables.get",
    ].map(operation => [operation, "success", "", 200]));
  });

  it("is counted by its status where that is no success, though its body is read and the check throws on it", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ documentId: "doc2" }, { status: 404 }));
    let refusal = new Error("another document");

    await expect(readCheckedWithAuthRetry(
      "https://docs.googleapis.com/v1/documents/doc1", {}, { getAccessToken: token },
      response => response.json<{ documentId?: string }>(),
      ({ documentId }) => {
        if (documentId !== "doc1") throw refusal;
        return documentId;
      })).rejects.toBe(refusal);

    expect(written.answers(/./)).toEqual([["documents.get", "error", "http", 404]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("awaits a check that answers later, and counts what it rejects with as what it threw", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ documentId: "doc2" }));
    let refusal = new Error("another document");
    let read = (wanted: string) => readCheckedWithAuthRetry(
      "https://docs.googleapis.com/v1/documents/doc1", {}, { getAccessToken: token },
      response => response.json<{ documentId?: string }>(),
      async answer => {
        let { documentId } = await answer;
        if (documentId !== wanted) throw refusal;
        return documentId;
      });

    await expect(read("doc2")).resolves.toBe("doc2");
    await expect(read("doc1")).rejects.toBe(refusal);

    expect(written.answers(/./)).toEqual([["documents.get", "success", "", 200], ["documents.get", "error", "api", 200]]);
  });

  it("is counted by its status where that is no success, whatever the helper makes of it", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 }));

    await expect(drive().getFile("file1")).rejects.toMatchObject({ status: 404 });
    await expect(docs().createDocument("Plan")).rejects.toThrow("[http=404]");

    expect(written.answers(/./)).toEqual([["files.get", "error", "http", 404], ["documents.create", "error", "http", 404]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// Uploads a small Word file for Drive to convert, as a new file or as a file's new content.
const upload = (target: string | { name: string; parents: string[] }) =>
  drive().uploadConverted(fileOf("PKdocx"), DOCX, DOC, target);

describe("the opening of an upload session", () => {
  const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";

  it.each<[string, string, string | { name: string; parents: string[] }, HeadersInit]>([
    ["names no session, for a new file", "files.create.resumable", { name: "Plan", parents: ["folder1"] }, {}],
    ["names no session, for a file's new content", "files.patch.resumable", "file1", {}],
    ["names a session on another host", "files.create.resumable", { name: "Plan", parents: ["folder1"] },
      { Location: "https://uploads.example/upload/drive/v3/files?upload_id=session-1" }],
    ["names a session outside Drive's upload path", "files.create.resumable", { name: "Plan", parents: ["folder1"] },
      { Location: "https://www.googleapis.com/upload/drive/v3beta/files?upload_id=session-1" }],
  ])("is an error where its 200 %s, sent once, with nothing sent to a session", async (_what, operation, target, headers) => {
    let written = writtenCalls();
    let fetch = answering(() => new Response(null, { headers }));

    let error = await upload(target).then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "Google Drive did not open an upload session");
    expect(written.answers(/./)).toEqual([[operation, "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Nothing of the location Drive gave is in the error or in a point.
    expect(JSON.stringify([String(error), written()])).not.toMatch(/upload_id|session-1|uploads\.example/);
  });

  it("is a success where its 200 names a session of Drive's, which the file is then sent to", async () => {
    let written = writtenCalls();
    let fetch = answering((url, { method }) => method === "PUT"
      ? Response.json({ id: "new-1", mimeType: DOC }) : new Response(null, { headers: { Location: SESSION } }));

    await expect(upload({ name: "Plan", parents: ["folder1"] })).resolves.toBe("new-1");

    expect(written.answers(/./)).toEqual([
      ["files.create.resumable", "success", "", 200], ["upload.send", "success", "", 200],
    ]);
    expect(sent(fetch)).toEqual(["POST /upload/drive/v3/files", "PUT /upload/drive/v3/files"]);
  });

  it("is counted by its status where Drive refuses it, and thrown as Drive's refusal", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ error: { errors: [{ reason: "storageQuotaExceeded" }] } }, { status: 403 }));

    await expect(upload({ name: "Plan", parents: ["folder1"] })).rejects.toMatchObject({ status: 403, reason: "storageQuotaExceeded" });

    expect(written.answers(/./)).toEqual([["files.create.resumable", "error", "http", 403]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string]>([
    ["less than the chunks before this one", "bytes=0-1"],
    ["more than it was sent", "bytes=0-99"],
  ])("counts a chunk's 308 that says the session holds %s as an error, and gives the upload up", async (_what, held) => {
    let written = writtenCalls();
    // The first chunk is answered as taken whole, and the second with a range that cannot be.
    let chunks = [new Response(null, { status: 308, headers: { Range: "bytes=0-2" } }),
      new Response(null, { status: 308, headers: { Range: held } })];
    let fetch = answering((_url, { method }) => method === "PUT" ? chunks.shift() ?? new Response(null, { status: 500 })
      : method === "DELETE" ? new Response(null, { status: 499 }) : new Response(null, { headers: { Location: SESSION } }));

    await expect(upload({ name: "Plan", parents: ["folder1"] })).rejects.toThrow("Google Drive did not take the upload");

    expect(written.answers(/^upload\./)).toEqual([
      ["upload.send", "success", "", 308], ["upload.send", "error", "api", 308], ["upload.cancel", "success", "", 499],
    ]);
    expect(sent(fetch).filter(request => request.startsWith("PUT"))).toHaveLength(2);
  });
});

describe("a download of a range of a file", () => {
  it.each<[string, number, HeadersInit]>([
    ["the whole file, for a range that starts past its start", 200, {}],
    ["another range than was asked for", 206, { "Content-Range": "bytes 0-9/100" }],
    ["a range it does not place", 206, {}],
  ])("is an error where Drive answers %s, sent once", async (_what, status, headers) => {
    let written = writtenCalls();
    let fetch = answering(() => new Response("0123456789", { status, headers }));

    await expect(drive().downloadRange("file1", 10, 10)).rejects.toThrow("Google Drive did not return the requested byte range.");

    expect(written.answers(/./)).toEqual([["files.get.media", "error", "api", status]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, number, number, HeadersInit]>([
    ["the range asked for", 10, 206, { "Content-Range": "bytes 10-19/100" }],
    ["the whole file, for a range from its start", 0, 200, {}],
  ])("is a success where Drive answers %s", async (_what, offset, status, headers) => {
    let written = writtenCalls();
    answering(() => new Response("0123456789", { status, headers }));

    let { content } = await drive().downloadRange("file1", offset, 10);

    expect(await new Response(content).text()).toBe("0123456789");
    expect(written.answers(/./)).toEqual([["files.get.media", "success", "", status]]);
  });

  it("is counted by its status where Drive refuses it", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 }));

    await expect(drive().downloadRange("file1", 10, 10)).rejects.toMatchObject({ status: 404 });

    expect(written.answers(/./)).toEqual([["files.get.media", "error", "http", 404]]);
  });
});

describe("a download, whose redirects are followed", () => {
  const DOWNLOADS: [what: string, send: () => Promise<unknown>][] = [
    ["a whole file", () => drive().openDownload("file1")],
    ["a range past a file's start", () => drive().downloadRange("file1", 10, 10)],
    ["a range from a file's start", () => drive().downloadRange("file1", 0, 10)],
  ];

  it.each(DOWNLOADS.flatMap(([what, send]) => [300, 302, 304].map(status => [what, status, send] as const)))(
    "is an error where %s is answered a %i, which is no content of the file, sent once", async (_what, status, send) => {
      let written = writtenCalls();
      let fetch = answering(() => new Response(null, { status }));

      let error = await send().then(() => undefined, (failure: unknown) => failure);

      expect(error).toBeInstanceOf(DriveApiRequestError);
      expect(error).toMatchObject({ status, message: `Google Drive API request failed: ${status}` });
      expect(written.answers(/./)).toEqual([["files.get.media", "error", "api", status]]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

  it("is a success where a whole file is answered a 200, whose body is handed on", async () => {
    let written = writtenCalls();
    answering(() => new Response("0123456789"));

    expect(await new Response(await drive().openDownload("file1")).text()).toBe("0123456789");

    expect(written.answers(/./)).toEqual([["files.get.media", "success", "", 200]]);
  });

  it.each(DOWNLOADS)("is counted by its status where Drive refuses %s", async (_what, send) => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 }));

    await expect(send()).rejects.toMatchObject({ status: 404 });

    expect(written.answers(/./)).toEqual([["files.get.media", "error", "http", 404]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is refused for its rate where Drive answers each send of a whole file a 429", async () => {
    let written = writtenCalls();
    let fetch = answering(() => new Response(null, { status: 429, headers: { "Retry-After": "0" } }));

    await expect(drive().openDownload("file1")).rejects.toMatchObject({ status: 429 });

    let refused = ["files.get.media", "refused", "rate", 429];
    expect(written.answers(/./)).toEqual([refused, refused, refused]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("a batch of file reads answered a 200", () => {
  const NODE = { id: "file1", mimeType: DOC };

  it.each<[string, { status: number; body: unknown }, string]>([
    ["Drive's API being off", partRefusal(403, "accessNotConfigured"), "the Google Drive API is not enabled for this OAuth project"],
    ["a limit on the account", partRefusal(403, "rateLimitExceeded"), "Google Drive batch subrequest failed: 403"],
    ["a failure of Drive's", partRefusal(500, "backendError"), "Google Drive batch subrequest failed: 500"],
    ["another file than was asked for", { status: 200, body: { id: "file2" } },
      "Google Drive batch response did not echo the requested file ID"],
  ])("is an error where a part answers with %s, sent once", async (_what, part, thrown) => {
    let written = writtenCalls();
    let fetch = answering(() => batchOf(part));

    await expect(drive().getScopeNodes(["file1"])).rejects.toThrow(thrown);

    expect(written.answers(/./)).toEqual([["files.get.batch", "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is an error where a part is refused for its token, each time it is sent: once more, with a fresh token", async () => {
    let written = writtenCalls();
    let fetch = answering(() => batchOf(partRefusal(401, "authError")));
    let tokens = vi.fn(async (_asked?: AccessTokenRequest) => "token");

    await expect(new DriveApi(tokens).getScopeNodes(["file1"])).rejects.toThrow("Google Drive batch subrequest failed: 401");

    // The two sends are one point, of two calls: the batches of one read are summed.
    expect(written.answers(/./)).toEqual([["files.get.batch", "error", "api", 200]]);
    expect(written()).toEqual([["google-drive", "files.get.batch", "error", 200, 2]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tokens.mock.calls.map(([asked]) => asked)).toEqual([undefined, { forceRefresh: true, staleToken: "token" }, undefined]);
  });

  it("is a success where each part is a file or a refusal of that file alone", async () => {
    let written = writtenCalls();
    answering(() => batchOf({ status: 200, body: NODE }, partRefusal(404, "notFound"), partRefusal(403, "forbidden")));

    await expect(drive().getScopeNodes(["file1", "file2", "file3"])).resolves.toEqual([NODE, undefined, undefined]);

    expect(written.answers(/./)).toEqual([["files.get.batch", "success", "", 200]]);
  });
});
