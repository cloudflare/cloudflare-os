import type { RpcStub } from "capnweb";
import type { ChatAttachmentRef, Overseer } from "@gadgets/workshop-shared/api";

/**
 * The bytes of a sent message's attachment. One with a blob is streamed:
 * getChatAttachmentContent() sends a file in one message, and refuses a large one. `signal`
 * cancels the stream, so a fetch nobody waits for any more stops transferring.
 */
export const readChatAttachment = async (
  overseer: RpcStub<Overseer>,
  chatId: number,
  attachment: ChatAttachmentRef,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  if (attachment.oid === undefined) {
    return await overseer.getChatAttachmentContent(chatId, attachment.id);
  }
  const reader = (await overseer.readBlob(attachment.oid)).getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });
  // Each piece is copied into place as it arrives, so the file is held once, not in pieces and
  // then whole as well.
  const bytes = new Uint8Array(attachment.size);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.byteLength) {
        cancel();
        throw new Error("The attachment's content is larger than its recorded size.");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  if (length < bytes.byteLength) {
    throw new Error("The attachment's content is smaller than its recorded size.");
  }
  return bytes;
};
