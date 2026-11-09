import { afterEach, describe, expect, it, vi } from "vitest";
import { exactRange, FILE_CHANGED, FILE_READ_IDLE_MS } from "../src/drive-file-read";

/** An endless body of `chunkBytes`-byte chunks, counting what is pulled from it. */
function countedBody(chunkBytes: number) {
  let state = { pulls: 0, cancelled: false };
  let body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(state.pulls));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

const bytesOf = async (content: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(content).arrayBuffer());

/** A body that sends `sent` 4-byte chunks and then goes silent without ending. */
function stallingBody(sent: number) {
  let state = { pulls: 0, cancelled: false };
  let body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulls++ < sent) return controller.enqueue(new Uint8Array(4));
      return new Promise<void>(() => undefined);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

describe("exactRange", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads from the answer only as it is read itself", async () => {
    let { body, state } = countedBody(4);

    let reader = exactRange(body, 100).getReader();
    expect(state.pulls).toBe(0);
    expect((await reader.read()).value).toEqual(new Uint8Array(4).fill(1));
    expect(state.pulls).toBe(1);

    await reader.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("cuts an answer that runs past the range, cancelling the rest unread", async () => {
    let { body, state } = countedBody(4);

    expect(await bytesOf(exactRange(body, 6))).toEqual(new Uint8Array([1, 1, 1, 1, 2, 2]));
    expect(state.pulls).toBe(2);
    expect(state.cancelled).toBe(true);
  });

  it("ends with the range without waiting for the answer to end", async () => {
    let { body, state } = countedBody(4);

    expect(await bytesOf(exactRange(body, 8))).toHaveLength(8);
    expect(state.pulls).toBe(2);
    expect(state.cancelled).toBe(true);
  });

  it("errors, after the bytes it had, when the answer ends inside the range", async () => {
    let reader = exactRange(new Response(new Uint8Array([7, 8, 9])).body!, 4).getReader();

    expect((await reader.read()).value).toEqual(new Uint8Array([7, 8, 9]));
    await expect(reader.read()).rejects.toThrow(FILE_CHANGED);
  });

  it("passes on a download that breaks off", async () => {
    let broken = new ReadableStream<Uint8Array>({
      pull: controller => controller.error(new Error("connection lost")),
    }, { highWaterMark: 0 });

    await expect(bytesOf(exactRange(broken, 4))).rejects.toThrow("connection lost");
  });

  // Only the wait for Drive's answer to begin is timed by the download, so this times the rest.
  it("ends a stream whose answer stops arriving, letting the download go", async () => {
    vi.useFakeTimers();
    let { body, state } = stallingBody(1);
    let reader = exactRange(body, 100).getReader();
    expect((await reader.read()).value).toHaveLength(4);

    let stalled = reader.read();
    let outcome = expect(stalled).rejects.toThrow("Drive stopped sending it");
    await vi.advanceTimersByTimeAsync(FILE_READ_IDLE_MS - 1);
    expect(state.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(state.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["never starts reading", 0],
    ["stops reading partway", 2],
  ])("ends a stream whose reader %s", async (_name, reads) => {
    vi.useFakeTimers();
    let { body, state } = countedBody(4);
    let reader = exactRange(body, 100).getReader();
    for (let i = 0; i < reads; i++) await reader.read();

    await vi.advanceTimersByTimeAsync(FILE_READ_IDLE_MS - 1);
    expect(state.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(reader.read()).rejects.toThrow("went unread");
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The wait is for the next movement either way, so one spent on Drive is not added to one
  // spent on the reader: each starts it over.
  it("starts its wait over when Drive is asked and again when its bytes are handed on", async () => {
    vi.useFakeTimers();
    let sends: (() => void)[] = [];
    let body = new ReadableStream<Uint8Array>({
      pull: controller => new Promise<void>(resolve => {
        sends.push(() => { controller.enqueue(new Uint8Array(4)); resolve(); });
      }),
    }, { highWaterMark: 0 });
    let reader = exactRange(body, 100).getReader();

    for (let round = 0; round < 3; round++) {
      // The reader takes almost the whole wait to ask, then Drive almost the whole wait to answer.
      await vi.advanceTimersByTimeAsync(FILE_READ_IDLE_MS - 1);
      let read = reader.read();
      await vi.advanceTimersByTimeAsync(FILE_READ_IDLE_MS - 1);
      sends[round]!();
      expect((await read).value).toHaveLength(4);
    }
    await reader.cancel();
  });

  it("lets a download go at once when cancelled while Drive is being waited on", async () => {
    let { body, state } = stallingBody(0);
    let reader = exactRange(body, 100).getReader();
    let pending = reader.read();

    await reader.cancel();

    expect(state.cancelled).toBe(true);
    expect((await pending).done).toBe(true);
  });

  it.each([
    ["is read to its end", 8, async (content: ReadableStream<Uint8Array>) => { await bytesOf(content); }],
    ["is cancelled", 8, (content: ReadableStream<Uint8Array>) => content.cancel()],
    ["ends short", 9, (content: ReadableStream<Uint8Array>) =>
      expect(bytesOf(content)).rejects.toThrow(FILE_CHANGED)],
  ])("leaves no wait running once it %s", async (_name, length, use) => {
    vi.useFakeTimers();

    await use(exactRange(new Response(new Uint8Array(8)).body!, length));

    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no wait running once the download breaks off", async () => {
    vi.useFakeTimers();
    let broken = new ReadableStream<Uint8Array>({
      pull: controller => controller.error(new Error("connection lost")),
    }, { highWaterMark: 0 });

    await expect(bytesOf(exactRange(broken, 8))).rejects.toThrow("connection lost");

    expect(vi.getTimerCount()).toBe(0);
  });
});
