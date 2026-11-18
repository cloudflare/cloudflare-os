import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTokenIndex } from "./chatTokenIndex";

describe("ChatTokenIndex", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("finds a chat it knows at once", async () => {
    const index = new ChatTokenIndex();
    index.update(new Map([["tok-a", 3]]));
    await expect(index.find("tok-a", new AbortController().signal)).resolves.toBe(3);
  });

  it("waits for a chat whose metadata arrives after the request", async () => {
    const index = new ChatTokenIndex();
    const found = index.find("tok-a", new AbortController().signal, 1_000);
    index.update(new Map([["tok-b", 4]]));
    vi.advanceTimersByTime(500);
    index.update(new Map([["tok-b", 4], ["tok-a", 7]]));
    await expect(found).resolves.toBe(7);
  });

  it("gives up on a token no chat has", async () => {
    const index = new ChatTokenIndex();
    const found = index.find("tok-a", new AbortController().signal, 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(found).rejects.toThrow("No such chat.");
  });

  it("resolves to nothing once the request is dropped, even if the chat arrives later", async () => {
    const index = new ChatTokenIndex();
    const abort = new AbortController();
    const found = index.find("tok-a", abort.signal, 1_000);
    abort.abort();
    index.update(new Map([["tok-a", 7]]));
    await expect(found).resolves.toBeUndefined();
    await expect(index.find("tok-a", abort.signal)).resolves.toBeUndefined();
  });
});
