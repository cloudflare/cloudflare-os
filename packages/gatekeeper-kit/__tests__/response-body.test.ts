import { describe, expect, it, vi } from "vitest";
import { readTextCapped, ResponseTooLargeError } from "../src/response-body";

/** A body delivered in chunks, reporting whether it was pulled and whether it was cancelled. */
function streamed(chunks: string[]) {
  const cancel = vi.fn();
  const pulled = vi.fn();
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled();
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
    cancel,
  });
  return { body, cancel, pulled };
}

describe("readTextCapped", () => {
  it("returns a body under the cap, and an empty string when there is none", async () => {
    expect(await readTextCapped(new Response("hello"), 64)).toBe("hello");
    expect(await readTextCapped(new Response(null, { status: 204 }), 64)).toBe("");
  });

  it("returns an empty string for a bodyless response with an oversized advertised length", async () => {
    const response = new Response(null, {
      status: 304,
      headers: { "content-length": "100" },
    });

    expect(await readTextCapped(response, 16)).toBe("");
  });

  it("reassembles a chunked body across reads", async () => {
    const { body } = streamed(["one ", "two ", "three"]);
    expect(await readTextCapped(new Response(body), 64)).toBe("one two three");
  });

  it("refuses a cap that cannot bound anything, before touching the body", async () => {
    // `NaN` and `Infinity` fail every comparison, which would silently disable both size checks.
    const { body } = streamed(["x".repeat(64)]);
    const response = new Response(body);

    await expect(readTextCapped(response, NaN)).rejects.toThrow(/positive integer/);
    await expect(readTextCapped(response, Infinity)).rejects.toThrow(/positive integer/);
    // The body is untouched: the same response still reads in full under a real cap.
    expect(body.locked).toBe(false);
    expect(await readTextCapped(response, 128)).toBe("x".repeat(64));
  });

  it("refuses an advertised overage without reading the body", async () => {
    // The running total would refuse this too, so what this pins is that the header short-circuits
    // it: nothing is pulled, and the transfer never starts.
    const { body, cancel, pulled } = streamed(["x".repeat(100)]);
    const response = new Response(body, { headers: { "content-length": "100" } });

    await expect(readTextCapped(response, 16)).rejects.toThrow(ResponseTooLargeError);
    expect(pulled).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses a body that lies about its length, and cancels the transfer", async () => {
    // The header is a provider claim, so the running total is what actually enforces the cap.
    const { body, cancel } = streamed(["x".repeat(8), "y".repeat(64)]);
    const response = new Response(body, { headers: { "content-length": "8" } });

    await expect(readTextCapped(response, 16)).rejects.toThrow(/exceeded 16 bytes/);
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses a body with no advertised length at all", async () => {
    const { body } = streamed(["x".repeat(64)]);
    await expect(readTextCapped(new Response(body), 16)).rejects.toThrow(ResponseTooLargeError);
  });

  it("preserves the size error and releases the reader when cancellation fails", async () => {
    const { body, cancel } = streamed(["x".repeat(64)]);
    cancel.mockRejectedValue(new Error("cancel failed"));

    await expect(readTextCapped(new Response(body), 16)).rejects.toThrow(ResponseTooLargeError);
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("releases the reader when a chunk read throws", async () => {
    // The lock outlives the failed read otherwise, so a caller that retries on the same body
    // gets an opaque "already locked" error instead of the provider's.
    const body = new ReadableStream<Uint8Array>({
      pull() { throw new Error("connection reset"); },
    });

    await expect(readTextCapped(new Response(body), 64)).rejects.toThrow("connection reset");
    expect(body.locked).toBe(false);
  });
});
