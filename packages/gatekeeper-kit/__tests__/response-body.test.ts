import { describe, expect, it, vi } from "vitest";
import { readTextCapped, readTextPrefix, ResponseTooLargeError } from "../src/response-body";

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

    await expect(readTextCapped(response, NaN)).rejects.toThrow(/positive safe integer/);
    await expect(readTextCapped(response, Infinity)).rejects.toThrow(/positive safe integer/);
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

describe("readTextPrefix", () => {
  it("returns a body at or below the cap whole", async () => {
    expect(await readTextPrefix(new Response(streamed(["abc"]).body), 8)).toBe("abc");
    expect(await readTextPrefix(new Response(streamed(["ab", "cd"]).body), 4)).toBe("abcd");
  });

  it("truncates a longer body at the cap, ignoring its advertised length, and cancels the rest", async () => {
    const { body, cancel } = streamed(["abc", "def", "ghi"]);
    const response = new Response(body, { headers: { "content-length": "9" } });

    expect(await readTextPrefix(response, 5)).toBe("abcde");
    expect(cancel).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("ends a character cut at the cap in U+FFFD", async () => {
    // "é" is two bytes; a cap after the first leaves an incomplete sequence.
    expect(await readTextPrefix(new Response(streamed(["aé"]).body), 2)).toBe("a\uFFFD");
  });

  it("keeps what arrived before a stream error, and releases the reader", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error("connection reset");
        sent = true;
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });

    expect(await readTextPrefix(new Response(body), 64)).toBe("partial");
    expect(body.locked).toBe(false);
  });

  it("returns the prefix when cancelling the rest fails", async () => {
    const { body, cancel } = streamed(["x".repeat(64)]);
    cancel.mockRejectedValue(new Error("cancel failed"));

    expect(await readTextPrefix(new Response(body), 4)).toBe("xxxx");
    expect(body.locked).toBe(false);
  });

  it("returns an empty string for a missing, used, or locked body", async () => {
    expect(await readTextPrefix(new Response(null, { status: 204 }), 8)).toBe("");
    const used = new Response("hello");
    await used.text();
    expect(await readTextPrefix(used, 8)).toBe("");
    const locked = new Response("hello");
    locked.body!.getReader();
    expect(await readTextPrefix(locked, 8)).toBe("");
  });

  it("refuses a cap that cannot bound anything", async () => {
    await expect(readTextPrefix(new Response("x"), 0)).rejects.toThrow(/positive safe integer/);
    await expect(readTextPrefix(new Response("x"), Infinity)).rejects.toThrow(/positive safe integer/);
  });
});
