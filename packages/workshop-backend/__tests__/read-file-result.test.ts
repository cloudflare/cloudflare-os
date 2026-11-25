import { describe, expect, it } from "vitest";
import { MAX_TOOL_RESULT_CHARS } from "../src/agent";
import { MAX_INLINE_ATTACHMENT_BYTES } from "../src/chat-attachment-validation";
import { BlobReader, BlobWriter, type ChunkStore } from "../src/git-chunked-blob";
import { encodeLooseObject } from "../src/git-codec";
import type { ReadFileWindow } from "../src/line-window";
import { MAX_READ_FILE_IMAGE_EDGE, readFileResult } from "../src/read-file-result";
import type { GitObjectRecord } from "../src/storage-schema/overseer-storage";

// A blob source over an in-memory chunk store, chunked as the git store stores it.
function blob(bytes: Uint8Array) {
  let rows = new Map<string, GitObjectRecord>();
  let store: ChunkStore = { get: oid => rows.get(oid), put: record => rows.set(record.oid, record) };
  let writer = new BlobWriter(store, bytes.length);
  writer.write(bytes);
  let pending = writer.finish();
  let record: GitObjectRecord = pending.record ??
      { oid: pending.oid, data: encodeLooseObject("blob", pending.payload) };
  rows.set(record.oid, record);
  return { kind: "blob" as const, reader: BlobReader.open(store, record) };
}

// A PNG signature and IHDR chunk header giving the dimensions, padded to `size` bytes: enough
// for the header parser, which never decodes pixels.
function png(width: number, height: number, size = 64): Uint8Array {
  let bytes = new Uint8Array(size);
  let view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const render = (source: Parameters<typeof readFileResult>[0], path: string,
                window: ReadFileWindow = {}) =>
  readFileResult(source, window, path, MAX_TOOL_RESULT_CHARS);
const read = (...args: Parameters<typeof render>) => render(...args).content;

describe("readFileResult", () => {
  it("shows a stored image as itself, after a line giving its type and size", () => {
    let bytes = png(640, 480);
    expect(render(blob(bytes), "out/chart.PNG")).toEqual({
      content: [
        { type: "text", text: "out/chart.PNG: image/png, 640x480 pixels" },
        { type: "image", data: bytes.toBase64(), mimeType: "image/png" },
      ],
      imageBytes: 64,
    });
  });

  it("shows a chunked image whole", () => {
    let bytes = png(100, 100, 3 * 1024 * 1024);
    bytes.fill(1, 64);
    let [, image] = read(blob(bytes), "big.png");
    expect(image).toEqual({ type: "image", data: bytes.toBase64(), mimeType: "image/png" });
  });

  it("tells an image by its content, whatever its name, and reads anything else as text", () => {
    let bytes = png(10, 10);
    expect(read(blob(bytes), "screenshot")).toHaveLength(2);
    let text = new TextEncoder().encode("not really a picture\n");
    expect(render(blob(text), "fake.png"))
        .toEqual({ content: [{ type: "text", text: "not really a picture\n" }] });
    expect(read({ kind: "text", text: "plain" }, "notes.png")).toEqual([{ type: "text", text: "plain" }]);
  });

  it("refuses a line window, a model that can't view images, and an unreadable header", () => {
    let bytes = png(10, 10);
    expect(() => read(blob(bytes), "chart.png", { startLine: 1 }))
        .toThrow("chart.png is an image, which has no lines: omit startLine and lineCount to view it.");
    expect(() => readFileResult(blob(bytes), {}, "chart.png", MAX_TOOL_RESULT_CHARS, false))
        .toThrow("chart.png is an image, which this model can't view.");
    expect(() => read(blob(bytes.slice(0, 16)), "cut.png"))
        .toThrow("cut.png begins like an image (image/png), but its header is unreadable.");
  });

  it("refuses an image over the pixel or byte bounds, saying which", () => {
    let edge = MAX_READ_FILE_IMAGE_EDGE;
    expect(read(blob(png(edge, edge)), "ok.png")).toHaveLength(2);
    expect(() => read(blob(png(edge + 1, 10)), "wide.png"))
        .toThrow(`wide.png is a ${edge + 1}x10 image, too large to view`);
    expect(() => read(blob(png(10, 10, MAX_INLINE_ATTACHMENT_BYTES + 1)), "heavy.png"))
        .toThrow(`heavy.png is ${MAX_INLINE_ATTACHMENT_BYTES + 1} bytes, too large to view as an image`);
  });
});
