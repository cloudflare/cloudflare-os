// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  prepareChatAttachment,
} from "./prepareChatAttachment";

describe("prepareChatAttachment", () => {
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
});
