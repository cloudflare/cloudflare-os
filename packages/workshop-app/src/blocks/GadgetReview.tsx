import { useEffect, useId, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowSquareOutIcon, CaretLeftIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ServiceLogo } from '@/components/ServiceLogo'
import { usePending, type ActionResult } from './usePending'

export type GadgetReviewProps = {
  /** The gadget asking, which Back returns to. */
  gadgetTitle: string
  /** The file its changes are to. */
  title: string
  /** How many of them wait, and since when: "4 changes · since 9 min ago". */
  detail: string
  service?: { name: string; logoUrl?: string; color?: string }
  /** Where it opens in its own editor. */
  openIn?: { label: string; href: string }
  /**
   * Lets the gadget make changes of this kind from now on without asking, and approves those
   * waiting. Absent where its service asks every time, as for sending.
   */
  onAlwaysAllow?: () => ActionResult
  onClose: () => void
  /** The file, drawn as it will be, with its changes to step through (`ConnectedFileView`). */
  children: ReactNode
}

const EASE = [0.25, 0.1, 0.25, 1] as const

/**
 * A gadget's changes to a file, reviewed over the gadget: the file drawn as it will be, filling
 * the gadget's place, under a head that says whose changes they are, goes back to the gadget, opens
 * the file in its own editor, and lets the gadget make changes like these from now on without
 * asking. The changes are decided one by one, or all at once, on the file itself. Escape goes back.
 * Marked `data-gadget-review`, for whatever it covers to hide meanwhile, so that none of it shows
 * at the rounded corners they share.
 */
export const GadgetReview = ({ gadgetTitle, title, detail, service, openIn, onAlwaysAllow, onClose, children }: GadgetReviewProps) => {
  const id = useId()
  const reduced = useReducedMotion()
  const [pending, run] = usePending()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // Its surface is there at once, as what it covers is hidden at once; only what is on it fades in.
    <section
      role="dialog"
      data-gadget-review=""
      aria-labelledby={`${id}-title`}
      className="absolute inset-0 z-20 flex min-h-0 flex-col bg-kumo-base"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduced ? { duration: 0 } : { duration: 0.18, ease: EASE }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-kumo-line px-3 py-2">
          <Button variant="ghost" icon={CaretLeftIcon} onClick={onClose}>{gadgetTitle}</Button>
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            {service && <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} />}
            <span className="flex min-w-0 flex-col">
              <span id={`${id}-title`} className="truncate text-base/5 font-medium text-kumo-default">{title}</span>
              <span className="truncate text-sm text-kumo-subtle">{detail}</span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {openIn && (
              <a
                href={openIn.href}
                target="_blank"
                rel="noreferrer"
                className="flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-kumo-default outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring"
              >
                {openIn.label}
                <ArrowSquareOutIcon aria-hidden="true" className="size-4 text-kumo-subtle" />
              </a>
            )}
            {onAlwaysAllow && <Button disabled={pending} onClick={() => run(onAlwaysAllow)}>Always allow</Button>}
          </span>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      </motion.div>
    </section>
  )
}
