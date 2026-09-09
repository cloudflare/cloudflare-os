import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessibleResources, JiraApi, markdownToAdf } from "../src/jira-api";

const api = () => new JiraApi({ cloudId: "cloud", webBase: "https://example.atlassian.net", getToken: async () => "test-token" });
const limit = 4 * 1024 * 1024;
afterEach(() => vi.unstubAllGlobals());

describe("bounded Jira JSON responses", () => {
  it("accepts realistic rich-text search pages above the former 128 KiB cap without losing descriptions", async () => {
    const issues = Array.from({ length: 40 }, (_, i) => ({ id: String(i), key: `ENG-${i + 1}`, fields: {
      summary: `Issue ${i + 1}`, description: markdownToAdf("Investigation details. ".repeat(350)),
      project: { id: "1", key: "ENG", name: "Engineering" },
    } }));
    const body = JSON.stringify({ issues, isLast: false, nextPageToken: "next" });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(128 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(api().searchIssues("ORDER BY updated DESC", undefined, 40)).resolves.toEqual({ issues, nextPageToken: "next" });
  });

  it("accepts the exact REST byte limit", async () => {
    const body = JSON.stringify({ id: "1", key: "ENG-1", fields: { summary: "" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body + " ".repeat(limit - body.length))));
    await expect(api().getIssue("ENG-1")).resolves.toMatchObject({ key: "ENG-1" });
  });

  it("counts UTF-8 bytes, cancels an oversized stream before EOF, and preserves the size error", async () => {
    const cancel = vi.fn();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode("é".repeat(32 * 1024))); },
      cancel,
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-length": "1" } })));
    await expect(api().searchIssues("", undefined, 40)).rejects.toThrow(`safety limit (${limit} bytes)`);
    expect(cancel).toHaveBeenCalledOnce();
    expect(reads).toBe(65);
    expect(stream.locked).toBe(false);
  });

  it("decodes multibyte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ accountId: "é🙂" }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    await expect(api().getCurrentUser()).resolves.toEqual({ accountId: "é🙂" });
  });

  it("keeps the smaller OAuth response budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(" ".repeat(128 * 1024 + 1))));
    await expect(getAccessibleResources("test-token")).rejects.toThrow("safety limit (131072 bytes)");
  });

  it("distinguishes malformed JSON from transport errors without exposing provider content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider content")));
    await expect(api().getCurrentUser()).rejects.toMatchObject({ message: "Invalid Jira JSON response", details: undefined });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private transport detail")); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    await expect(api().getCurrentUser()).rejects.toMatchObject({ message: "Failed to read Jira response body", details: undefined });
    expect(stream.locked).toBe(false);
  });

  it("preserves HTTP auth status and handles successful empty writes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 401 })));
    await expect(api().getCurrentUser()).rejects.toMatchObject({ status: 401, isAuthError: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api().updateIssue("ENG-1", {})).resolves.toBeUndefined();
  });
});
