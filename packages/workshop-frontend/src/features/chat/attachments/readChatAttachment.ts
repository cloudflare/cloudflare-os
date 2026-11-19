import type { RpcStub } from "capnweb";
import type { ChatAttachmentRef, Overseer } from "@gadgets/workshop-shared/api";

/**
 * The bytes of a sent message's attachment. One with a blob is streamed:
 * getChatAttachmentContent() sends a file in one message, and refuses a large one.
 */
export const readChatAttachment = async (
  overseer: RpcStub<Overseer>,
  chatId: number,
  attachment: ChatAttachmentRef,
): Promise<Uint8Array> => {
  if (attachment.oid === undefined) {
    return await overseer.getChatAttachmentContent(chatId, attachment.id);
  }
  const stream = await overseer.readBlob(attachment.oid);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
