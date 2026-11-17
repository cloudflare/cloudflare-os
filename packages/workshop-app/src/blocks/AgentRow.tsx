import { RobotIcon } from '@phosphor-icons/react'
import { LinkButton } from '@/components/LinkButton'

export type AgentRowProps = {
  name: string
  /** Its runs, in words: "12 runs · latest 5 min ago". */
  runs: string
  /** Its latest run's address, so that it can be opened in another tab. */
  href?: string
  /** Opens its latest run. */
  onSelect: () => void
}

/**
 * An agent a workspace's gadgets call on, as a row among its automations: a robot, its name over
 * its runs. The row opens the latest of them.
 */
export const AgentRow = ({ name, runs, href, onSelect }: AgentRowProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    className="flex w-full items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5"
  >
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-default">
      <RobotIcon aria-hidden="true" className="size-5" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col leading-snug">
      <span className="truncate font-medium text-kumo-default">{name}</span>
      <span className="truncate text-kumo-subtle">{runs}</span>
    </span>
  </LinkButton>
)
