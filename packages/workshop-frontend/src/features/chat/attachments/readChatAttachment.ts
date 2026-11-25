import type { RpcStub } from "capnweb";
import type { ChatAttachmentRef, Overseer } from "@gadgets/workshop-shared/api";

/**
 * The bytes of a sent message's attachment, or with `limit` only its first ones. One with a blob
 * is streamed: getChatAttachmentContent() sends a file in one message, and refuses a large one.
 * `signal` cancels the stream, so a fetch nobody waits for any more stops transferring.
 */
export const readChatAttachment = async (
  overseer: RpcStub<Overseer>,
  chatId: number,
  attachment: ChatAttachmentRef,
  signal: AbortSignal,
  limit = Infinity,
): Promise<Uint8Array> => {
  if (attachment.oid === undefined) {
    const bytes = await overseer.getChatAttachmentContent(chatId, attachment.id);
    return bytes.subarray(0, limit);
  }
  const reader = (await overseer.readBlob(attachment.oid)).getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  // Abandoned while the stream was on its way: nothing is read, and nothing is allocated for it.
  if (signal.aborted) {
    cancel();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", cancel, { once: true });
  // Each piece is copied into place as it arrives, so the file is held once, not in pieces and
  // then whole as well.
  const prefix = limit < attachment.size;
  const bytes = new Uint8Array(prefix ? limit : attachment.size);
  let length = 0;
  try {
    for (;;) {
      // A whole file is read to the end, which shows whether it is longer than recorded.
      if (prefix && length === bytes.byteLength) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.byteLength && !prefix) {
        cancel();
        throw new Error("The attachment's content is larger than its recorded size.");
      }
      bytes.set(value.subarray(0, bytes.byteLength - length), length);
      length += Math.min(value.byteLength, bytes.byteLength - length);
    }
    // What the prefix leaves is not wanted.
    if (prefix) cancel();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  if (length < bytes.byteLength) {
    throw new Error("The attachment's content is smaller than its recorded size.");
  }
  return bytes;
};
