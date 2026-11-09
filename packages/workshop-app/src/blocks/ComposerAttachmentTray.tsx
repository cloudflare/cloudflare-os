import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { ComposerAttachmentCard } from './ComposerAttachmentCard'
import type { ComposerAttachment } from './useComposerAttachments'

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const
const CARD_HIDDEN = { opacity: 0, scale: 0.9 }
const CARD_SHOWN = { opacity: 1, scale: 1 }

export const ComposerAttachmentTray = ({ attachments, onRemove }: {
  attachments: readonly ComposerAttachment[]
  onRemove: (id: string) => void
}) => {
  const open = attachments.length > 0
  const reducedMotion = useReducedMotion()
  const transition = reducedMotion ? { duration: 0 } : TRANSITION

  return (
    <MotionConfig reducedMotion="user" transition={transition}>
      {/* Stay mounted so the final card can leave before the tray closes. Its natural height
          drives the form directly, without a second measured-height animation chasing it. */}
      <motion.div
        initial={false}
        animate={open ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
        transition={open || reducedMotion ? transition : { ...transition, delay: TRANSITION.duration }}
        className="overflow-hidden"
        inert={!open}
      >
        <ul aria-label="Attachments" aria-hidden={!open} className="m-0 flex list-none gap-2 overflow-x-auto p-3 [scrollbar-width:thin]">
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
                <ComposerAttachmentCard attachment={attachment} onRemove={() => onRemove(attachment.id)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </motion.div>
    </MotionConfig>
  )
}
