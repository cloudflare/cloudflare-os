// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fileToBase64, readDroppedUploadFiles } from "./uploadFiles";

describe("fileToBase64", () => {
  it("encodes files without a data URL, including across chunk boundaries", async () => {
    const bytes = Uint8Array.from({ length: 30_000 }, (_, index) => index % 251);
    const file = { arrayBuffer: async () => bytes.buffer } as File;

    const encoded = await fileToBase64(file);
    const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));

    expect(decoded).toEqual(bytes);
  });
});

describe("readDroppedUploadFiles", () => {
  it("reads ordinary dropped files directly instead of through file-system entries", async () => {
    const body = "A standalone skill";
    const skill = new File([body], "standalone.md", { type: "text/markdown" });
    Object.defineProperty(skill, "text", { value: async () => body });
    const transfer = {
      items: [{
        webkitGetAsEntry: () => ({
          isFile: true,
          isDirectory: false,
          name: "standalone.md",
          file: () => { throw new Error("entry API should not be used"); },
        }),
      }],
      files: [skill],
    } as unknown as DataTransfer;

    const [uploaded] = await readDroppedUploadFiles(transfer);

    expect(uploaded).toMatchObject({ path: "standalone.md", body });
  });

  it("directs dropped folders to the safe folder picker", async () => {
    const transfer = {
      items: [{
        webkitGetAsEntry: () => ({
          isFile: false,
          isDirectory: true,
          name: "deployment-check",
        }),
      }],
      files: [],
    } as unknown as DataTransfer;

    await expect(readDroppedUploadFiles(transfer)).rejects.toThrow(
      "We couldn't read this dropped folder. Use Choose folder to select it instead.",
    );
  });
});
