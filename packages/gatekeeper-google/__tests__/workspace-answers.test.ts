// A request to a Workspace API whose answer the gatekeeper reads is read inside the client's
// `read`, through `readWithAuthRetry`: its attempt is counted by whether the answer could be read
// and held what the helper asked for, not by the status that came before it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BigQueryApi } from "../src/bigquery-api";
import { GoogleCalendarApi } from "../src/calendar-api";
import { ChatApi } from "../src/chat-api";
import { GoogleDocsApi } from "../src/docs-api";
import { DriveApi } from "../src/drive-api";
import { GmailApi } from "../src/google-api";
import { GoogleSheetsApi } from "../src/sheets-api";
import { GoogleSlidesApi } from "../src/slides-api";
import { unbindWrittenCalls, writtenCalls } from "./written-calls";

const token = async () => "token";
const JSON_BODY = { "Content-Type": "application/json" };
const AREA = { sheetId: 0, rect: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } };
const SNAPSHOT = {
  key: "0.1", messageId: "m1", attachmentId: "a1",
  info: { filename: null, mimeType: "text/plain", size: 3, disposition: null, readable: true },
};
const COPY = { name: "Plan", mimeType: "application/vnd.google-apps.document", parents: ["folder1"], appProperties: {} };
const THUMBNAIL = Response.json({ contentUrl: "https://lh3.googleusercontent.com/thumbnail" });

const bigquery = () => new BigQueryApi(token);
const calendar = () => new GoogleCalendarApi(token);
const chat = () => new ChatApi(token);
const docs = () => new GoogleDocsApi(token);
const drive = () => new DriveApi(token);
const gmail = () => new GmailApi("ada@example.com", token);
const sheets = () => new GoogleSheetsApi(token);
const slides = () => new GoogleSlidesApi(token);

// Each kind of read: what it is, the name its request is counted under, how it is sent, and the
// answers of the requests sent ahead of it.
type Read = [what: string, operation: string, send: () => Promise<unknown>, before?: () => Response[]];

// Every helper whose request reads the JSON of its answer.
const JSON_READS: Read[] = [
  ["a BigQuery read", "projects.list", () => bigquery().listProjects()],
  ["a Calendar read", "calendarList.get", () => calendar().getCalendar("primary")],
  ["a Chat read", "spaces.list", () => chat().listSpaces()],
  ["a Chat directory search", "people.searchDirectoryPeople", () => chat().searchDirectory("ada")],
  ["a Chat read of profile names", "people.batchGet", () => chat().profileNames(["users/1"])],
  ["a Docs write", "documents.create", () => docs().createDocument("Plan")],
  ["a Drive read", "files.get", () => drive().canEdit("file1")],
  ["a Drive write", "comments.create", () => drive().createComment("file1", "Looks good")],
  ["a Drive copy", "files.copy", () => drive().copyAsNative("file1", COPY)],
  ["a Drive batch", "files.get.batch", () => drive().getScopeNodes(["file1"])],
  ["a Sheets write", "spreadsheets.create", () => sheets().createSpreadsheet("Plan")],
  ["a Sheets read of entered values", "spreadsheets.getByDataFilter", () => sheets().readEntered("sheet1", [AREA])],
  ["a Sheets read of cells", "values.batchGetByDataFilter", () => sheets().readAreas("sheet1", [AREA], "raw")],
  ["a Sheets read of formats", "spreadsheets.getByDataFilter", () => sheets().readFormatAreas("sheet1", [AREA])],
  ["a Sheets read of developer metadata", "developerMetadata.get", () => sheets().getDeveloperMetadata("sheet1", 7)],
  ["a Slides read", "thumbnail.get", () => slides().getThumbnail("deck1", "page1", "SMALL")],
  ["Gmail's list of threads", "threads.list", () => gmail().listThreads(10)],
  ["Gmail's read of a thread", "threads.get", () => gmail().getThread("t1")],
  ["Gmail's read of a thread's metadata", "threads.get", () => gmail().getThreadMetadata("t1")],
  ["Gmail's list of messages", "messages.list", () => gmail().listMessages(10)],
  ["Gmail's read of a message's metadata", "messages.get", () => gmail().getMessageMetadata("m1")],
  ["Gmail's read of a whole message", "messages.get", () => gmail().getMessageFull("m1")],
  ["Gmail's read of an attachment", "attachments.get", () => gmail().getAttachmentContent(SNAPSHOT)],
  ["Gmail's read of a message's participants", "messages.get", () => gmail().getMessageParticipants("m1")],
  ["Gmail's read of a raw message", "messages.get", () => gmail().getMessage("m1")],
  ["Gmail's send", "messages.send", () => gmail().sendRawMessage("raw")],
  ["Gmail's list of drafts", "drafts.list", () => gmail().listDrafts(10)],
  ["Gmail's read of a raw draft", "drafts.get", () => gmail().getDraft("d1")],
  ["Gmail's read of a whole draft", "drafts.get", () => gmail().getDraftFull("d1")],
  ["Gmail's creation of a draft", "drafts.create", () => gmail().createDraft("raw")],
  ["Gmail's update of a draft", "drafts.update", () => gmail().updateDraft("d1", "raw")],
  ["Gmail's send of a draft", "drafts.send", () => gmail().sendDraft("d1", "raw")],
  ["Gmail's list of labels", "labels.list", () => gmail().listLabelRecords()],
  ["Gmail's read of a label", "labels.get", () => gmail().getLabel("Label_1")],
  ["Gmail's creation of a label", "labels.create", () => gmail().createLabel("Plans")],
  ["Gmail's rename of a label", "labels.patch", () => gmail().renameLabel("Label_1", "Plans")],
  ["Gmail's read of the profile", "profile.get", () => gmail().getProfile()],
  ["Gmail's watch", "watch", () => gmail().watch("projects/p/topics/t")],
  ["Gmail's list of history", "history.list", () => gmail().listMessagesAdded("1")],
];

// The two helpers whose request reads the bytes of its answer.
const BYTE_READS: Read[] = [
  ["a Chat attachment's download", "media.get.media", () => chat().downloadAttachment("spaces/s/messages/m/attachments/a")],
  ["a Slides thumbnail's download", "thumbnail.download", () => slides().getThumbnail("deck1", "page1", "SMALL"),
    () => [THUMBNAIL.clone()]],
];

// Stubs a fetch that answers with each of `before` in turn and every later request with what
// `answer` makes, and records each.
function answering(answer: (init: RequestInit) => Response, before: Response[] = []) {
  let fetch = vi.fn(async (_url: string | URL, init: RequestInit = {}) => before.shift() ?? answer(init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// An answer whose headers came and whose body fails as it is read.
const lostAfterHeaders = () => new Response(new ReadableStream({
  pull(controller) { controller.error(new TypeError("connection lost")); },
}), { headers: JSON_BODY });

// An answer whose body never ends: reading it fails with the reason of the request's signal once
// that aborts.
const stalled = ({ signal }: RequestInit) => new Response(new ReadableStream({
  start(controller) {
    signal?.addEventListener("abort", () => controller.error(signal.reason));
  },
}), { headers: JSON_BODY });

// Makes the timeout of every attempt fire a moment after it is sent, and no send wait for the
// one before it.
function shortTimeouts() {
  let timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(20));
  vi.spyOn(Math, "random").mockReturnValue(0);
}

// The last point written, as its operation, outcome, reason and HTTP status.
const lastAnswer = (written: ReturnType<typeof writtenCalls>) => written.answers(/./).at(-1);

afterEach(() => {
  unbindWrittenCalls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a 200 that cannot be read", () => {
  it.each(JSON_READS)("is a failed read of %s where it is a page that is no JSON, sent once", async (_what, operation, send, before) => {
    let written = writtenCalls();
    let ahead = before?.() ?? [];
    let sends = ahead.length + 1;
    let fetch = answering(() => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }), ahead);

    await expect(send()).rejects.toThrow();

    expect(lastAnswer(written)).toEqual([operation, "error", "parse", 200]);
    expect(fetch).toHaveBeenCalledTimes(sends);
  });

  it.each(JSON_READS)("is a failed read of %s where its JSON is cut off, sent once", async (_what, operation, send, before) => {
    let written = writtenCalls();
    let ahead = before?.() ?? [];
    let sends = ahead.length + 1;
    let fetch = answering(() => new Response('{"id":"cut', { headers: JSON_BODY }), ahead);

    await expect(send()).rejects.toThrow();

    expect(lastAnswer(written)).toEqual([operation, "error", "parse", 200]);
    expect(fetch).toHaveBeenCalledTimes(sends);
  });

  it.each([...JSON_READS, ...BYTE_READS])("is a failed read of %s where its body is lost after its headers, sent once", async (_what, operation, send, before) => {
    let written = writtenCalls();
    let ahead = before?.() ?? [];
    let sends = ahead.length + 1;
    let fetch = answering(lostAfterHeaders, ahead);

    await expect(send()).rejects.toThrow();

    expect(lastAnswer(written)).toEqual([operation, "error", "parse", 200]);
    expect(fetch).toHaveBeenCalledTimes(sends);
  });
});

describe("a 200 that lacks what the helper asked for", () => {
  it.each<[string, string, () => Promise<unknown>, () => Response, string]>([
    ["a Sheets read of entered values that lacks a range", "spreadsheets.getByDataFilter",
      () => sheets().readEntered("sheet1", [AREA]), () => Response.json({ sheets: [] }),
      "Google Sheets did not return every range it was asked for."],
    ["a Sheets read of cells that lacks a range", "values.batchGetByDataFilter",
      () => sheets().readAreas("sheet1", [AREA], "raw"), () => Response.json({ valueRanges: [] }),
      "Google Sheets did not return every range it was asked for."],
    ["a Sheets read of formats that lacks a range", "spreadsheets.getByDataFilter",
      () => sheets().readFormatAreas("sheet1", [AREA]), () => Response.json({ sheets: [] }),
      "Google Sheets did not return every range it was asked for."],
    ["a Drive copy of another type than was asked for", "files.copy",
      () => drive().copyAsNative("file1", COPY),
      () => Response.json({ id: "copy1", name: "Plan", mimeType: "application/pdf" }),
      "Google Drive made a copy of a different type than was asked for"],
    ["Gmail's send that names no message", "messages.send",
      () => gmail().sendRawMessage("raw"), () => Response.json({ id: "m1" }),
      "Gmail accepted the send request but returned an invalid response."],
    ["Gmail's creation of a draft that names none", "drafts.create",
      () => gmail().createDraft("raw"), () => Response.json({}),
      "Gmail accepted the draft creation but returned an invalid response."],
    ["Gmail's read of a draft that holds no message", "drafts.get",
      () => gmail().getDraft("d1"), () => Response.json({ id: "d1" }),
      "Gmail returned an invalid draft resource."],
    ["Gmail's read of another label than was asked for", "labels.get",
      () => gmail().getLabel("Label_1"), () => Response.json({ id: "Label_2", name: "Plans", type: "user" }),
      "Gmail labels.get returned a different label ID."],
    ["Gmail's read of a profile that names no address", "profile.get",
      () => gmail().getProfile(), () => Response.json({ historyId: "1" }),
      "Gmail returned an invalid profile."],
  ])("is a failed read of %s, sent once", async (_what, operation, send, answer, message) => {
    let written = writtenCalls();
    let fetch = answering(answer);

    await expect(send()).rejects.toThrow(message);

    expect(lastAnswer(written)).toEqual([operation, "error", "parse", 200]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is a failed download of a Slides thumbnail that is no PNG", async () => {
    let written = writtenCalls();
    let fetch = answering(() => new Response("GIF89a"), [THUMBNAIL.clone()]);

    await expect(slides().getThumbnail("deck1", "page1", "SMALL"))
      .rejects.toThrow("Google Slides returned a thumbnail that is not a PNG");

    expect(written.answers(/^thumbnail\./)).toEqual([
      ["thumbnail.get", "success", "", 200], ["thumbnail.download", "error", "parse", 200],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is a failed download of a Chat attachment longer than is read", async () => {
    let written = writtenCalls();
    let fetch = answering(() => new Response("x", { headers: { "Content-Length": String(2 ** 40) } }));

    await expect(chat().downloadAttachment("spaces/s/messages/m/attachments/a"))
      .rejects.toThrow(/^Attachment exceeds the \d+-byte safe-read limit\.$/);

    expect(written.answers(/./)).toEqual([["media.get.media", "error", "parse", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("a 200 in which BigQuery rejects a job", () => {
  const JOB = { jobReference: { projectId: "project", jobId: "job-1" } };
  const REJECTED = { errors: [{ reason: "invalidQuery", message: "Unrecognized name: n" }] };

  it("is a failed submission of a query, sent once", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ ...JOB, jobComplete: false, ...REJECTED }));

    await expect(bigquery().query("project", "SELECT n"))
      .rejects.toThrow("BigQuery query failed: Unrecognized name: n");

    expect(written.answers(/./)).toEqual([["queries.create", "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is a failed poll of a query's results, after a submission that succeeded", async () => {
    let written = writtenCalls();
    let fetch = answering(
      () => Response.json({ ...JOB, jobComplete: false, ...REJECTED }),
      [Response.json({ ...JOB, jobComplete: false })]);

    await expect(bigquery().query("project", "SELECT n"))
      .rejects.toThrow("BigQuery query failed: Unrecognized name: n");

    expect(written.answers(/./)).toEqual([
      ["queries.create", "success", "", 200], ["queries.get", "error", "api", 200],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is a failed dry run, sent once", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({
      ...JOB, status: { state: "DONE", errorResult: { reason: "invalidQuery", message: "Syntax error" } },
    }));

    await expect(bigquery().dryRun("project", "SELEC 1"))
      .rejects.toThrow("BigQuery dry run failed: Syntax error");

    expect(written.answers(/./)).toEqual([["jobs.create", "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[what: string, operations: string[], answers: unknown[], send: () => Promise<unknown>, thrown: string]>([
    ["a submission answered null", ["queries.create"], [null],
      () => bigquery().query("project", "SELECT 1"), "reading 'errors'"],
    ["a submission whose first error is null", ["queries.create"], [{ ...JOB, jobComplete: true, errors: [null] }],
      () => bigquery().query("project", "SELECT 1"), "reading 'message'"],
    ["a poll answered null", ["queries.create", "queries.get"], [{ ...JOB, jobComplete: false }, null],
      () => bigquery().query("project", "SELECT 1"), "reading 'errors'"],
    ["a dry run answered null", ["jobs.create"], [null],
      () => bigquery().dryRun("project", "SELECT 1"), "reading 'status'"],
  ])("is an error of the request whose JSON the helper's check cannot read: %s", async (_what, operations, answers, send, thrown) => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(null), answers.map(answer => Response.json(answer)));

    let error = await send().then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toHaveProperty("message", expect.stringContaining(thrown));
    // The requests answered before it are each a success, and the one the check threw on is not.
    expect(written.answers(/./)).toEqual(operations.map((operation, index) =>
      index < operations.length - 1 ? [operation, "success", "", 200] : [operation, "error", "api", 200]));
    expect(fetch).toHaveBeenCalledTimes(operations.length);
  });

  it("is a success where the helper takes the job: a query with no errors, and a dry run that names no failing one", async () => {
    let written = writtenCalls();
    answering(() => Response.json({
      ...JOB, jobComplete: true, errors: [], status: { state: "DONE", errors: [{ reason: "stopped" }] },
    }));

    await expect(bigquery().query("project", "SELECT 1")).resolves.toMatchObject({ jobId: "job-1", rows: [] });
    await expect(bigquery().dryRun("project", "SELECT 1")).resolves.toMatchObject({ bytesProcessed: 0 });

    expect(written.answers(/./)).toEqual([
      ["queries.create", "success", "", 200], ["jobs.create", "success", "", 200],
    ]);
  });

  it.each<[what: string, errors: unknown]>([
    ["an object", { message: "m" }],
    ["a number", 1],
    ["true", true],
    ["an empty string", ""],
    ["null", null],
  ])("is a success where a query's errors are no list of any length, in a submission and in a poll: %s", async (_what, errors) => {
    let written = writtenCalls();
    let fetch = answering(
      () => Response.json({ ...JOB, jobComplete: true, errors }),
      [Response.json({ ...JOB, jobComplete: false, errors })]);

    await expect(bigquery().query("project", "SELECT 1")).resolves.toEqual({
      schema: [], rows: [], totalRows: 0, bytesProcessed: 0, cacheHit: false, jobId: "job-1",
    });

    expect(written.answers(/./)).toEqual([
      ["queries.create", "success", "", 200], ["queries.get", "success", "", 200],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("an answer that is read", () => {
  it("is a success where it holds what the helper asked for", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ id: "t1", snippet: "hello", messages: [{ id: "m1" }] }));

    await expect(gmail().getThread("t1")).resolves.toEqual({
      id: "t1", snippet: "hello", messages: [{ id: "m1", threadId: "t1" }],
    });

    expect(written.answers(/./)).toEqual([["threads.get", "success", "", 200]]);
  });

  it("is counted by its status where that is no success, whatever its body holds", async () => {
    let written = writtenCalls();
    let fetch = answering(() => new Response("<html>Not found</html>", { status: 404 }));

    await expect(gmail().getThread("t1")).rejects.toMatchObject({ status: 404 });
    await expect(sheets().getDeveloperMetadata("sheet1", 7)).resolves.toBeUndefined();
    await expect(chat().profileNames(["users/1"])).resolves.toEqual(new Map());

    expect(written.answers(/./)).toEqual([
      ["threads.get", "error", "http", 404], ["developerMetadata.get", "error", "http", 404],
      ["people.batchGet", "error", "http", 404],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("a 200 whose body the attempt's timeout cuts off", () => {
  it("is a timeout of each send of a read, which is sent three times", async () => {
    shortTimeouts();
    let written = writtenCalls();
    let fetch = answering(stalled);

    await expect(gmail().getThread("t1")).rejects.toMatchObject({ name: "TimeoutError" });

    expect(written.answers(/./)).toEqual(Array.from({ length: 3 }, () => ["threads.get", "error", "timeout", 200]));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("is read from the send made after it", async () => {
    shortTimeouts();
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ id: "t1", messages: [] }));
    fetch.mockImplementationOnce(async (_url, init = {}) => stalled(init));

    await expect(gmail().getThread("t1")).resolves.toEqual({ id: "t1", snippet: "", messages: [] });

    expect(written.answers(/./)).toEqual([
      ["threads.get", "error", "timeout", 200], ["threads.get", "success", "", 200],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    ["Gmail's send", "messages.send", () => gmail().sendRawMessage("raw")],
    ["Gmail's creation of a draft", "drafts.create", () => gmail().createDraft("raw")],
    ["a Drive write", "comments.create", () => drive().createComment("file1", "Looks good")],
    ["a Drive copy", "files.copy", () => drive().copyAsNative("file1", COPY)],
    ["a Docs write", "documents.create", () => docs().createDocument("Plan")],
    ["a BigQuery read, which is sent once whatever fails", "projects.list", () => bigquery().listProjects()],
  ])("is a timeout of %s, which is sent once", async (_what, operation, send) => {
    shortTimeouts();
    let written = writtenCalls();
    let fetch = answering(stalled);

    await expect(send()).rejects.toThrow();

    expect(written.answers(/./)).toEqual([[operation, "error", "timeout", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
