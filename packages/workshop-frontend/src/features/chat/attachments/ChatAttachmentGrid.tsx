import { lazy, Suspense, useState } from "react";
import type { ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import { ChatAttachmentCard } from "./ChatAttachmentCard";
import { useAttachmentContents } from "./useAttachmentContents";

const AttachmentViewer = lazy(() =>
  import("./AttachmentViewer").then(m => ({ default: m.AttachmentViewer })));

/** A message's attachments, each opening in the viewer. */
export const ChatAttachmentGrid = ({
  attachments,
  loadContent,
}: {
  attachments: readonly ChatAttachmentRef[];
  /**
   * Fetches the bytes of an attachment the message does not carry inline, or with `limit` only
   * its first ones. `signal` aborts when the grid goes.
   */
  loadContent: (attachment: ChatAttachmentRef, signal: AbortSignal, limit?: number) => Promise<Uint8Array>;
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const contents = useAttachmentContents(async (id, signal) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    if (!attachment) throw new Error("The attachment is no longer part of this message.");
    return attachment.content ?? loadContent(attachment, signal);
  }, attachments.map((attachment) => attachment.id));

  return (
    <>
      <ul
        aria-label="Attachments"
        className="m-0 mb-1.5 flex max-w-[min(680px,78%)] list-none flex-wrap justify-end gap-2 p-0"
      >
        {attachments.map((attachment) => (
          <li key={attachment.id} className="min-w-0">
            <ChatAttachmentCard
              attachment={attachment}
              prominent={attachments.length === 1}
              loadContent={(signal, limit) => limit === undefined
                ? contents.readOnce(attachment.id, signal)
                : attachment.content
                  ? Promise.resolve(attachment.content.subarray(0, limit))
                  : loadContent(attachment, signal, limit)}
              onOpen={() => {
                contents.forgetFailures();
                setOpenId(attachment.id);
              }}
            />
          </li>
        ))}
      </ul>
      {openId !== null && (
        <Suspense fallback={null}>
          <AttachmentViewer
            attachments={attachments}
            openId={openId}
            onOpenChange={setOpenId}
            contents={contents}
          />
        </Suspense>
      )}
    </>
  );
};
