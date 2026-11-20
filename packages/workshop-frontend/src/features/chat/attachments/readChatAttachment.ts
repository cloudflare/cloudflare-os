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
  const pieces: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(pieces.reduce((length, piece) => length + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return bytes;
};
