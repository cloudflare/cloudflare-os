import { describe, expect, it } from "vite-plus/test";
import { bridgePdfAttachments } from "../src/chat-attachment-pdf.js";

// Request-level coverage (real pi adapters emitting real payloads, then bridged) lives in
// ai-models.test.ts; these tests pin the rewrite rules themselves.

describe("bridgePdfAttachments", () => {
  it("retags Anthropic PDF image blocks as document blocks, preserving other fields", () => {
    const payload = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this." },
            {
              type: "image",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
              cache_control: { type: "ephemeral" },
            },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
          ],
        },
        { role: "assistant", content: "Sure." },
      ],
    };

    const bridged = bridgePdfAttachments("anthropic-messages", payload) as typeof payload;
    expect(bridged.messages[0].content[1]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
      cache_control: { type: "ephemeral" },
    });
    // Real images and other messages pass through untouched.
    expect(bridged.messages[0].content[2]).toBe(payload.messages[0].content[2]);
    expect(bridged.messages[1]).toBe(payload.messages[1]);
    // The input payload is not mutated.
    expect(payload.messages[0].content[1].type).toBe("image");
  });

  it("rewrites OpenAI Responses PDF input_image parts into input_file parts", () => {
    const payload = {
      model: "gpt-5.2",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Summarize this." },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:application/pdf;base64,JVBERi0=",
            },
            { type: "input_image", detail: "auto", image_url: "data:image/png;base64,iVBOR" },
          ],
        },
      ],
    };

    const bridged = bridgePdfAttachments("openai-responses", payload) as typeof payload;
    expect(bridged.input[0].content[1]).toEqual({
      type: "input_file",
      filename: "attachment.pdf",
      file_data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(bridged.input[0].content[2]).toBe(payload.input[0].content[2]);
  });

  it("leaves payloads without PDF parts unchanged", () => {
    expect(bridgePdfAttachments("anthropic-messages", {
      messages: [
        { role: "user", content: "plain text" },
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }],
        },
      ],
    })).toBeUndefined();

    expect(bridgePdfAttachments("openai-responses", {
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    })).toBeUndefined();
  });

  it("does not touch APIs that take PDFs natively or not at all", () => {
    const google = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: "x" } }] }] };
    expect(bridgePdfAttachments("google-generative-ai", google)).toBeUndefined();
    const completions = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:application/pdf;base64,x" } }] }] };
    expect(bridgePdfAttachments("openai-completions", completions)).toBeUndefined();
  });
});
