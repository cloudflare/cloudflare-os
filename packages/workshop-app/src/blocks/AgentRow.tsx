import { CaretRightIcon, RobotIcon } from '@phosphor-icons/react'
import { LinkButton } from '@/components/LinkButton'

export type AgentRowProps = {
  name: string
  /** The model it thinks with, by name. */
  model?: string
  /** What calls on it, in words: "Called on by Tip jar". */
  calledBy?: string
  /** Its runs, in words: "12 runs · latest 5 min ago", or that there are none yet. */
  runs: string
  /** How many runs stopped on something only a person can decide. */
  waiting?: number
  href?: string
  onOpen: () => void
}

/**
 * An agent, as a row among automations: a robot in the round glyph automations have, its name, what
 * it thinks with and what calls on it, and its runs, those waiting on a person said apart. The row
 * opens its page.
 */
export const AgentRow = ({ name, model, calledBy, runs, waiting = 0, href, onOpen }: AgentRowProps) => (
  <LinkButton
    href={href}
    onClick={onOpen}
    className="group flex w-full items-start gap-3 rounded-2xl py-3 pr-3 pl-3 text-left text-base outline-none hover:bg-kumo-contrast/3 focus-visible:ring-2 focus-visible:ring-kumo-ring"
  >
    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-contrast/7 text-kumo-default">
      <RobotIcon className="size-[1.125rem]" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-px">
      <span className="truncate font-medium text-kumo-default">{name}</span>
      {(model || calledBy) && <span className="truncate text-sm/5 text-kumo-subtle">{[model && `Thinks with ${model}`, calledBy].filter(Boolean).join(' · ')}</span>}
      <span className="text-sm/5 text-kumo-subtle">
        {runs}
        {waiting > 0 && <span className="text-kumo-warning"> · {waiting === 1 ? 'One waits on you' : `${waiting} wait on you`}</span>}
      </span>
    </span>
    <CaretRightIcon aria-hidden="true" weight="bold" className="mt-2.5 size-3 shrink-0 text-kumo-subtle transition-[translate] duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
  </LinkButton>
)
