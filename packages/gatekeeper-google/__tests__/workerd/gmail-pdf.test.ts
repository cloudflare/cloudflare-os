// A PDF attachment read through a Gmail binding as a deployment runs it: the Gmail gatekeeper's
// own session, which takes the renderer and the model from its bindings, the renderer Worker
// behind its service binding, and Gmail faked at the fetch layer. The model is the pool's fake,
// which converts a PDF to what the PDF itself says, and to nothing when it says nothing.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {RENDER_LIMITS} from "@gadgets/pdf-renderer/api";
import {PDF_FIRST_READ, type GmailGatekeeperImplProps} from "../../src/gmail";
import {buildEncodedEmail, MAX_GMAIL_ATTACHMENT_BYTES} from "../../src/google-api";
import type {GmailDraftInfo, GmailPdfText} from "../../src/types";
import {faxMarks, imagePdf, scanPage} from "../pdf-fixture";
import type {TestHooks} from "./worker";

const testEnv = env as unknown as {
  GmailGatekeeperImpl: DurableObjectNamespace;
  UserAccount: DurableObjectNamespace;
  TestHooks: DurableObjectNamespace<TestHooks>;
};

const MESSAGE_ID = "abc123";
/** The title every read of an attachment's bytes for its PDF text is reported under. */
const TITLE = "Read Gmail attachment text";
const FIRST_READ = "Read the text of this PDF attachment.";
const WHOLE_READ = "Read this PDF attachment whole, to render its pages and transcribe them.";
const STORED_READ = "Read this PDF attachment's stored page images, from page image 1 on, to transcribe them.";
const DENIED = "This observation was denied by the test.";
/** What the pool's fake model reads on every image. */
const MODEL_TEXT = "Harbour Ledger";
const READ_FROM_IMAGE =
  "[This page has no text of its own: what follows was read from its image by a vision model, which can misread.]";

/** A PDF object that tells the pool's fake model what the PDF it is in converts to. */
function converts(markdown: string): string {
  const hex = [...markdown].map(char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `<< /FakeAiMarkdown <${hex}> >>`;
}

/** A one-page PDF that has text. */
const TEXT_PDF = imagePdf([faxMarks()], {
  objects: [converts("# file.pdf\n## Contents\n### Page 1\nCover sheet of the ledger\n")],
}).bytes;
/** A PDF whose first page has text and whose second, stored as fax, has none. */
const MIXED_PDF = imagePdf([faxMarks(), faxMarks()], {
  objects: [converts("# file.pdf\n## Contents\n### Page 1\nCover sheet of the ledger\n\n\n\n### Page 2\n\n\n")],
}).bytes;
/** A one-page scan stored as fax, which is rendered to be read. */
const FAX_SCAN = imagePdf([faxMarks()]).bytes;
/** A two-page scan stored as JPEG, which is read as stored once it is too large to be rendered. */
const JPEG_SCAN = imagePdf([scanPage(1), scanPage(2)]);
const JPEG_SCAN_TEXT = `### Page 1\n${MODEL_TEXT}\n\n### Page 2\n${MODEL_TEXT}`;

/** Has the gatekeeper take {@link JPEG_SCAN} for a file too large to render, until the test ends. */
function tooLargeToRender(): void {
  RENDER_LIMITS.fileBytes = JPEG_SCAN.bytes.byteLength - 1;
}

type Part = {filename: string; mimeType: string; bytes: Uint8Array};

function pdfPart(bytes: Uint8Array): Part {
  return {filename: "scan.pdf", mimeType: "application/pdf", bytes};
}

/** Holds a Gmail answer until released. Polled, as a promise settled across Durable Objects is not safe. */
type Gate = {released: boolean};

/**
 * One answer to attachments.get: how many bytes of its body were read, and whether it was read to
 * its end, or cancelled before it.
 */
type Opened = {read: number; ended: boolean; cancelled: boolean};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {headers: {"Content-Type": "application/json"}});

/**
 * Gmail as far as reading one message's attachments uses it: the message `abc123`, whose
 * attachments are `parts`, and each attachment's bytes, streamed in pieces. `opened` is every
 * answer to attachments.get, in order; while `holdReopens` is set and not released, every such
 * answer after the first waits. An answer stops arriving, without ending, once `stallAt` bytes
 * of it were read. `raw` is the message whole, which a forward of it asks for.
 */
function installGmail(parts: Part[] = [], raw?: string) {
  const gmail = {
    opened: [] as Opened[], holdReopens: undefined as Gate | undefined, stallAt: undefined as number | undefined,
  };
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      return json({sub: "owner-subject", email: "owner@example.com"});
    }
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    if (url.hostname !== "gmail.googleapis.com" || path === url.pathname) {
      throw new Error(`Unexpected request: ${url}`);
    }
    if (path === "/labels") return json({labels: [{id: "INBOX", name: "INBOX", type: "system"}]});
    if (path === `/messages/${MESSAGE_ID}`) {
      if (url.searchParams.get("format") === "raw") {
        return json({id: MESSAGE_ID, threadId: "def456", internalDate: "1", raw});
      }
      return json({
        id: MESSAGE_ID, threadId: "def456", internalDate: "1", labelIds: ["INBOX"],
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            {name: "From", value: "sender@example.com"}, {name: "To", value: "owner@example.com"},
            {name: "Subject", value: "Scans"}, {name: "Message-ID", value: "<abc123@example.com>"},
          ],
          parts: [
            {partId: "0", mimeType: "text/plain", body: {size: 2, data: "aGk"}},
            ...parts.map(({filename, mimeType, bytes}, i) => ({
              partId: String(i + 1), mimeType, filename,
              headers: [{name: "Content-Disposition", value: `attachment; filename="${filename}"`}],
              body: {attachmentId: `att${i}`, size: bytes.byteLength},
            })),
          ],
        },
      });
    }
    const part = parts[Number(new RegExp(`^/messages/${MESSAGE_ID}/attachments/att(\\d+)$`).exec(path)?.[1])];
    if (!part || url.searchParams.get("fields") !== "data") throw new Error(`Unexpected request: ${url}`);
    if (gmail.opened.length > 0 && gmail.holdReopens) {
      const gate = gmail.holdReopens;
      await vi.waitFor(() => expect(gate.released).toBe(true), {timeout: 10_000, interval: 5});
    }
    const opened: Opened = {read: 0, ended: false, cancelled: false};
    gmail.opened.push(opened);
    const body = encoder.encode(JSON.stringify({size: part.bytes.byteLength, data: base64Url(part.bytes)}));
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (opened.read === gmail.stallAt) return new Promise<void>(() => {});
        if (opened.read < body.byteLength) {
          controller.enqueue(body.subarray(opened.read, opened.read += 1024));
        } else {
          opened.ended = true;
          controller.close();
        }
      },
      cancel() { opened.cancelled = true; },
    }, {highWaterMark: 0}), {headers: {"Content-Type": "application/json"}});
  });
  return gmail;
}

/** Whether every answer to attachments.get was let go: read to its end, or cancelled. */
function allLetGo(gmail: {opened: Opened[]}): boolean {
  return gmail.opened.every(({ended, cancelled}) => ended || cancelled);
}

/**
 * A whole-mailbox Gmail binding on a connected account, with a session's approval queue. Each
 * operation runs in a session of its own, which is disposed, with every capability the operation
 * made, as the operation returns.
 */
async function gmailBinding() {
  const name = `gmail-pdf-test-${crypto.randomUUID()}`;
  const hook = testEnv.TestHooks.get(testEnv.TestHooks.idFromName(name));
  const accountId = testEnv.UserAccount.idFromName(name);
  await runInDurableObject(testEnv.UserAccount.get(accountId), (_instance: unknown, state: DurableObjectState) => {
    state.storage.kv.put("refreshToken", "owner-refresh");
    state.storage.kv.put("accessToken", {token: "owner-token", expires: new Date(Date.now() + 3_600_000)});
  });
  const props: GmailGatekeeperImplProps = {userObjectId: accountId.toString()};
  const facet = {facetName: `gmail-${name}`, id: testEnv.GmailGatekeeperImpl.idFromName(name).toString(), props};
  const queueId = `queue-${name}`;
  await hook.startSession(facet.facetName, facet.id, props, queueId);
  // Not the call's own promise, which a matcher that looks at it would make calls of.
  const run = async (operation: string, args: unknown[] = []) =>
    hook.runSessionOperation(facet.facetName, facet.id, props, queueId, operation, args);
  const queue = () => runInDurableObject(hook, (instance: TestHooks) => instance.readQueue(queueId));
  return {
    hook, facet, run,
    /** The PDF text of an attachment, the message's first unless told, with its capability disposed. */
    readPdf: (operation = "message.readPdf", id = MESSAGE_ID, index = 0) =>
      run(operation, [id, index]) as Promise<GmailPdfText>,
    /** What each read of an attachment's bytes for its PDF text was reported as, in order. */
    reads: async (): Promise<string[]> =>
      ((await queue()).observations as {title: string; description: string}[])
        .filter(({title}) => title === TITLE).map(({description}) => description),
    /**
     * How many operations' queue stubs have been let go, with every copy made of them: one for
     * each operation that has ended and left nothing holding the approval queue.
     */
    letGo: async (): Promise<number> => (await queue()).disposals,
    refuseNextRead: () => hook.failNextObservation(queueId, TITLE),
  };
}

const text = (pdf: GmailPdfText) => new Response(pdf.text).text();

let renderLimit: number;
let firstReadIdleMs: number;

beforeEach(() => {
  renderLimit = RENDER_LIMITS.fileBytes;
  firstReadIdleMs = PDF_FIRST_READ.idleMs;
});

afterEach(() => {
  RENDER_LIMITS.fileBytes = renderLimit;
  PDF_FIRST_READ.idleMs = firstReadIdleMs;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a PDF attachment read through a Gmail binding", () => {
  it("returns the text of a PDF that has text, read from Gmail once", async () => {
    const gmail = installGmail([pdfPart(TEXT_PDF)]);
    const binding = await gmailBinding();

    const result = await binding.readPdf();
    expect(Object.keys(result).toSorted()).toEqual(["hasText", "text", "transcribed"]);
    expect(result).toMatchObject({hasText: true, transcribed: false});
    expect(await text(result)).toBe("### Page 1\nCover sheet of the ledger\n");

    expect(await binding.reads()).toEqual([FIRST_READ]);
    expect(gmail.opened).toMatchObject([{ended: true, cancelled: false}]);
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));
  });

  it("renders a scan through the renderer Worker the gatekeeper is bound to, and reads it in bands", async () => {
    const gmail = installGmail([pdfPart(FAX_SCAN)]);
    const binding = await gmailBinding();

    const result = await binding.readPdf();
    expect(result).toMatchObject({hasText: false, transcribed: true});
    const [heading, ...bands] = (await text(result)).split("\n");
    expect(heading).toBe("### Page 1");
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.every(band => band === MODEL_TEXT)).toBe(true);

    // The attachment was read again, whole, as a read of its own.
    expect(await binding.reads()).toEqual([FIRST_READ, WHOLE_READ]);
    expect(gmail.opened).toHaveLength(2);
    await vi.waitFor(() => expect(allLetGo(gmail)).toBe(true));
  });

  it("reads the page without text of a PDF that has text from its image, into the PDF's own text", async () => {
    const gmail = installGmail([pdfPart(MIXED_PDF)]);
    const binding = await gmailBinding();

    const result = await binding.readPdf();
    expect(result).toMatchObject({hasText: true, transcribed: false});
    const [own, read] = (await text(result)).split(`${READ_FROM_IMAGE}\n\n`);
    expect(own).toBe("### Page 1\nCover sheet of the ledger\n\n\n\n### Page 2\n");
    const bands = read!.trimEnd().split("\n");
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.every(band => band === MODEL_TEXT)).toBe(true);

    expect(await binding.reads()).toEqual([FIRST_READ, WHOLE_READ]);
    expect(gmail.opened).toHaveLength(2);
  });

  it("reads a scan too large to render as it is stored, in one more pass over a message's attachment", async () => {
    const gmail = installGmail([pdfPart(JPEG_SCAN.bytes)]);
    tooLargeToRender();
    const binding = await gmailBinding();

    const result = await binding.readPdf();
    expect(result).toMatchObject({hasText: false, transcribed: true});
    expect(await text(result)).toBe(JPEG_SCAN_TEXT);

    // Both page images came from one answer of Gmail's, which was let go short of its end.
    expect(await binding.reads()).toEqual([FIRST_READ, STORED_READ]);
    await vi.waitFor(() => expect(gmail.opened).toMatchObject([
      {ended: true, cancelled: false}, {ended: false, cancelled: true},
    ]));
  });

  it("reads a pending message's and a draft's attachment as stored, each in one more pass", async () => {
    installGmail();
    tooLargeToRender();
    const upload = {filename: "scan.pdf", mimeType: "application/pdf", content: JPEG_SCAN.bytes.slice().buffer};

    const pending = await gmailBinding();
    const sent = await pending.run("session.send", [["bob@example.com"], "Scans", "Attached.", {attachments: [upload]}]);
    expect(await text(await pending.readPdf("message.readPdf", sent as string))).toBe(JPEG_SCAN_TEXT);
    expect(await pending.reads()).toEqual([FIRST_READ, STORED_READ]);

    const drafted = await gmailBinding();
    const draft = await drafted.run("session.createDraft", [{
      to: ["bob@example.com"], subject: "Scans", text: "Attached.", attachments: [upload],
    }]) as GmailDraftInfo;
    expect(await text(await drafted.readPdf("draft.readPdf", draft.id))).toBe(JPEG_SCAN_TEXT);
    expect(await drafted.reads()).toEqual([FIRST_READ, STORED_READ]);
  });

  it("refuses a part over the upload limit that a forward copied from its source, on the pending message and the draft", async () => {
    // A forward is limited only as a whole message, so a part of it can be larger than an upload.
    const bytes = new Uint8Array(MAX_GMAIL_ATTACHMENT_BYTES + 1);
    bytes.set(TEXT_PDF);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    installGmail([], buildEncodedEmail({
      from: "sender@example.com", to: ["owner@example.com"], cc: [], bcc: [], subject: "Scans", text: "hi",
      messageId: "<abc123@example.com>",
      attachments: [{filename: "scan.pdf", contentType: "application/pdf", data: btoa(binary), description: "scan.pdf"}],
    }));
    const refused = `This attachment exceeds the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe limit ` +
      "for a PDF read from a pending message or a draft.";

    const pending = await gmailBinding();
    const sent = await pending.run("message.forward", [MESSAGE_ID, ["bob@example.com"], "See attached."]);
    await expect(pending.readPdf("message.readPdf", sent as string)).rejects.toThrow(refused);
    expect(await pending.reads()).toEqual([]);

    const drafted = await gmailBinding();
    const draft = await drafted.run(
      "message.createForwardDraft", [MESSAGE_ID, ["bob@example.com"], "See attached."]) as GmailDraftInfo;
    await expect(drafted.readPdf("draft.readPdf", draft.id)).rejects.toThrow(refused);
    expect(await drafted.reads()).toEqual([]);
  }, 30_000);

  it("refuses a part that is not a PDF before anything of it is fetched", async () => {
    const gmail = installGmail([
      {filename: "notes.txt", mimeType: "text/plain", bytes: TEXT_PDF},
      // A PDF by its name alone, and by its type alone, whatever their case.
      {filename: "Scan.PDF", mimeType: "application/octet-stream", bytes: TEXT_PDF},
      {filename: "scan", mimeType: "Application/PDF; name=scan", bytes: TEXT_PDF},
    ]);
    const binding = await gmailBinding();

    await expect(binding.readPdf("message.readPdf", MESSAGE_ID, 0)).rejects.toThrow("This attachment is not a PDF.");
    expect(gmail.opened).toEqual([]);
    expect(await binding.reads()).toEqual([]);
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));

    expect(await text(await binding.readPdf("message.readPdf", MESSAGE_ID, 1))).toContain("Cover sheet");
    expect(await text(await binding.readPdf("message.readPdf", MESSAGE_ID, 2))).toContain("Cover sheet");
  });

  it("returns nothing, and leaves nothing open, when the report of the read is refused", async () => {
    const gmail = installGmail([pdfPart(JPEG_SCAN.bytes)]);
    tooLargeToRender();
    const binding = await gmailBinding();

    await binding.refuseNextRead();
    await expect(binding.readPdf()).rejects.toThrow(DENIED);
    expect(await binding.reads()).toEqual([FIRST_READ]);
    // Gmail's answer was read to its end, and the hold on the queue was let go.
    expect(gmail.opened).toMatchObject([{ended: true, cancelled: false}]);
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));
  });

  it("gives the attachment up, reporting nothing and holding nothing, when Gmail stops sending it while it is converted", async () => {
    const gmail = installGmail([pdfPart(TEXT_PDF)]);
    gmail.stallAt = 1024;
    PDF_FIRST_READ.idleMs = 50;
    const binding = await gmailBinding();

    await expect(binding.readPdf()).rejects.toThrow(
      "The attachment stopped arriving while it was being read; read it again.");
    expect(await binding.reads()).toEqual([]);
    expect(gmail.opened).toMatchObject([{read: 1024, ended: false, cancelled: true}]);
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));
  });

  it("reports the read before it refuses to transcribe a scan, which says what the attachment holds", async () => {
    const gmail = installGmail([pdfPart(FAX_SCAN)]);
    // A scan stored as fax is not read as it is stored, so one too large to render is refused.
    RENDER_LIMITS.fileBytes = FAX_SCAN.byteLength - 1;
    const binding = await gmailBinding();

    await expect(binding.readPdf()).rejects.toThrow(/^The PDF has no text of its own, and .* so it cannot be transcribed\.$/);
    expect(await binding.reads()).toEqual([FIRST_READ]);
    // Where the read may not be reported, the refusal is not given either.
    await binding.refuseNextRead();
    await expect(binding.readPdf()).rejects.toThrow(DENIED);
    expect(gmail.opened).toMatchObject([{ended: true, cancelled: false}, {ended: true, cancelled: false}]);
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(2));
  });

  it("reports each later read of the attachment before using it, and fails the text when one is refused", async () => {
    const gmail = installGmail([pdfPart(JPEG_SCAN.bytes)]);
    tooLargeToRender();
    const gate: Gate = {released: false};
    gmail.holdReopens = gate;
    const binding = await gmailBinding();

    const result = await binding.readPdf();
    await binding.refuseNextRead();
    gate.released = true;
    // A stream that failed on the other side of an RPC does not say what with.
    await expect(text(result)).rejects.toThrow();

    // The read was shown to the queue, which refused it: the answer Gmail had begun was let go
    // with nothing of it read, and with the text the hold on the queue.
    expect(await binding.reads()).toEqual([FIRST_READ, STORED_READ]);
    await vi.waitFor(() => expect(gmail.opened).toMatchObject([
      {ended: true, cancelled: false}, {read: 0, ended: false, cancelled: true},
    ]));
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));
  });

  it("reports the read before it returns, and holds the approval queue for a text that reads the attachment again until the text ends", async () => {
    const gmail = installGmail([pdfPart(JPEG_SCAN.bytes)]);
    tooLargeToRender();
    const gate: Gate = {released: false};
    gmail.holdReopens = gate;
    const binding = await gmailBinding();

    // The operation has returned, and disposed its session, its capabilities and its queue stub.
    // Only the first read has been made, and it was reported.
    const result = await binding.readPdf();
    expect(await binding.reads()).toEqual([FIRST_READ]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await binding.letGo()).toBe(0);

    // The read the text makes now is still reported, through the queue the text holds.
    gate.released = true;
    expect(await text(result)).toBe(JPEG_SCAN_TEXT);
    expect(await binding.reads()).toEqual([FIRST_READ, STORED_READ]);
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));
  });

  it("lets the approval queue and Gmail's answer go when the text is cancelled partway", async () => {
    const gmail = installGmail([pdfPart(JPEG_SCAN.bytes)]);
    tooLargeToRender();
    const binding = await gmailBinding();

    // What is cancelled is a text whose first page the model has begun to answer.
    expect(await binding.run("message.cancelPdf", [MESSAGE_ID, 0])).toBe("### Page 1\n");
    await vi.waitFor(async () => expect(await binding.letGo()).toBe(1));
    expect(gmail.opened).toMatchObject([{ended: true, cancelled: false}, {ended: false, cancelled: true}]);
    // The second page image was never read: its end lies further into Gmail's answer than was read.
    const {offset, length} = JPEG_SCAN.images[1]!;
    expect(gmail.opened[1]!.read).toBeLessThan(Math.floor((offset + length) / 3) * 4);
  });

  it("fails a draft attachment's text at its next read once the attachment has left the draft", async () => {
    installGmail();
    tooLargeToRender();
    const binding = await gmailBinding();
    // The gatekeeper logs each conversion, and shares the tests' console.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const conversions = () => info.mock.calls
      .filter(([line]) => (line as {event?: string}).event === "google.gmail.pdf.converted").length;
    const stale = {error: "This draft attachment capability became stale after the attachment changed."};
    const input = {
      to: ["bob@example.com"], subject: "Scans", text: "Attached.",
      attachments: [{filename: "scan.pdf", mimeType: "application/pdf", content: JPEG_SCAN.bytes.slice().buffer}],
    };

    const asked = await binding.run("session.createDraft", [input]) as GmailDraftInfo;
    expect(await binding.run("draft.readPdfAcrossRemoval", [asked.id, 0, true])).toEqual(stale);
    // The text was converted and reported before the attachment left; its next read was not.
    expect(await binding.reads()).toEqual([FIRST_READ]);
    expect(conversions()).toBe(1);

    // A text asked of a capability that is stale already is refused before anything is converted.
    const unasked = await binding.run("session.createDraft", [input]) as GmailDraftInfo;
    expect(await binding.run("draft.readPdfAcrossRemoval", [unasked.id, 0])).toEqual(stale);
    expect(await binding.reads()).toEqual([FIRST_READ]);
    expect(conversions()).toBe(1);
  });

  it("is read by a hook from the message it is delivered", async () => {
    const gmail = installGmail([pdfPart(JPEG_SCAN.bytes)]);
    tooLargeToRender();
    const {hook, facet} = await gmailBinding();

    expect(await hook.gmailDeliverPdf(facet, MESSAGE_ID)).toBe(JPEG_SCAN_TEXT);
    const {observations} = await runInDurableObject(hook, (instance: TestHooks) => instance.readGmailHook());
    expect(observations.filter(({title}) => title === TITLE)).toHaveLength(2);
    expect(gmail.opened).toHaveLength(2);
  });
});
