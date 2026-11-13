import { lazy, Suspense, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useAttachmentContents } from "../../attachments/useAttachmentContents";
import { ComposerAttachmentCard } from "./ComposerAttachmentCard";
import type { ComposerAttachment } from "./useComposerAttachments";

const AttachmentViewer = lazy(() =>
  import("../../attachments/AttachmentViewer").then(m => ({ default: m.AttachmentViewer })));

// Everything animates with one transition: a card scaling in or out about its own center, the
// neighbours then sliding into the space it leaves, and the whole tray opening or closing.
const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const;
const CARD_HIDDEN = { opacity: 0, scale: 0.9 };
const CARD_SHOWN = { opacity: 1, scale: 1 };
const TRAY_HIDDEN = { opacity: 0, height: 0 };
const TRAY_SHOWN = { opacity: 1, height: "auto" };
// When the last card is removed, the tray only starts to close once that card has fully left.
const TRAY_CLOSE_TRANSITION = { ...TRANSITION, delay: TRANSITION.duration };

export const ComposerAttachmentTray = ({
  attachments,
  disabled = false,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  disabled?: boolean;
  onRemove: (attachmentId: string) => void;
}) => {
  const open = attachments.length > 0;
  const [viewedId, setViewedId] = useState<string | null>(null);
  // The files are still on this device, so they are read from there, uploaded or not.
  const { content, forgetFailures } = useAttachmentContents(async (id) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    if (!attachment) throw new Error("The attachment was removed.");
    return new Uint8Array(await attachment.blob.arrayBuffer());
  }, attachments.map((attachment) => attachment.id));
  const viewed = attachments.some((attachment) => attachment.id === viewedId);

  return (
    <MotionConfig reducedMotion="user" transition={TRANSITION}>
      {/* The tray stays mounted and is opened and closed by animating, rather than unmounted.
          Unmounting it would freeze its contents, so the last card could not animate out. */}
      <motion.div
        initial={false}
        animate={open ? TRAY_SHOWN : TRAY_HIDDEN}
        transition={open ? TRANSITION : TRAY_CLOSE_TRANSITION}
        className="overflow-hidden"
      >
        <ul
          aria-label="Attachments"
          aria-hidden={!open}
          className="m-0 flex list-none gap-2 overflow-x-auto px-3 pb-2 pt-3"
        >
          {/* A leaving card keeps its place until it has fully gone; only then do its
              neighbours slide over (their `layout` animation). */}
          <AnimatePresence initial={false}>
            {attachments.map((attachment) => (
              <motion.li
                key={attachment.id}
                layout="position"
                initial={CARD_HIDDEN}
                animate={CARD_SHOWN}
                exit={CARD_HIDDEN}
                className="shrink-0"
              >
                <ComposerAttachmentCard
                  attachment={attachment}
                  disabled={disabled}
                  loadContent={() => content(attachment.id)}
                  onOpen={() => {
                    forgetFailures();
                    setViewedId(attachment.id);
                  }}
                  onRemove={() => onRemove(attachment.id)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </motion.div>
      {viewed && viewedId !== null && (
        <Suspense fallback={null}>
          <AttachmentViewer
            attachments={attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.blob.size,
            }))}
            openId={viewedId}
            onOpenChange={setViewedId}
            loadContent={content}
            onRetry={forgetFailures}
          />
        </Suspense>
      )}
    </MotionConfig>
  );
};
