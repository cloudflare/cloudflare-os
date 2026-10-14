import { describe, expect, it } from "vitest";
import { RpcStub } from "cloudflare:workers";
import { CodeModeOutputImpl } from "../src/overseer.js";

function png(width = 1, height = 1): Uint8Array {
  let data = Uint8Array.of(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0, 0, 0, 0, 0,
  );
  let view = new DataView(data.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return data;
}

const PNG = png();
const JPEG = Uint8Array.of(
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 0, 2, 0, 3, 0, 0, 0, 0,
);
const WEBP = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
);

describe("code mode image output", () => {
  it("accepts supported image signatures and returns a defensive copy", () => {
    const output = new CodeModeOutputImpl();
    const png = PNG.slice();
    output.image(png, "image/png");
    output.image(JPEG, "image/jpeg");
    output.image(WEBP, "image/webp");
    png[0] = 0;

    const images = output.takeImages();
    expect(images.map(image => image.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    expect(images[0].data).toEqual(PNG);
    images.length = 0;
    expect(output.takeImages()).toHaveLength(3);
  });

  it("does not expose the host image accessor over RPC", async () => {
    const output = new CodeModeOutputImpl();
    output.image(PNG, "image/png");
    using stub = new RpcStub(output);

    let error: unknown;
    try {
      await (stub as unknown as {takeImages(): Promise<unknown>}).takeImages();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("does not implement the method \"takeImages\"");
    expect(output.takeImages()).toHaveLength(1);
  });

  it("rejects an image whose bytes do not match its declared type", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image(PNG, "image/jpeg"))
      .toThrow("image bytes do not match their MIME type");
  });

  it("rejects an image beyond the provider's absolute dimension limit", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image(png(1280, 9000), "image/png"))
      .toThrow("dimensions 1280 x 9000 exceed 8000px per axis");
    expect(output.takeImages()).toEqual([]);
  });

  it("rejects unsupported media types", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image(PNG, "image/gif"))
      .toThrow("unsupported image type");
  });

  it("rejects string data instead of decoding base64 at the capability boundary", () => {
    const output = new CodeModeOutputImpl();
    expect(() => output.image("iVBORw0KGgo=" as unknown as Uint8Array, "image/png"))
      .toThrow("must be a Uint8Array");
  });

  it("bounds the image count", () => {
    const output = new CodeModeOutputImpl();
    for (let i = 0; i < 4; i++) output.image(PNG, "image/png");
    expect(() => output.image(PNG, "image/png"))
      .toThrow("at most 4 images");
  });

  it("rejects payloads larger than the aggregate byte budget", () => {
    const output = new CodeModeOutputImpl();
    const oversized = new Uint8Array(6 * 1024 * 1024 + 1);
    oversized.set(PNG);
    expect(() => output.image(oversized, "image/png"))
      .toThrow("exceeds 6 MiB");
  });
});
