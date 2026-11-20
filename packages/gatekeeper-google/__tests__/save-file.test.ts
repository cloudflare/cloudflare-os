// GatekeeperUser.saveFile() against a Drive that answers as Google's does: what is sent, and what
// is refused before anything is.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE } from "../src/drive-session";
import { officeLabel, type OfficeKind } from "../src/office-conversion";
import {
  CREATED_FILES_GRANT, GOOGLE_DOC_RESOURCE, GOOGLE_DRIVE_FOLDER_RESOURCE, GOOGLE_SHEETS_RESOURCE,
  GOOGLE_SLIDES_RESOURCE, parseResourceUrl, RESOURCE_BY_KIND,
} from "../src/resources";
import { saveFile } from "../src/save-file";

const DOCX = GOOGLE_DOC_RESOURCE.savableFrom![0];
const FOLDER_URL = "https://drive.google.com/drive/folders/plans-1";
const DOC_URL = "https://docs.google.com/document/d/doc-1/edit";
const MIB = 1024 * 1024;

afterEach(() => void vi.unstubAllGlobals());

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
