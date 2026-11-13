import { Suspense, use, useEffect, useRef } from "react";
import { Dialog, Loader, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, DownloadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { WorkshopButton, WorkshopIconButton } from "../../../components/WorkshopControls";
import { formatAttachmentSize } from "../attachmentFormatting";
import { attachmentKind } from "./attachmentKind";
import { ATTACHMENT_KIND_ICONS } from "./attachmentKindIcons";
import { AttachmentPreviewBoundary } from "./AttachmentPreviewBoundary";
import { ATTACHMENT_PREVIEWERS } from "./attachmentPreviewers";
import type { AttachmentContentLoader, AttachmentFile } from "./attachmentFile";
import { looksLikeText, previewFormat } from "./previewFormat";
import { saveAttachment } from "./saveAttachment";

const displayName = (attachment: AttachmentFile) => attachment.name ?? "Attached file";

/** "PDF · 1.2 MB": the extension when the name has one, since MIME types read poorly. */
const describeAttachment = (attachment: AttachmentFile): string => {
  const dot = attachment.name?.lastIndexOf(".") ?? -1;
  const extension = attachment.name && dot > 0 ? attachment.name.slice(dot + 1) : "";
  const type = extension && extension.length <= 5
    ? extension.toUpperCase()
    : attachment.mimeType || "Unknown type";
  const size = formatAttachmentSize(attachment.size);
  return size ? `${type} · ${size}` : type;
};

const NoPreview = ({ attachment, message, onDownload }: {
  attachment: AttachmentFile;
  message: string;
  onDownload: () => void;
}) => {
  const KindIcon = ATTACHMENT_KIND_ICONS[attachmentKind(attachment.mimeType, attachment.name)];
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-kumo-base text-kumo-subtle ring-1 ring-inset ring-kumo-line">
          <KindIcon size={26} />
        </div>
        <div className="space-y-1">
          <div className="break-words text-[14px] font-medium leading-5 text-kumo-default">
            {displayName(attachment)}
          </div>
          <div className="text-[13px] leading-5 text-kumo-subtle">{message}</div>
        </div>
        <WorkshopButton onClick={onDownload}>
          <DownloadSimpleIcon size={14} className="mr-1.5" />
          Download
        </WorkshopButton>
      </div>
    </div>
  );
};

const AttachmentPreview = ({ attachment, loadContent, onDownload }: {
  attachment: AttachmentFile;
  loadContent: AttachmentContentLoader;
  onDownload: () => void;
}) => {
  const known = previewFormat(attachment.mimeType, attachment.name);
  const untyped = attachmentKind(attachment.mimeType, attachment.name) === "file";
  // A file with a type that has no previewer is never fetched just to say so.
  const bytes = known || untyped ? use(loadContent(attachment.id)) : undefined;
  const format = known ?? (bytes && looksLikeText(bytes) ? "text" : undefined);
  if (!bytes || !format) {
    return (
      <NoPreview
        attachment={attachment}
        message="There’s no preview for this kind of file."
        onDownload={onDownload}
      />
    );
  }
  const Previewer = ATTACHMENT_PREVIEWERS[format];
  return (
    <Previewer bytes={bytes} name={displayName(attachment)} mimeType={attachment.mimeType} />
  );
};

/**
 * Shows one of a set of attachments (a message's, or the composer's) at full size, with the
 * others a step away. Mount it while it should be open.
 */
export const AttachmentViewer = ({
  attachments,
  openId,
  onOpenChange,
  loadContent,
  onRetry,
}: {
  attachments: readonly AttachmentFile[];
  openId: string;
  /** The attachment to show next, or null to close. */
  onOpenChange: (id: string | null) => void;
  loadContent: AttachmentContentLoader;
  /** Forgets fetches that failed, so the download a person asks for fetches again. */
  onRetry: () => void;
}) => {
  const toasts = useKumoToastManager();
  const index = Math.max(0, attachments.findIndex((attachment) => attachment.id === openId));
  const attachment = attachments[index];

  const step = (offset: number) => {
    const next = attachments[index + offset];
    if (next) onOpenChange(next.id);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  // On the document, while capturing: focus may rest on the dialog itself, outside its content,
  // and a bubbling listener here is not reached by keys pressed inside the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Inside a preview the arrow keys belong to it: a text cursor, a grid's scrolling.
      if ((event.target as Element).closest("[data-attachment-preview]")) return;
      if (event.key === "ArrowLeft") stepRef.current(-1);
      if (event.key === "ArrowRight") stepRef.current(1);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  if (!attachment) return null;

  const download = () => {
    onRetry();
    loadContent(attachment.id)
      .then((bytes) => saveAttachment(bytes, attachment.name, attachment.mimeType))
      // A failed save as well as a failed fetch.
      .catch((error: unknown) => {
        console.error("Failed to download chat attachment:", error);
        toasts.add({
          title: error instanceof Error && error.message
            ? error.message
            : "Failed to download attachment",
          variant: "error",
        });
      });
  };

  const KindIcon = ATTACHMENT_KIND_ICONS[attachmentKind(attachment.mimeType, attachment.name)];

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onOpenChange(null); }}>
      <Dialog
        size="xl"
        className="!top-1/2 !z-[1200] h-[min(860px,calc(var(--app-height)-32px))] !w-[min(1120px,calc(100vw-32px))] !max-w-none !-translate-y-1/2 overflow-hidden bg-kumo-base p-0"
      >
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center gap-3 border-b border-kumo-line py-2.5 pl-4 pr-2.5">
            <KindIcon size={20} className="shrink-0 text-kumo-subtle" />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-[14px] font-medium leading-5 tracking-[-0.25px] text-kumo-default">
                {displayName(attachment)}
              </Dialog.Title>
              <Dialog.Description className="truncate text-[12px] leading-4 text-kumo-subtle">
                {describeAttachment(attachment)}
              </Dialog.Description>
            </div>
            {attachments.length > 1 && (
              <div className="flex shrink-0 items-center gap-0.5">
                <WorkshopIconButton
                  aria-label="Previous attachment"
                  disabled={index === 0}
                  onClick={() => step(-1)}
                >
                  <CaretLeftIcon size={16} />
                </WorkshopIconButton>
                <span className="min-w-9 text-center text-[12px] tabular-nums text-kumo-subtle">
                  {index + 1} of {attachments.length}
                </span>
                <WorkshopIconButton
                  aria-label="Next attachment"
                  disabled={index === attachments.length - 1}
                  onClick={() => step(1)}
                >
                  <CaretRightIcon size={16} />
                </WorkshopIconButton>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip content="Download" side="bottom" asChild>
                <WorkshopIconButton aria-label="Download" onClick={download}>
                  <DownloadSimpleIcon size={16} />
                </WorkshopIconButton>
              </Tooltip>
              <Dialog.Close
                render={(props) => (
                  <WorkshopIconButton {...props} aria-label="Close">
                    <XIcon size={16} />
                  </WorkshopIconButton>
                )}
              />
            </div>
          </div>

          <div data-attachment-preview className="min-h-0 flex-1 overflow-auto bg-kumo-elevated">
            <AttachmentPreviewBoundary
              key={attachment.id}
              fallback={(message) => (
                <NoPreview attachment={attachment} message={message} onDownload={download} />
              )}
            >
              <Suspense
                fallback={(
                  <div className="grid h-full place-items-center" role="status" aria-label="Loading preview">
                    <Loader size="base" />
                  </div>
                )}
              >
                <AttachmentPreview
                  attachment={attachment}
                  loadContent={loadContent}
                  onDownload={download}
                />
              </Suspense>
            </AttachmentPreviewBoundary>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
