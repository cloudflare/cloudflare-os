import { ComposerAttachmentCard } from "./ComposerAttachmentCard";
import type { ComposerAttachment } from "./useComposerAttachments";

export const ComposerAttachmentTray = ({
  attachments,
  disabled = false,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  disabled?: boolean;
  onRemove: (attachmentId: string) => void;
}) => {
  if (attachments.length === 0) return null;

  return (
    <ul
      aria-label="Attachments"
      className="m-0 flex list-none gap-2 overflow-x-auto px-3 pb-2 pt-3"
    >
      {attachments.map((attachment) => (
        <li key={attachment.id} className="shrink-0">
          <ComposerAttachmentCard
            attachment={attachment}
            disabled={disabled}
            onRemove={() => onRemove(attachment.id)}
          />
        </li>
      ))}
    </ul>
  );
};
