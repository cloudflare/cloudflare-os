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
  inlineImages = false,
}: {
  attachments: readonly ChatAttachmentRef[];
  /** Fetches the bytes of an attachment the message does not carry inline. */
  loadContent: (attachment: ChatAttachmentRef) => Promise<Uint8Array>;
  /** Display generated images at answer size, aligned with the assistant's prose. */
  inlineImages?: boolean;
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const { content, forgetFailures } = useAttachmentContents(async (id) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    if (!attachment) throw new Error("The attachment is no longer part of this message.");
    return attachment.content ?? loadContent(attachment);
  }, attachments.map((attachment) => attachment.id));

  return (
    <>
      <ul
        aria-label="Attachments"
        className={`m-0 mb-1.5 flex list-none flex-wrap gap-2 p-0 ${inlineImages ? "max-w-full justify-start" : "max-w-[min(680px,78%)] justify-end"}`}
      >
        {attachments.map((attachment) => (
          <li key={attachment.id} className="min-w-0">
            <ChatAttachmentCard
              attachment={attachment}
              prominent={attachments.length === 1}
              inlineImages={inlineImages}
              loadContent={() => content(attachment.id)}
              onOpen={() => {
                forgetFailures();
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
            loadContent={content}
            onRetry={forgetFailures}
          />
        </Suspense>
      )}
    </>
  );
};
