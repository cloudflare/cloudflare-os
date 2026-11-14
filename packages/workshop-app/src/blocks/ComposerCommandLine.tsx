import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { CommandIcon, type ComposerCommand } from './ComposerCommandPicker'

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

/**
 * The skill or command a draft is sent with, as one line at the top of the composer, the way a
 * reply's is (`ComposerReply`): its name and what it is for, with the way to send words alone
 * again. What is typed below it is what the skill is given. It opens and closes as that line does,
 * and says in its place why it cannot be sent yet, when it cannot.
 */
export const ComposerCommandLine = ({ command, refusal, onCancel }: {
  /** Left out while the draft is words alone. */
  command?: ComposerCommand
  /** Why it cannot be sent as the draft is, such as files attached that a command cannot carry. */
  refusal?: string
  onCancel: () => void
}) => {
  // The line stays written while the row closes.
  const [written, setWritten] = useState(command)
  if (command !== undefined && command !== written) setWritten(command)
  const open = command !== undefined
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION

  return (
    <motion.div
      initial={false}
      animate={open ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
      transition={transition}
      className="overflow-hidden"
      inert={!open}
    >
      <div className="px-1.5 pt-1.5">
        <div className="flex h-9 items-center gap-2 rounded-[15px] bg-kumo-base ps-3 pe-1.5 text-sm ring-1 ring-kumo-line ring-inset" title={written?.description}>
          {written && <CommandIcon command={written} className="size-4 shrink-0 text-kumo-default" />}
          <span className="sr-only">{written?.kind === 'skill' ? 'Using the skill:' : 'Command:'}</span>
          <span className="shrink-0 font-medium text-kumo-default">{written?.title}</span>
          <span className={refusal ? 'min-w-0 flex-1 truncate text-kumo-danger' : 'min-w-0 flex-1 truncate text-kumo-subtle'} role={refusal ? 'alert' : undefined}>
            {open && refusal ? refusal : written?.description}
          </span>
          <Button
            variant="ghost"
            icon={<XIcon weight="bold" />}
            aria-label={written?.kind === 'skill' ? 'Don’t use the skill' : 'Remove the command'}
            title={written?.kind === 'skill' ? 'Don’t use the skill' : 'Remove the command'}
            onClick={onCancel}
            className="size-6 text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3"
          />
        </div>
      </div>
    </motion.div>
  )
}
