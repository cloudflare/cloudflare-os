import { File as FileIcon, X } from "@phosphor-icons/react";
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
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pt-1">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-kumo-line/70 bg-kumo-elevated"
        >
          {attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt={attachment.name ?? "Attached file"}
              className="h-full w-full object-cover"
            />
          ) : (
            <FileIcon size={22} className="text-kumo-inactive" />
          )}
          {attachment.uploadState === "uploading" && (
            <div className="absolute inset-0 grid place-items-center rounded-lg bg-black/35 text-[10px] text-white">
              Uploading
            </div>
          )}
          {attachment.uploadState === "error" && (
            <div className="absolute inset-0 grid place-items-center rounded-lg bg-kumo-danger/80 px-1 text-center text-[9px] leading-3 text-white">
              Failed
            </div>
          )}
          <button
            type="button"
            aria-label="Remove attachment"
            disabled={disabled}
            onClick={() => onRemove(attachment.id)}
            className="absolute right-0.5 top-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={10} weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
};
