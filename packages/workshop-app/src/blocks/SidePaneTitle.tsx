import type { ReactElement } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretRightIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

export type SidePaneTitleProps = {
  title: string
  /** What kind of thing it is, before its name. */
  icon?: ReactElement
  /**
   * A part of it being looked at in its place, such as a gadget's code: after its name, which goes
   * back to it.
   */
  trail?: { label: string; icon?: ReactElement; onBack: () => void }
}

const icon = (element: ReactElement) => <span className="flex shrink-0 [&>svg]:size-[1.125em]">{element}</span>

/**
 * The name of what is shown in the side pane, as a bubble shaped like a button. Looking at a part of
 * it in its place, the part follows the name, as a path does, and the name, quieter, is a button
 * back: the trail grows out of the bubble, and the name keeps its place.
 */
export const SidePaneTitle = ({ title, icon: kind, trail }: SidePaneTitleProps) => {
  const reduceMotion = useReducedMotion() ?? false
  return (
    <span className={cn('inline-flex h-(--control-size) min-w-0 items-center rounded-full bg-kumo-base text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line', trail ? 'ps-1 pe-(--control-pad)' : kind ? 'ps-(--control-pad-icon) pe-(--control-pad)' : 'px-(--control-pad)')}>
      {trail ? (
        <button
          type="button"
          onClick={trail.onBack}
          title={`Back to ${title}`}
          aria-label={`Back to ${title}`}
          className={cn(
            'flex h-[calc(var(--control-size)-8px)] min-w-0 cursor-pointer items-center gap-2 rounded-full text-kumo-subtle outline-none transition-colors duration-150 hover:bg-kumo-fill hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring',
            kind ? 'ps-[calc(var(--control-pad-icon)-4px)] pe-2' : 'px-2',
          )}
        >
          {kind && icon(kind)}
          <span className="truncate">{title}</span>
        </button>
      ) : (
        <>
          {kind && <span className="me-2 flex text-kumo-subtle">{icon(kind)}</span>}
          <span className="truncate">{title}</span>
        </>
      )}
      <AnimatePresence initial={false}>
        {trail && (
          <motion.span
            key="trail"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, width: 'auto' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0 }}
            transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
            className="flex shrink-0 items-center overflow-hidden whitespace-nowrap"
          >
            <CaretRightIcon aria-hidden="true" weight="bold" className="me-1.5 size-3 shrink-0 text-kumo-subtle/70" />
            <span aria-current="page" className="flex items-center gap-1.5">
              {trail.icon && <span className="text-kumo-subtle">{icon(trail.icon)}</span>}
              {trail.label}
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}
