import { useState } from "react";
import { Tooltip } from "@cloudflare/kumo";
import type { ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import { AttachmentCardFace } from "./AttachmentCardFace";
import { attachmentKind } from "./attachmentKind";
import { previewFormat } from "./previewFormat";
import { useAttachmentThumbnail } from "./useAttachmentThumbnail";
import { useObjectUrl } from "./useObjectUrl";

// The composer's card (ComposerAttachmentCard.tsx): a message's attachments look the way they did
// when they were attached.
const CARD_CLASS =
  "group relative block shrink-0 overflow-hidden rounded-xl bg-kumo-control text-left transition-[background-color,transform] duration-150 ease-out hover:bg-kumo-tint has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-kumo-ring active:scale-[0.98]";

// The button lies over the card instead of holding it: a thumbnail can be a table or hold links,
// which a button may not contain.
const OPEN_BUTTON_CLASS = "absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-none";

const SQUARE_CLASS = "h-[90px] w-[90px] sm:h-[110px] sm:w-[110px]";

const OUTLINE_CLASS =
  "pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-kumo-line";

/**
 * One of a message's attachments. An image shows itself; any other file shows a glimpse of its
 * content, or its kind, with its name. `prominent` is for a message's only attachment, where an
 * image keeps its own shape.
 */
export const ChatAttachmentCard = ({
  attachment,
  prominent,
  inlineImages = false,
  loadContent,
  onOpen,
}: {
  attachment: ChatAttachmentRef;
  prominent: boolean;
  /** Keep generated images whole and readable even when an answer contains several. */
  inlineImages?: boolean;
  loadContent: () => Promise<Uint8Array>;
  onOpen: () => void;
}) => {
  const name = attachment.name ?? "Attached file";
  const kind = attachmentKind(attachment.mimeType, attachment.name);
  const imageUrl = useObjectUrl(
    kind === "image" ? attachment.content : undefined, attachment.mimeType);
  const [imageFailed, setImageFailed] = useState(false);
  const showsImage = imageUrl !== null && !imageFailed;
  const { ref, thumbnail, loading } = useAttachmentThumbnail<HTMLDivElement>(
    previewFormat(attachment.mimeType, attachment.name), loadContent);

  return (
    <Tooltip content={name} side="top" asChild>
      <div
        ref={ref}
        className={`${CARD_CLASS} ${showsImage && (prominent || inlineImages) ? "max-w-full" : SQUARE_CLASS}`}
      >
        {showsImage ? (
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
            className={inlineImages
              ? "block max-h-[512px] w-auto max-w-full object-contain sm:max-w-[512px]"
              : prominent
              ? "block max-h-[220px] min-h-[90px] w-auto min-w-[90px] max-w-full object-cover sm:max-w-[320px]"
              : "block h-full w-full object-cover"}
          />
        ) : (
          <AttachmentCardFace name={name} kind={kind} thumbnail={thumbnail} loading={loading} />
        )}
        <span aria-hidden="true" className={OUTLINE_CLASS} />
        <button type="button" onClick={onOpen} aria-label={`Preview ${name}`} className={OPEN_BUTTON_CLASS} />
      </div>
    </Tooltip>
  );
};
