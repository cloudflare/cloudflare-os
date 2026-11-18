import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { AgentMark } from './AgentMark'

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
 * An agent in a workspace's list of them: its mark, which smiles at the pointer or focus on the
 * row, its name over what it is and has done, or over what it wants of the user, with a dot on the
 * mark's corner in the colour of that, or of a run at work. The row opens the agent's page.
 */
export const AgentRow = ({ name, detail, attention, running = false, href, onSelect }: AgentRowProps) => {
  const [greeting, setGreeting] = useState(false)
  const dot = attention ? (attention.tone === 'warning' ? 'bg-kumo-warning' : 'bg-kumo-danger') : running ? 'bg-(--color-live)' : undefined
  return (
    <LinkButton
      href={href}
      onClick={onSelect}
      onPointerEnter={() => setGreeting(true)}
      onPointerLeave={() => setGreeting(false)}
      onFocus={() => setGreeting(true)}
      onBlur={() => setGreeting(false)}
      className="flex w-full items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5"
    >
      <span aria-hidden="true" className="relative shrink-0">
        <AgentMark state={running ? 'working' : attention?.tone === 'danger' ? 'failed' : 'idle'} greeting={greeting} />
        {dot && <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-kumo-tint', dot, !attention && 'motion-safe:animate-pulse')} />}
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
