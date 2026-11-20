// GatekeeperUser.saveFile() against a Drive that answers as Google's does: what is sent, and what
// is refused before anything is.

import { env } from "cloudflare:workers";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE } from "../src/drive-session";
import { officeLabel, type OfficeKind } from "../src/office-conversion";
import {
  CREATED_FILES_GRANT, GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_SHEETS_RESOURCE,
  GOOGLE_SLIDES_RESOURCE, parseResourceUrl, RESOURCE_BY_KIND,
} from "../src/resources";
import { saveFile } from "../src/save-file";
import { unbindWrittenCalls, writtenCalls } from "./written-calls";

const DOCX = GOOGLE_DOC_RESOURCE.savableFrom![0];
const FOLDER_URL = "https://drive.google.com/drive/folders/plans-1";
const DOC_URL = "https://docs.google.com/document/d/doc-1/edit";
const MIB = 1024 * 1024;

afterEach(() => {
  unbindWrittenCalls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Answer = Response | (() => Response);
const refusal = (status: number, reason: string) =>
  Response.json({ error: { errors: [{ reason }] } }, { status });

const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
const OPENED = new Response(null, { headers: { Location: SESSION } });
const sessionOf = (url: URL) => url.searchParams.has("upload_id");

/**
 * A Drive answering `about` with a 10 MiB Docs import limit, opening an upload session for a
 * POST or PATCH to the upload endpoint, and answering every other request from `answers`, by
 * method and path: `PUT session` is a chunk sent to the session. Records the requests it got.
 */
function stubDrive(answers: Record<string, Answer> = {}) {
  let calls: { method: string; url: URL; headers: Headers; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    let url = new URL(input);
    let method = init.method ?? "GET";
    let body = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body ?? "");
    calls.push({ method, url, headers: new Headers(init.headers), body });
    if (url.pathname === "/drive/v3/about") {
      return Response.json({ maxImportSizes: { [GOOGLE_DOC_MIME_TYPE]: String(10 * MIB) } });
    }
    let answer = answers[sessionOf(url) ? `${method} session` : `${method} ${url.pathname}`];
    if (!answer && !sessionOf(url) && url.pathname.startsWith("/upload/")) return OPENED.clone();
    if (!answer) throw new Error(`unexpected ${method} ${url.pathname}`);
    return typeof answer === "function" ? answer() : answer;
  }));
  return calls;
}

/** What a stubbed Drive was sent of an upload: the session's opening request, and each chunk. */
const uploaded = (calls: ReturnType<typeof stubDrive>) => ({
  open: calls.find(call => call.url.pathname.startsWith("/upload/") && !sessionOf(call.url))!,
  chunks: calls.filter(call => sessionOf(call.url) && call.method === "PUT")
    .map(call => [call.headers.get("Content-Range"), call.body]),
});
const saved = (id: string, mimeType: string) => Response.json({ id, mimeType });
/** Each of `answers` in turn, for a session that answers one request after another. */
const inTurn = (...answers: (() => Response)[]) => () => {
  let next = answers.shift();
  if (!next) throw new Error("the session was asked more than the test answers");
  return next();
};
/** A request whose reply never arrives. */
const lostReply = (): Response => { throw new Error("connection reset"); };
/** A success whose body fails as it is read. */
const lostBody = () =>
  new Response(new ReadableStream({ pull(controller) { controller.error(new Error("connection reset")); } }));
/** Drive's answer to the cancel of a session it has cancelled. */
const sessionCancelled = () => new Response(null, { status: 499 });
/** A 308 with which a session says it holds the first `held` bytes of the file. */
const took = (held: number) => () => new Response(null, { status: 308, headers: { Range: `bytes=0-${held - 1}` } });
/** A 403 that names a reason, in a body longer than is read of an error. */
const longRefusal = () => Response.json(
  { error: { errors: [{ reason: "rateLimitExceeded" }], message: "x".repeat(10_000) } }, { status: 403 });

const stream = (...chunks: (string | Uint8Array)[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (let chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    controller.close();
  },
});

const save = (
  destination: string,
  { type = GOOGLE_DOC_RESOURCE.urlPattern, contentType = DOCX, file = stream("PK", "docx"), held = true, name = "Plan" } = {},
) => saveFile(async () => "access-token", async grant => held && grant === CREATED_FILES_GRANT,
  type, destination, name, contentType, file);

describe("savableFrom", () => {
  it.each([
    ["doc", GOOGLE_DOC_RESOURCE, "docx"],
    ["sheets", GOOGLE_SHEETS_RESOURCE, "xlsx"],
    ["slides", GOOGLE_SLIDES_RESOURCE, "pptx"],
  ] as const)("lists the Office type Drive converts into a %s", (kind: OfficeKind, resource, label) => {
    expect(resource.savableFrom!.map(type => officeLabel(kind, type))).toEqual([label]);
    expect(resource.creationConfigurator).toBe(true);
  });
});

describe("saveFile", () => {
  it.each([
    ["doc", GOOGLE_DOC_MIME_TYPE],
    ["sheets", GOOGLE_SHEET_MIME_TYPE],
    ["slides", GOOGLE_SLIDES_MIME_TYPE],
  ] as const)("uploads a new %s into the chosen folder for Drive to convert", async (kind, native) => {
    let resource = RESOURCE_BY_KIND[kind];
    let calls = stubDrive({ "PUT session": saved("new-1", native) });

    let { url } = await save(FOLDER_URL, { type: resource.urlPattern, contentType: resource.savableFrom![0], name: " Plan " });

    expect(parseResourceUrl(url)).toMatchObject({ kind });
    expect(url).toContain("/d/new-1/");
    let { open, chunks } = uploaded(calls);
    expect([open.method, open.url.pathname]).toEqual(["POST", "/upload/drive/v3/files"]);
    expect(Object.fromEntries(open.url.searchParams)).toMatchObject({ uploadType: "resumable", supportsAllDrives: "true" });
    expect(open.headers.get("X-Upload-Content-Type")).toBe(resource.savableFrom![0]);
    expect(JSON.parse(open.body)).toEqual(
      { name: "Plan", mimeType: native, parents: ["plans-1"], appProperties: { gadgetsSaved: "1" } });
    // The session's URL is its credential: the chunk carries no token.
    expect(chunks).toEqual([["bytes 0-5/6", "PKdocx"]]);
    expect(calls.at(-1)!.headers.has("Authorization")).toBe(false);
  });

  it("puts a file saved to My Drive under Drive's root alias", async () => {
    let calls = stubDrive({ "PUT session": saved("new-1", GOOGLE_DOC_MIME_TYPE) });
    await save("https://drive.google.com/drive/folders/root");
    expect(JSON.parse(uploaded(calls).open.body).parents).toEqual(["root"]);
  });

  it("replaces the content of a file saved before, keeping its name, and returns the same URL", async () => {
    let calls = stubDrive({
      "GET /drive/v3/files/doc-1": Response.json({ id: "doc-1", name: "Renamed", mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, appProperties: { gadgetsSaved: "1" } }),
      "PUT session": saved("doc-1", GOOGLE_DOC_MIME_TYPE),
    });

    await expect(save(DOC_URL)).resolves.toEqual({ url: DOC_URL });

    let { open, chunks } = uploaded(calls);
    expect([open.method, open.url.pathname, open.body]).toEqual(["PATCH", "/upload/drive/v3/files/doc-1", "{}"]);
    expect(chunks).toEqual([["bytes 0-5/6", "PKdocx"]]);
  });

  it("opens the session again with a fresh token after a 401", async () => {
    let answers = [new Response(null, { status: 401 }), OPENED.clone()];
    let calls = stubDrive({
      "POST /upload/drive/v3/files": () => answers.shift()!, "PUT session": saved("new-1", GOOGLE_DOC_MIME_TYPE),
    });
    await saveFile(async opts => opts?.forceRefresh ? "fresh" : "stale", async () => true,
      GOOGLE_DOC_RESOURCE.urlPattern, FOLDER_URL, "Plan", DOCX, stream("PK"));
    expect(calls.filter(call => call.method === "POST").map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("sends a large file a chunk at a time, the total only with the last", async () => {
    let answers = [new Response(null, { status: 308, headers: { Range: `bytes=0-${8 * MIB - 1}` } }), saved("sheet-1", GOOGLE_SHEET_MIME_TYPE)];
    let calls = stubDrive({ "PUT session": () => answers.shift()! });
    let file = stream(new Uint8Array(5 * MIB), new Uint8Array(5 * MIB));
    await save(FOLDER_URL, { type: GOOGLE_SHEETS_RESOURCE.urlPattern, contentType: GOOGLE_SHEETS_RESOURCE.savableFrom![0], file });
    expect(uploaded(calls).chunks.map(([range]) => range))
      .toEqual([`bytes 0-${8 * MIB - 1}/*`, `bytes ${8 * MIB}-${10 * MIB - 1}/${10 * MIB}`]);
  });

  it("takes a 200 answered to a chunk that is not the last as that chunk held, and reads the file of the last one's answer alone", async () => {
    let written = writtenCalls();
    // The first chunk's 200 holds no file, and JSON of none: only the last chunk's is read for one.
    let calls = stubDrive({
      "PUT session": inTurn(() => new Response("<html>"), () => saved("sheet-1", GOOGLE_SHEET_MIME_TYPE)),
    });
    let file = stream(new Uint8Array(5 * MIB), new Uint8Array(5 * MIB));

    let sheets = { type: GOOGLE_SHEETS_RESOURCE.urlPattern, contentType: GOOGLE_SHEETS_RESOURCE.savableFrom![0], file };
    await expect(save(FOLDER_URL, sheets)).resolves.toMatchObject({ url: expect.stringContaining("/d/sheet-1/") });

    expect(uploaded(calls).chunks.map(([range]) => range))
      .toEqual([`bytes 0-${8 * MIB - 1}/*`, `bytes ${8 * MIB}-${10 * MIB - 1}/${10 * MIB}`]);
    expect(written.of("upload.send")).toEqual([["google-drive", "upload.send", "success", 200, 2]]);
  });

  it("asks the session again when the answer to the last chunk is cut short, and makes no second file", async () => {
    let cut = () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("connection reset")); } }));
    let answers = [cut, () => saved("new-1", GOOGLE_DOC_MIME_TYPE)];
    let calls = stubDrive({ "PUT session": () => answers.shift()!() });
    await expect(save(FOLDER_URL)).resolves.toMatchObject({ url: expect.stringContaining("/d/new-1/") });
    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""]]);
    expect(calls.map(call => call.method).filter(method => method !== "GET")).toEqual(["POST", "PUT", "PUT"]);
  });

  it("refuses an empty file, sending the session nothing", async () => {
    let calls = stubDrive({ "DELETE session": new Response(null, { status: 499 }) });
    await expect(save(FOLDER_URL, { file: stream() })).rejects.toThrow("This file is empty");
    expect(uploaded(calls).chunks).toEqual([]);
  });

  it("stops at a chunk the session refuses, reading and sending no more of the file", async () => {
    let calls = stubDrive({
      "PUT session": new Response(null, { status: 404 }), "DELETE session": new Response(null, { status: 499 }),
    });
    let pulls = 0;
    let file = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls > 20) return controller.close();
        controller.enqueue(new Uint8Array(4 * MIB));
      },
    }, { highWaterMark: 0 });
    let sheets = { type: GOOGLE_SHEETS_RESOURCE.urlPattern, contentType: GOOGLE_SHEETS_RESOURCE.savableFrom![0], file };
    // Not the folder's fault, nor the file's: the session's.
    await expect(save(FOLDER_URL, sheets)).rejects.toThrow("ended the upload before the file was sent");
    expect(uploaded(calls).chunks.map(([range]) => range)).toEqual([`bytes 0-${8 * MIB - 1}/*`]);
    expect(pulls).toBeLessThan(5);
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  it("keeps sending while the session keeps taking more, and gives up when it stops", async () => {
    let ranges = ["bytes=0-0", "bytes=0-1", "bytes=0-2", "bytes=0-3", "bytes=0-4"];
    let answers = [...ranges.map(Range => () => new Response(null, { status: 308, headers: { Range } })),
      () => saved("new-1", GOOGLE_DOC_MIME_TYPE)];
    let calls = stubDrive({ "PUT session": () => answers.shift()!() });
    await save(FOLDER_URL);
    expect(uploaded(calls).chunks.at(-1)).toEqual(["bytes 5-5/6", "x"]);

    calls = stubDrive({
      "PUT session": () => new Response(null, { status: 308 }), "DELETE session": new Response(null, { status: 499 }),
    });
    await expect(save(FOLDER_URL)).rejects.toThrow("did not take the upload");
    expect(uploaded(calls).chunks).toHaveLength(3);
  });

  it("cancels the file when the session cannot be opened", async () => {
    stubDrive({ "POST /upload/drive/v3/files": refusal(403, "storageQuotaExceeded") });
    let cancelled = false;
    let file = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(save(FOLDER_URL, { file })).rejects.toThrow("no Drive storage left");
    expect(cancelled).toBe(true);
  });

  it("counts each request of an upload under its own name, by its answer", async () => {
    let ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
    let points: AnalyticsEngineDataPoint[] = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    ambient.SUBSERVICE_METRICS = "true";
    let column = (point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) =>
      (slot.startsWith("blob") ? point.blobs! : point.doubles!)[Number(slot.replace(/\D+/, "")) - 1];
    // The points of the upload itself, less the reads made before it, each as its service,
    // operation, outcome, reason and HTTP status.
    let counted = () => points.splice(0).map(point => [
      SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
      SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot))).filter(([, operation]) => /resumable|^upload\./.test(String(operation)));
    try {
      // A new file whose last chunk's reply is lost: the session is asked, and has the file.
      let answers: (() => Response)[] = [() => { throw new Error("connection reset"); }, () => saved("new-1", GOOGLE_DOC_MIME_TYPE)];
      stubDrive({ "PUT session": () => answers.shift()!() });
      await save(FOLDER_URL);
      expect(counted()).toEqual([
        ["google-drive", "files.create.resumable", "success", "", 200],
        ["google-drive", "upload.send", "error", "network", 0],
        ["google-drive", "upload.getStatus", "success", "", 200],
      ]);

      // A saved file's new content, which the session refuses: the session is abandoned.
      stubDrive({
        "GET /drive/v3/files/doc-1": Response.json({ id: "doc-1", name: "Plan", mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, appProperties: { gadgetsSaved: "1" } }),
        "PUT session": new Response(null, { status: 404 }), "DELETE session": new Response(null, { status: 499 }),
      });
      await expect(save(DOC_URL)).rejects.toThrow("ended the upload before the file was sent");
      expect(counted()).toEqual([
        ["google-drive", "files.patch.resumable", "success", "", 200],
        ["google-drive", "upload.send", "error", "http", 404],
        // Drive's answer to a session it has cancelled is a 499, which is the cancel's success.
        ["google-drive", "upload.cancel", "success", "", 499],
      ]);
    } finally {
      delete ambient.METRICS;
      delete ambient.SUBSERVICE_METRICS;
    }
  });

  it("asks the session what it holds after a lost reply, and makes no second file", async () => {
    // The last chunk arrived and the file was made, but the reply was lost: the session says so.
    let answers: (() => Response)[] = [() => { throw new Error("connection reset"); }, () => saved("new-1", GOOGLE_DOC_MIME_TYPE)];
    let calls = stubDrive({ "PUT session": () => answers.shift()!() });
    await expect(save(FOLDER_URL)).resolves.toMatchObject({ url: expect.stringContaining("/d/new-1/") });
    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""]]);

    // Drive held only part of a chunk when it failed: only the rest is sent again.
    answers = [
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 308, headers: { Range: "bytes=0-1" } }),
      () => saved("new-1", GOOGLE_DOC_MIME_TYPE),
    ];
    calls = stubDrive({ "PUT session": () => answers.shift()!() });
    await save(FOLDER_URL);
    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""], ["bytes 2-5/6", "docx"]]);
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
    "waits out a 403 that throttles with %s, and stops at any other", async reason => {
      let answers = [() => refusal(403, reason), () => saved("new-1", GOOGLE_DOC_MIME_TYPE)];
      let calls = stubDrive({ "PUT session": () => answers.shift()!() });
      await expect(save(FOLDER_URL)).resolves.toMatchObject({ url: expect.stringContaining("/d/new-1/") });
      expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""]]);

      calls = stubDrive({ "PUT session": refusal(403, "insufficientFilePermissions"), "DELETE session": new Response(null, { status: 499 }) });
      await expect(save(FOLDER_URL)).rejects.toThrow("can't add files to that folder");
      expect(uploaded(calls).chunks).toHaveLength(1);
    });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
    "counts a 403 that throttles with %s as a rate refusal, of a chunk and of the status asked after it", async reason => {
      let written = writtenCalls();
      let calls = stubDrive({ "PUT session": inTurn(
        () => refusal(403, reason), () => refusal(403, reason), () => saved("new-1", GOOGLE_DOC_MIME_TYPE)) });

      // The upload waits both out, as it does uncounted.
      await expect(save(FOLDER_URL)).resolves.toMatchObject({ url: expect.stringContaining("/d/new-1/") });

      expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""], ["bytes */6", ""]]);
      expect(written.answers(/^upload\./)).toEqual([
        ["upload.send", "refused", "rate", 403],
        ["upload.getStatus", "refused", "rate", 403],
        ["upload.getStatus", "success", "", 200],
      ]);
    });

  it.each([
    ["refuses for the folder's permissions", () => refusal(403, "insufficientFilePermissions"), "can't add files to that folder"],
    ["names a limit that no wait lifts", () => refusal(403, "dailyLimitExceeded"), "Google Drive API request failed: 403"],
    ["gives no reason that can be read", () => new Response("<html>", { status: 403 }), "can't add files to that folder"],
  ])("counts a 403 that %s as an error, of a chunk and of the status asked after it", async (_name, denied, message) => {
    let written = writtenCalls();
    // The chunk itself is refused, and then the status asked after a chunk whose reply was lost.
    stubDrive({ "PUT session": denied, "DELETE session": sessionCancelled });
    await expect(save(FOLDER_URL)).rejects.toThrow(message);
    stubDrive({ "PUT session": inTurn(lostReply, denied), "DELETE session": sessionCancelled });
    await expect(save(FOLDER_URL)).rejects.toThrow(message);

    expect(written.answers(/^upload\.(send|getStatus)$/)).toEqual([
      ["upload.send", "error", "http", 403],
      ["upload.send", "error", "network", 0],
      ["upload.getStatus", "error", "http", 403],
    ]);
  });

  it("reads no body to count an upload's answer that is no 403", async () => {
    let written = writtenCalls();
    let copied = vi.spyOn(Response.prototype, "clone");
    let answered = refusal(404, "rateLimitExceeded");
    stubDrive({ "PUT session": answered, "DELETE session": sessionCancelled });

    await expect(save(FOLDER_URL)).rejects.toThrow("ended the upload before the file was sent");

    expect(written.answers(/^upload\.send$/)).toEqual([["upload.send", "error", "http", 404]]);
    expect(copied.mock.contexts).not.toContain(answered);
  });

  it("counts a chunk's success whose body fails to arrive as a failed read, and asks the session what it holds", async () => {
    let written = writtenCalls();
    let calls = stubDrive({ "PUT session": inTurn(lostBody, () => saved("new-1", GOOGLE_DOC_MIME_TYPE)) });

    await expect(save(FOLDER_URL)).resolves.toMatchObject({ url: expect.stringContaining("/d/new-1/") });

    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""]]);
    expect(written.answers(/^upload\./)).toEqual([
      ["upload.send", "error", "parse", 200],
      ["upload.getStatus", "success", "", 200],
    ]);
  });

  it.each([
    ["a file of another type than was asked for", () => saved("new-1", "application/pdf")],
    ["a file with no ID", () => Response.json({ mimeType: GOOGLE_DOC_MIME_TYPE })],
    ["no file", () => Response.json([])],
  ])("counts an upload that ends in %s as an error, and asks the session nothing more", async (_name, made) => {
    let written = writtenCalls();
    let calls = stubDrive({ "PUT session": inTurn(made), "DELETE session": sessionCancelled });

    await expect(save(FOLDER_URL)).rejects.toThrow("Google Drive did not convert the uploaded file into the type asked for");

    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"]]);
    expect(written.answers(/^upload\./)).toEqual([
      ["upload.send", "error", "api", 200],
      ["upload.cancel", "success", "", 499],
    ]);
  });

  it("counts an upload that ends in JSON that cannot be read as a failed read, and asks the session nothing more", async () => {
    let written = writtenCalls();
    let calls = stubDrive({ "PUT session": inTurn(() => new Response("<html>")), "DELETE session": sessionCancelled });

    await expect(save(FOLDER_URL)).rejects.toThrow("Google Drive response was not valid JSON (6 UTF-16 code units)");

    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"]]);
    expect(written.answers(/^upload\./)).toEqual([
      ["upload.send", "error", "parse", 200],
      ["upload.cancel", "success", "", 499],
    ]);
  });

  it("counts a file of another type that the session says it holds after a lost reply as an error of the status asked", async () => {
    let written = writtenCalls();
    let calls = stubDrive({
      "PUT session": inTurn(lostReply, () => saved("new-1", "application/pdf")), "DELETE session": sessionCancelled,
    });

    await expect(save(FOLDER_URL)).rejects.toThrow("Google Drive did not convert the uploaded file into the type asked for");

    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes */6", ""]]);
    expect(written.answers(/^upload\./)).toEqual([
      ["upload.send", "error", "network", 0],
      ["upload.getStatus", "error", "api", 200],
      ["upload.cancel", "success", "", 499],
    ]);
  });

  it("refuses an upload answered a 403 too long to read a reason from, and counts it as an error", async () => {
    let written = writtenCalls();
    // The reason is given up, and the copy read for the count with it, while the upload still
    // holds the answer.
    let calls = stubDrive({ "PUT session": longRefusal, "DELETE session": sessionCancelled });

    await expect(save(FOLDER_URL)).rejects.toThrow("can't add files to that folder");

    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"]]);
    expect(written.answers(/^upload\./)).toEqual([
      ["upload.send", "error", "http", 403],
      ["upload.cancel", "success", "", 499],
    ]);
  });

  it("writes the chunks an upload is sent in as one point for each answer Drive gives them", async () => {
    let written = writtenCalls();
    // Drive takes two bytes of what it is sent, twice, and then the rest.
    let calls = stubDrive({ "PUT session": inTurn(took(2), took(4), () => saved("new-1", GOOGLE_DOC_MIME_TYPE)) });

    await expect(save(FOLDER_URL)).resolves.toMatchObject({ url: expect.stringContaining("/d/new-1/") });

    expect(uploaded(calls).chunks).toEqual([["bytes 0-5/6", "PKdocx"], ["bytes 2-5/6", "docx"], ["bytes 4-5/6", "cx"]]);
    expect(written.of("upload.send")).toEqual([
      ["google-drive", "upload.send", "success", 308, 2],
      ["google-drive", "upload.send", "success", 200, 1],
    ]);
  });

  it.each([
    ["in the trash", { mimeType: GOOGLE_DOC_MIME_TYPE, trashed: true }, /in the Drive trash/],
    ["no longer of the native type", { mimeType: DOCX, trashed: false }, /is not a Google Doc saved from here/],
    // Whatever else the account may edit, as with a full Drive grant.
    ["not one a save made", { mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, appProperties: {} }, /is not a Google Doc saved from here/],
  ])("refuses to replace a file that is %s", async (_name, file, message) => {
    let calls = stubDrive({
      "GET /drive/v3/files/doc-1": Response.json({ id: "doc-1", name: "Plan", appProperties: { gadgetsSaved: "1" }, ...file }),
    });
    await expect(save(DOC_URL)).rejects.toThrow(message);
    expect(calls.map(call => call.method)).toEqual(["GET"]);
  });

  it.each([
    ["the lookup", { "GET /drive/v3/files/doc-1": refusal(404, "notFound") }],
    ["the upload", {
      "GET /drive/v3/files/doc-1": Response.json({ id: "doc-1", name: "Plan", mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, appProperties: { gadgetsSaved: "1" } }),
      "PATCH /upload/drive/v3/files/doc-1": refusal(404, "notFound"),
    }],
  ])("says to save a new copy when %s cannot find the file saved before", async (_name, answers) => {
    stubDrive(answers);
    await expect(save(DOC_URL)).rejects.toThrow(/can't find the file this was saved to before.*Save a new copy/);
  });

  it("says so when the folder takes no files or the account's storage is full", async () => {
    stubDrive({ "POST /upload/drive/v3/files": refusal(404, "notFound") });
    await expect(save(FOLDER_URL)).rejects.toThrow("can't add files to that folder");
    stubDrive({ "POST /upload/drive/v3/files": refusal(403, "storageQuotaExceeded") });
    await expect(save(FOLDER_URL)).rejects.toThrow("no Drive storage left");
  });

  it.each([
    ["a file of another native type", "https://docs.google.com/spreadsheets/d/sheet-1/edit", /saved to a Google Drive folder, or over one saved before/],
    ["a Drive file", "https://drive.google.com/file/d/file-1/view", /saved to a Google Drive folder/],
    ["no URL", "plans-1", "Not a valid resource URL."],
  ])("refuses %s as the destination, asking Drive nothing", async (_name, destination, message) => {
    let calls = stubDrive();
    await expect(save(destination)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a type that is not saved to", { type: GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern }],
    ["a content type the resource type does not list", { contentType: GOOGLE_SHEETS_RESOURCE.savableFrom![0] }],
    ["another Office type Drive converts", { contentType: "application/msword" }],
  ])("refuses %s", async (_name, options) => {
    let calls = stubDrive();
    await expect(save(FOLDER_URL, options)).rejects.toThrow("Google cannot save that kind of file as that resource type.");
    expect(calls).toEqual([]);
  });

  it("refuses a new file a blank name, and an account without the created-files grant", async () => {
    let calls = stubDrive();
    await expect(save(FOLDER_URL, { name: " " })).rejects.toThrow(/needs a one-line title/);
    await expect(save(FOLDER_URL, { held: false })).rejects.toThrow(/hasn't let this app save files to its Drive/);
    expect(calls).toEqual([]);
  });

  it("stops reading a file larger than Drive imports into the type, and uploads nothing of it", async () => {
    let calls = stubDrive({ "DELETE session": new Response(null, { status: 499 }) });
    let cancelled = false;
    let endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4 * MIB));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });

    await expect(save(FOLDER_URL, { file: endless })).rejects.toThrow(/larger than the 10 MB Google Drive converts/);
    expect(cancelled).toBe(true);
    // The session it opened is abandoned having been sent nothing, so no file is made.
    expect(uploaded(calls).chunks).toEqual([]);
    expect(calls.at(-1)!.method).toBe("DELETE");
  });
});
