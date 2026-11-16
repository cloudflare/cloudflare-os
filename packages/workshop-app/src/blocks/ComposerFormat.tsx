import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

export type ComposerFormatProps = {
  /** What the draft asks for something as. Left out while it asks for nothing in particular. */
  format?: { noun: string; icon: FormatIconName }
  onRemove: () => void
}

/**
 * The format a draft starts with (a Document, a Spreadsheet, …), as one line at the top of the
 * composer, with the way to make it an ordinary message again. It opens and closes the way the
 * reply line above it does.
 */
export const ComposerFormat = ({ format, onRemove }: ComposerFormatProps) => {
  // The line stays written while the row closes.
  const [written, setWritten] = useState(format)
  if (format && (format.noun !== written?.noun || format.icon !== written?.icon)) setWritten(format)
  const open = format !== undefined
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION

  return (
    <motion.div
      initial={false}
      animate={open ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
      transition={transition}
      className="overflow-hidden"
      inert={!open}
    >
      {/* As far in from the composer's edge as the buttons at its bottom, with a corner that
          follows the composer's. */}
      <div className="px-1.5 pt-1.5">
        <div className="flex h-9 items-center gap-2 rounded-[15px] bg-kumo-base ps-3 pe-1.5 text-sm text-kumo-subtle ring-1 ring-kumo-line ring-inset">
          <FormatIcon name={written?.icon} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Start with <span className="font-medium text-kumo-default">{written?.noun}</span>
          </span>
          {/* Quiet until pointed at, as the actions beside a message are. */}
          <Button
            variant="ghost"
            icon={<XIcon weight="bold" />}
            aria-label={`Don’t start with ${written?.noun}`}
            title="Remove"
            onClick={onRemove}
            className="size-6 text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3"
          />
        </div>
      </div>
    </motion.div>
  )
}
