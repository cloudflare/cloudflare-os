import { RobotIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'

export type AgentRowProps = {
  name: string
  /** What it is and has done, in words: "Started by Inbox · 12 runs · latest 5 min ago". */
  detail: string
  /**
   * What it wants of the user, in words, in place of `detail`: a run waiting on them (`warning`),
   * or a latest run that failed (`danger`).
   */
  attention?: { words: string; tone: 'warning' | 'danger' }
  /** One of its runs is at work now. */
  running?: boolean
  /** Its page's address, so that it can be opened in another tab. */
  href?: string
  /** Opens its page. */
  onSelect: () => void
}

/**
 * An agent in a workspace's list of them: a robot, its name over what it is and has done, or over
 * what it wants of the user, with a dot on the robot's corner in the colour of that, or of a run
 * at work. The row opens the agent's page.
 */
export const AgentRow = ({ name, detail, attention, running = false, href, onSelect }: AgentRowProps) => {
  const dot = attention ? (attention.tone === 'warning' ? 'bg-kumo-warning' : 'bg-kumo-danger') : running ? 'bg-(--color-live)' : undefined
  return (
    <LinkButton
      href={href}
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5"
    >
      <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-default">
        <RobotIcon aria-hidden="true" className="size-5" />
        {dot && <span aria-hidden="true" className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-kumo-tint', dot, !attention && 'motion-safe:animate-pulse')} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate font-medium text-kumo-default">{name}</span>
        {attention
          ? <span className={cn('truncate', attention.tone === 'warning' ? 'text-kumo-warning' : 'text-kumo-danger')}>{attention.words}</span>
          : <span className="truncate text-kumo-subtle">{running ? `Running now · ${detail}` : detail}</span>}
      </span>
    </LinkButton>
  )
}
