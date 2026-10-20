import { afterEach, describe, expect, it, vi } from "vitest";
import { type AiFetcher, MAX_PDF_TEXT_CHARS, pdfMarkdown, pdfToText } from "../src/drive-pdf";

// What Workers AI's toMarkdown returned for generated PDFs with metadata off and images unconverted.
/** A three-page text PDF, its opening, a page break, and its end. */
const TEXT_PDF =
  "# file.pdf\n## Contents\n### Page 1\nChapter 1: Probe heading\n" +
  "Page 1 line 1: the quick brown fox jumps over the lazy dog.\n" +
  "Page 1 line 61: the quick brown fox jumps over the lazy dog.\n\n\n\n" +
  "### Page 2\nPage 1 line 62: the quick brown fox jumps over the lazy dog.\n\n";
/** An image-only PDF: one page with no text layer. */
const SCANNED_PDF = "# file.pdf\n## Contents\n### Page 1\n\n\n";
/** A 15 MB PDF holding one line of text and one large image. */
const LARGE_PDF = "# file.pdf\n## Contents\n### Page 1\nLarge file probe text\n\n";

const PROVIDER_ERROR = "Invalid PDF: Invalid PDF structure.";
const CONVERSION_FAILED = "Google Drive's file could not be converted from PDF.";

const TO_MARKDOWN_URL = "https://workers-binding.ai/to-everything/markdown/transformer";
const OPTIONS = { conversionOptions: { pdf: { metadata: false, images: { convert: false } } } };

type Sent = { url: string; init: RequestInit; json: { files: { name: string; mimeType: string; data: string }[]; options: unknown } };

/** `bytes` as a stream that hands them out in chunks of the given sizes, cycling. */
function pdfStream(bytes: Uint8Array, sizes: number[] = [bytes.byteLength || 1]) {
  let offset = 0, turn = 0;
  let state = { cancelled: false };
  let stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      let size = sizes[turn++ % sizes.length]!;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

/** A response whose body streams `text` out `size` bytes at a time. */
function streamedResponse(text: string, size = 7, status = 200) {
  let bytes = new TextEncoder().encode(text);
  return new Response(pdfStream(bytes, [size]).stream, {
    status, headers: { "Content-Type": "application/json" },
  });
}

function conversionJson(result: Record<string, unknown>): string {
  return JSON.stringify({
    result: [{ id: "conversion-1", name: "file.pdf", mimeType: "application/pdf", ...result }],
    success: true,
  });
}

function markdownJson(data: string, format = "markdown"): string {
  return conversionJson({ format, tokens: 9, data });
}

/**
 * A fake binding: reads the request body the way the service does, then answers. A body that
 * errors while being read makes `fetch` reject, as the real one does.
 */
function fakeAi(answer: Response | Error | ((sent: Sent) => Response)) {
  let sent: Sent[] = [];
  let ai = {
    fetch: async (url: string, init: RequestInit) => {
      let json = JSON.parse(await new Response(init.body).text()) as Sent["json"];
      let request = { url, init, json };
      sent.push(request);
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(request) : answer;
    },
  } as unknown as AiFetcher;
  return { ai, sent };
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}

/** 1,000 bytes covering every byte value, so base64 framing errors show. */
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pdfMarkdown", () => {
  it("drops the file heading and contents line and keeps page headings", () => {
    expect(pdfMarkdown(TEXT_PDF)).toEqual({
      markdown:
        "### Page 1\nChapter 1: Probe heading\n" +
        "Page 1 line 1: the quick brown fox jumps over the lazy dog.\n" +
        "Page 1 line 61: the quick brown fox jumps over the lazy dog.\n\n\n\n" +
        "### Page 2\nPage 1 line 62: the quick brown fox jumps over the lazy dog.",
      hasText: true,
      truncated: false,
    });
  });

  it("finds no text in a PDF whose pages hold only their headings", () => {
    expect(pdfMarkdown(SCANNED_PDF)).toEqual({ markdown: "", hasText: false, truncated: false });
    expect(pdfMarkdown("# file.pdf\n## Contents\n### Page 1\n\n\n\n\n### Page 2\n\n"))
      .toEqual({ markdown: "", hasText: false, truncated: false });
  });

  it("keeps a large PDF's one line of text", () => {
    expect(pdfMarkdown(LARGE_PDF))
      .toEqual({ markdown: "### Page 1\nLarge file probe text", hasText: true, truncated: false });
  });

  it("keeps output that does not open with the expected preamble", () => {
    let data = "# Quarterly Report.pdf\n## Contents\n### Page 1\nRevenue\n";
    expect(pdfMarkdown(data)).toEqual({ markdown: data.trim(), hasText: true, truncated: false });
  });

  it("counts a line that only resembles a page heading as text", () => {
    expect(pdfMarkdown("# file.pdf\n## Contents\n### Page 1\n### Page one\n").hasText).toBe(true);
  });

  it("cuts text over the limit and says so", () => {
    let page = "### Page 1\n";
    let text = pdfMarkdown(`# file.pdf\n## Contents\n${page}${"a".repeat(MAX_PDF_TEXT_CHARS)}`);
    expect(text.truncated).toBe(true);
    expect(text.markdown).toHaveLength(MAX_PDF_TEXT_CHARS);
    expect(text.markdown.startsWith(page)).toBe(true);
  });

  it("calls text it stopped reading truncated even when what it read held only headings", () => {
    expect(pdfMarkdown("# file.pdf\n## Contents\n### Page 1\n\n\n\n### Page 2\n", true))
      .toEqual({ markdown: "", hasText: false, truncated: true });
  });

  it("keeps text exactly at the limit whole", () => {
    let body = "a".repeat(MAX_PDF_TEXT_CHARS);
    expect(pdfMarkdown(body)).toEqual({ markdown: body, hasText: true, truncated: false });
  });

  it("never cuts a surrogate pair in half", () => {
    // The pair straddles the limit: its high half is the last character that would fit.
    let body = `${"a".repeat(MAX_PDF_TEXT_CHARS - 1)}😀tail`;
    let text = pdfMarkdown(body);
    expect(text.truncated).toBe(true);
    expect(text.markdown).toBe("a".repeat(MAX_PDF_TEXT_CHARS - 1));

    let whole = `${"a".repeat(MAX_PDF_TEXT_CHARS - 2)}😀tail`;
    expect(pdfMarkdown(whole).markdown).toBe(`${"a".repeat(MAX_PDF_TEXT_CHARS - 2)}😀`);
  });
});

describe("pdfToText", () => {
  it("streams the PDF to the conversion service under a fixed name with metadata and images off", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));
    // Chunk sizes that leave 0, 1 and 2 bytes over a 3-byte base64 group.
    let { stream } = pdfStream(BYTES, [1, 2, 4, 5, 64, 3]);

    await expect(pdfToText(ai, undefined, stream))
      .resolves.toEqual({ markdown: "### Page 1\nLarge file probe text", hasText: true, truncated: false });

    expect(sent).toHaveLength(1);
    let [{ url, init, json }] = sent;
    expect(url).toBe(TO_MARKDOWN_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(json.files).toHaveLength(1);
    expect(json.files[0]!.name).toBe("file.pdf");
    expect(json.files[0]!.mimeType).toBe("application/pdf");
    expect(decodeBase64(json.files[0]!.data)).toEqual(BYTES);
    expect(json.options).toEqual(OPTIONS);
  });

  it("streams a PDF that arrives one byte at a time", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));
    await pdfToText(ai, undefined, pdfStream(BYTES, [1]).stream);
    expect(decodeBase64(sent[0]!.json.files[0]!.data)).toEqual(BYTES);
  });

  it("encodes an empty and a one-byte PDF", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let bytes of [new Uint8Array(), Uint8Array.of(0xff)]) {
      let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));
      await pdfToText(ai, undefined, pdfStream(bytes).stream);
      expect(decodeBase64(sent[0]!.json.files[0]!.data)).toEqual(bytes);
    }
  });

  it("routes through the named AI Gateway only when one is set", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let { ai, sent } = fakeAi(() => streamedResponse(markdownJson(LARGE_PDF)));

    await pdfToText(ai, "instance-gateway", pdfStream(BYTES).stream);
    await pdfToText(ai, "", pdfStream(BYTES).stream);

    expect(sent[0]!.json.options).toEqual({ gateway: { id: "instance-gateway" }, ...OPTIONS });
    expect(sent[1]!.json.options).toEqual(OPTIONS);
  });

  it("decodes escapes and multi-byte characters split anywhere in the response", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // The response as it is on the wire: JSON escapes, \u escapes (one a surrogate pair), and raw
    // multi-byte UTF-8, which chunks of 1-3 bytes split mid-character.
    let data = String.raw`# file.pdf\n## Contents\n### Page 1\nQuote \" slash \\ \/ tab\t café \u00e9 😀 \ud83d\ude00 end\n`;
    let json = `{"result":[{"id":"c","format":"markdown","tokens":1,"data":"${data}"}],"success":true}`;
    for (let size of [1, 2, 3, 5]) {
      let { ai } = fakeAi(streamedResponse(json, size));
      let result = await pdfToText(ai, undefined, pdfStream(BYTES).stream);
      expect(result.markdown).toBe('### Page 1\nQuote " slash \\ / tab\t café é 😀 😀 end');
    }
  });

  it("reads only the fields of the first result, wherever they fall", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let json = JSON.stringify({
      data: "top-level data",
      result: [
        { meta: { data: "nested", format: "error" }, data: "# file.pdf\n## Contents\n### Page 1\nReal\n", tokens: 3, format: "markdown" },
        { format: "error", error: "second result", data: "other" },
      ],
      success: true,
    });
    let { ai } = fakeAi(streamedResponse(json, 4));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream))
      .resolves.toEqual({ markdown: "### Page 1\nReal", hasText: true, truncated: false });
  });

  it("stops reading a response past the text limit and marks the text truncated", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let head = '{"result":[{"id":"c","format":"markdown","tokens":1,"data":"# file.pdf\\n## Contents\\n### Page 1\\n';
    let line = "a".repeat(1023) + "\\n";
    let lines = Math.ceil((MAX_PDF_TEXT_CHARS * 3) / 1024);
    let produced = 0, cancelled = false;
    let encoder = new TextEncoder();
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === 0) controller.enqueue(encoder.encode(head));
        else if (produced <= lines) controller.enqueue(encoder.encode(line));
        else {
          controller.enqueue(encoder.encode('"}],"success":true}'));
          controller.close();
        }
        produced++;
      },
      cancel() { cancelled = true; },
    });
    let { ai } = fakeAi(new Response(body));

    let text = await pdfToText(ai, undefined, pdfStream(BYTES).stream);

    expect(text.truncated).toBe(true);
    expect(text.hasText).toBe(true);
    expect(text.markdown).toHaveLength(MAX_PDF_TEXT_CHARS);
    expect(text.markdown.startsWith("### Page 1\naaa")).toBe(true);
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(lines / 2);
  });

  it("accepts plain-text output", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let { ai } = fakeAi(streamedResponse(markdownJson("Plain words", "text")));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream))
      .resolves.toEqual({ markdown: "Plain words", hasText: true, truncated: false });
  });

  it("logs a conversion's sizes, never its text", async () => {
    let info = vi.spyOn(console, "info").mockImplementation(() => {});
    let { ai } = fakeAi(streamedResponse(markdownJson(TEXT_PDF)));

    let text = await pdfToText(ai, undefined, pdfStream(BYTES, [100]).stream);

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.converted", pdfBytes: BYTES.byteLength,
      textChars: text.markdown.length, hasText: true, truncated: false,
    }));
    let logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("Probe heading");
    expect(logged).not.toContain("quick brown fox");
  });

  it("reports a scanned PDF as having no text", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let { ai } = fakeAi(streamedResponse(markdownJson(SCANNED_PDF)));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream))
      .resolves.toEqual({ markdown: "", hasText: false, truncated: false });
  });

  it("fails in its own words when Workers AI cannot convert the file", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let { ai } = fakeAi(streamedResponse(conversionJson({ format: "error", error: PROVIDER_ERROR })));

    let error = await pdfToText(ai, undefined, pdfStream(BYTES).stream).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.failed", pdfBytes: BYTES.byteLength,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PROVIDER_ERROR);
  });

  it("fails in its own words on an HTTP error, logging its status and code but not its body", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let { ai } = fakeAi(streamedResponse(
      '{"errors":[{"message":"Error converting to markdown","code":6006}],"success":false}', 7, 400));

    let error = await pdfToText(ai, undefined, pdfStream(BYTES).stream).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.failed", httpStatus: 400, providerCode: 6006,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Error converting");
  });

  it("fails in its own words when the binding throws", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let { ai } = fakeAi(new Error("6006: Error converting to markdown"));

    let error = await pdfToText(ai, undefined, pdfStream(BYTES).stream).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect((error as Error).message).not.toContain("6006");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });

  it("fails on a response that ends before its JSON does", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let json = markdownJson(TEXT_PDF);
    let { ai } = fakeAi(streamedResponse(json.slice(0, json.length - 10)));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream)).rejects.toThrow(CONVERSION_FAILED);
  });

  it("treats an unknown output format as a failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let { ai } = fakeAi(streamedResponse(markdownJson("text", "html")));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream)).rejects.toThrow(CONVERSION_FAILED);
  });

  it.each([
    ["the binding throws mid-upload", "throw"],
    ["the service answers an error before reading the PDF", "answer"],
  ])("releases the download when %s", async (_label, outcome) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let { stream, state } = pdfStream(BYTES, [10]);
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        let reader = (init.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.read();
        // The request keeps the body locked, as a real fetch does while it runs.
        if (outcome === "throw") throw new Error("binding failed");
        return streamedResponse('{"errors":[{"code":429}]}', 7, 429);
      },
    } as unknown as AiFetcher;

    await expect(pdfToText(ai, undefined, stream)).rejects.toThrow(CONVERSION_FAILED);
    expect(state.cancelled).toBe(true);
  });

  it("throws the PDF stream's own error, such as the size limit, as it is", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let tooLarge = new Error("This file is larger than the 20 MB limit for reading it.");
    let sentChunk = false;
    let pdf = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentChunk) throw tooLarge;
        sentChunk = true;
        controller.enqueue(BYTES);
      },
    });
    let { ai } = fakeAi(streamedResponse(markdownJson(TEXT_PDF)));

    await expect(pdfToText(ai, undefined, pdf)).rejects.toBe(tooLarge);
    expect(warn).not.toHaveBeenCalled();
  });
});
