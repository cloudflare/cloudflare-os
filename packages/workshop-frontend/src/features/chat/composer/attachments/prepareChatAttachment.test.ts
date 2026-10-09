// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  prepareChatAttachment,
} from "./prepareChatAttachment";

const OVER_LIMIT = MAX_CHAT_ATTACHMENT_BYTES + 1;
const png = new File(["png"], "photo.png", { type: "image/png" });

// Stands in for a 4000x3000 PNG whose encoded size per requested type `encode` decides.
const stubCanvas = (encode: (type: string) => { size: number; type: string }) => {
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000, close() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback, type = "image/png") => callback(encode(type) as Blob),
  );
};

describe("prepareChatAttachment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a supported non-image attachment unchanged", async () => {
    const file = new File(["report"], "report.txt", { type: "text/plain" });

    await expect(prepareChatAttachment(file)).resolves.toEqual({
      blob: file,
      mimeType: "text/plain",
    });
  });

  it("rejects a non-image attachment above the upload limit", async () => {
    const file = new File(
      [new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES + 1)],
      "large.bin",
      { type: "application/octet-stream" },
    );

    await expect(prepareChatAttachment(file)).rejects.toThrow(
      "Attachments must be 1.0 MB or smaller.",
    );
  });

  it("re-encodes a resized PNG that is still over the upload limit as WebP", async () => {
    stubCanvas((type) => ({ size: type === "image/png" ? OVER_LIMIT : 1, type }));

    await expect(prepareChatAttachment(png)).resolves.toEqual({
      blob: { size: 1, type: "image/webp" },
      mimeType: "image/webp",
    });
  });

  it("falls back to JPEG when the browser encodes WebP requests as PNG", async () => {
    stubCanvas((type) =>
      type === "image/jpeg" ? { size: 1, type } : { size: OVER_LIMIT, type: "image/png" }
    );

    await expect(prepareChatAttachment(png)).resolves.toEqual({
      blob: { size: 1, type: "image/jpeg" },
      mimeType: "image/jpeg",
    });
  });

  it("rejects an image that no encoding brings under the upload limit", async () => {
    stubCanvas((type) => ({ size: OVER_LIMIT, type }));

    await expect(prepareChatAttachment(png)).rejects.toThrow(
      "Attachments must be 1.0 MB or smaller.",
    );
  });
});
