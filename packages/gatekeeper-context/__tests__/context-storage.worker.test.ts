import { describe, expect, it } from "vitest";
import {
  decodeStoredContextBody, encodeStoredContextBody, truncateContextDescription,
} from "../src/context-storage.js";
import { artifactContextDocument } from "../src/artifact-sync.js";

describe("context document storage", () => {
  it("encodes mixed-Unicode text as UTF-8 bytes and reads it back", () => {
    const body = "Cloudflare cafe 日本語 🚀\n".repeat(4_200);
    const stored = encodeStoredContextBody("application/json", body);

    expect(stored).toBeInstanceOf(Uint8Array);
    expect(decodeStoredContextBody("application/json", stored)).toBe(body);
  });

  it("reads legacy string records", () => {
    expect(decodeStoredContextBody("text/markdown", "legacy body")).toBe("legacy body");
  });

  it("stores binary base64 bodies as bytes and reads them back", () => {
    const stored = encodeStoredContextBody("image/png", "AQID");
    expect(stored).toEqual(new Uint8Array([1, 2, 3]));
    expect(decodeStoredContextBody("image/png", stored)).toBe("AQID");
  });

  it("measures binary storage by decoded bytes rather than base64 length", () => {
    const body = "AAAA".repeat(450_001);
    const stored = encodeStoredContextBody("image/png", body);

    expect(body.length).toBeGreaterThan(1_800_000);
    expect(stored.byteLength).toBe(1_350_003);
  });

  it("reads legacy binary base64 strings", () => {
    expect(decodeStoredContextBody("image/png", "AQID")).toBe("AQID");
  });

  it("keeps git text and binary blobs as their original bytes", () => {
    const text = new TextEncoder().encode("# Title\n\nDescription");
    const binary = new Uint8Array([1, 2, 3]);

    expect(artifactContextDocument("readme.md", text).body).toBe(text);
    expect(artifactContextDocument("image.png", binary).body).toBe(binary);
  });

  it("truncates descriptions", () => {
    const description = "x".repeat(16_001);
    expect(truncateContextDescription(description)).toBe("x".repeat(16_000));
  });

  it("truncates descriptions derived from git documents", () => {
    const body = new TextEncoder().encode(`description: |\n  ${"x".repeat(20_000)}\nnext: true\n`);
    expect(artifactContextDocument("context.yaml", body).description).toBe("x".repeat(16_000));
  });
});
