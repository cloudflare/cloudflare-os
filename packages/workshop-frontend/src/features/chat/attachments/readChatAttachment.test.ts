import type { RpcStub } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ChatAttachmentRef, Overseer } from "@gadgets/workshop-shared/api";
import { readChatAttachment } from "./readChatAttachment";

const attachment = (oid?: string): ChatAttachmentRef =>
  ({ id: "a", name: "a.bin", mimeType: "application/octet-stream", size: 4, ...(oid ? { oid } : {}) });

describe("readChatAttachment", () => {
  it("fetches a legacy attachment, which has no blob, whole", async () => {
    const getChatAttachmentContent = vi.fn<Overseer["getChatAttachmentContent"]>(async () => Uint8Array.of(9));
    const overseer = { getChatAttachmentContent } as unknown as RpcStub<Overseer>;
    await expect(readChatAttachment(overseer, 3, attachment(), new AbortController().signal))
      .resolves.toEqual(Uint8Array.of(9));
    expect(getChatAttachmentContent).toHaveBeenCalledWith(3, "a");
  });

  it("streams an attachment's blob", async () => {
    const readBlob = vi.fn<Overseer["readBlob"]>(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.enqueue(Uint8Array.of(3, 4));
        controller.close();
      },
    }));
    const overseer = { readBlob } as unknown as RpcStub<Overseer>;
    await expect(readChatAttachment(overseer, 3, attachment("f".repeat(40)), new AbortController().signal))
      .resolves.toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  // It is read into a buffer of the recorded size, so a stream that disagrees can't fit.
  it("refuses a blob that streams more bytes than the attachment's size", async () => {
    const cancel = vi.fn<(reason: unknown) => void>();
    const overseer = {
      readBlob: async () => new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4, 5)); },
        cancel,
      }),
    } as unknown as RpcStub<Overseer>;
    await expect(readChatAttachment(overseer, 3, attachment("f".repeat(40)), new AbortController().signal))
      .rejects.toThrow("larger than its recorded size");
    expect(cancel).toHaveBeenCalled();
  });

  it("reads only as much of a blob as it is asked for, and stops the stream", async () => {
    const cancel = vi.fn<(reason: unknown) => void>();
    const overseer = {
      readBlob: async () => new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); },
        cancel,
      }),
    } as unknown as RpcStub<Overseer>;
    await expect(readChatAttachment(overseer, 3, attachment("f".repeat(40)), new AbortController().signal, 2))
      .resolves.toEqual(Uint8Array.of(1, 2));
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels a stream that arrives after the signal aborted, without reading it", async () => {
    const cancel = vi.fn<(reason: unknown) => void>();
    const abort = new AbortController();
    const overseer = {
      readBlob: async () => {
        abort.abort(new Error("Closed the viewer."));
        return new ReadableStream<Uint8Array>({ cancel });
      },
    } as unknown as RpcStub<Overseer>;
    await expect(readChatAttachment(overseer, 3, attachment("f".repeat(40)), abort.signal))
      .rejects.toThrow("Closed the viewer.");
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels the stream when the signal aborts", async () => {
    const cancel = vi.fn<(reason: unknown) => void>();
    const overseer = {
      readBlob: async () => new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(1)); },
        cancel,
      }),
    } as unknown as RpcStub<Overseer>;
    const abort = new AbortController();
    const read = readChatAttachment(overseer, 3, attachment("f".repeat(40)), abort.signal);
    await Promise.resolve();
    abort.abort(new Error("Left the chat."));
    await expect(read).rejects.toThrow("Left the chat.");
    expect(cancel).toHaveBeenCalled();
  });
});
