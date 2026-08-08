import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { chatAttachmentModelParts } from "../src/chat-attachment-parts.js";

// Verifies that an attachment the current model can't accept is replaced with a text marker
// rather than sent as an image part; see the header of chat-attachment-parts.ts for why.

function testModel(api: Api, input: ("text" | "image")[]): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api,
    provider: "anthropic",
    baseUrl: "https://example.com",
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

const PNG_BYTES = Uint8Array.fromBase64("iVBORw0KGgo=");
const PDF_BYTES = Uint8Array.fromBase64("JVBERi0xLjQ=");

describe("chatAttachmentModelParts", () => {
  it("emits an image part for an image on a model with image input", () => {
    const parts = chatAttachmentModelParts(
        {mimeType: "image/png", name: "photo.png"}, PNG_BYTES,
        testModel("anthropic-messages", ["text", "image"]));
    expect(parts).toEqual([
      {type: "image", data: PNG_BYTES.toBase64(), mimeType: "image/png"},
    ]);
  });

  it("degrades an image to a text marker on a text-only model", () => {
    const parts = chatAttachmentModelParts(
        {mimeType: "image/png", name: "photo.png"}, PNG_BYTES,
        testModel("anthropic-messages", ["text"]));
    expect(parts).toEqual([{
      type: "text",
      text: "\n\n[Attached file (photo.png) (image/png) omitted — " +
          "this file type is not supported by the current model]",
    }]);
  });

  it("inlines a text-like attachment regardless of image support", () => {
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const parts = chatAttachmentModelParts(
        {mimeType: "text/csv", name: "data.csv"}, bytes,
        testModel("openai-completions", ["text"]));
    expect(parts).toEqual([{
      type: "text",
      text: "\n\n[Attached text file (data.csv)]\na,b\n1,2\n",
    }]);
  });

  it("bridges a PDF over an image part on a document-capable API with image input", () => {
    const parts = chatAttachmentModelParts(
        {mimeType: "application/pdf", name: "doc.pdf"}, PDF_BYTES,
        testModel("anthropic-messages", ["text", "image"]));
    expect(parts).toEqual([
      {type: "text", text: "\n\n[Attached PDF file (doc.pdf)]"},
      {type: "image", data: PDF_BYTES.toBase64(), mimeType: "application/pdf"},
    ]);
  });

  it("degrades a PDF to a text marker when the model lacks image input", () => {
    // The API could take a document block, but the PDF rides an image content part, so a
    // text-only model must not receive it.
    const parts = chatAttachmentModelParts(
        {mimeType: "application/pdf", name: "doc.pdf"}, PDF_BYTES,
        testModel("anthropic-messages", ["text"]));
    expect(parts).toEqual([{
      type: "text",
      text: "\n\n[Attached file (doc.pdf) (application/pdf) omitted — " +
          "this file type is not supported by the current model]",
    }]);
  });

  it("degrades a PDF to a text marker on an API without document input", () => {
    const parts = chatAttachmentModelParts(
        {mimeType: "application/pdf"}, PDF_BYTES,
        testModel("openai-completions", ["text", "image"]));
    expect(parts).toEqual([{
      type: "text",
      text: "\n\n[Attached file (application/pdf) omitted — " +
          "this file type is not supported by the current model]",
    }]);
  });

  it("degrades an unknown attachment type to a text marker", () => {
    const parts = chatAttachmentModelParts(
        {mimeType: "application/zip", name: "stuff.zip"}, new Uint8Array([0x50, 0x4B]),
        testModel("anthropic-messages", ["text", "image"]));
    expect(parts).toEqual([{
      type: "text",
      text: "\n\n[Attached file (stuff.zip) (application/zip) omitted — " +
          "this file type is not supported by the current model]",
    }]);
  });
});
