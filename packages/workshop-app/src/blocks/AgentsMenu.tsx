import { ClockIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { DropdownMenu } from '@/components/DropdownMenu'
import { KindMark } from '@/components/KindMark'

/** An agent working for a gadget or a chat, as its header lists it. */
export type AgentsMenuAgent = {
  key: string
  name: string
  /** Its runs, in words: "12 runs · latest 5 min ago", or that there are none yet. */
  runs: string
  /** A run of it stopped on something only a person can decide. */
  waiting?: boolean
}

export type AgentsMenuProps = {
  /** The name of what they work for, which the menu's name says. */
  title: string
  /** Those working for it: a gadget's, those it calls on; a chat's, those its agent started. The one that ran last first. */
  agents: readonly AgentsMenuAgent[]
  /** When the latest run of any of them was, in words that follow "ran": "2 hours ago". Absent before any has run. */
  latest?: string
  /** Opens an agent's page, with its runs. */
  onOpenAgent: (key: string) => void
  /** Opens the automations of what they work for, which lists them too. */
  onOpenAutomations?: () => void
  /**
   * `true`: the button is its glyph alone, as on a phone or beside a chat. `'fit'`: it is, while
   * the header it is in (a size container, `@container`) is narrower than 36rem.
   */
  compact?: boolean | 'fit'
}

const AgentGlyph = ({ className }: { className?: string }) => <KindMark name="agent" className={className} />

/**
 * That agents are working for a gadget or a chat, and when they last did, at the end of its
 * header: the agent's name, or how many there are, and the time of the latest run, or that one
 * waits on the viewer. Its menu lists them with their runs, each opening its page, so what they do
 * is seen without reading their conversations; then the automations of what they work for.
 * Nothing, while none are.
 */
export const AgentsMenu = ({ title, agents, latest, onOpenAgent, onOpenAutomations, compact = false }: AgentsMenuProps) => {
  if (agents.length === 0) return null
  const waiting = agents.some((agent) => agent.waiting)
  const who = agents.length === 1 ? agents[0].name : `${agents.length} agents`
  const when = waiting ? 'waiting on you' : latest && `ran ${latest}`
  const summary = when ? `${who} · ${when}` : who
  const fit = compact === 'fit'
  const menu = (
    <DropdownMenu
      icon={AgentGlyph}
      label={compact === true ? undefined : (
        <span className={cn('min-w-0 items-center gap-1.5', fit ? 'hidden @xl:flex' : 'flex')}>
          <span className="max-w-36 truncate">{who}</span>
          {when && (
            <span className={waiting ? 'flex shrink-0 items-center gap-1.5 text-kumo-warning' : 'shrink-0 text-kumo-subtle'}>
              {waiting && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />}
              {when}
            </span>
          )}
        </span>
      )}
      aria-label={`Agents for ${title}: ${summary}`}
      align="end"
      triggerClassName={compact === true ? undefined : fit ? 'aspect-square px-0 @xl:aspect-auto @xl:px-3' : 'px-3'}
    >
      {agents.map((agent) => (
        <DropdownMenu.Item key={agent.key} icon={AgentGlyph} label={agent.name} onSelect={() => onOpenAgent(agent.key)}>
          <span className="flex min-w-0 max-w-72 flex-col">
            <span className="truncate">{agent.name}</span>
            <span className="truncate text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">
              {agent.waiting ? <span className="text-kumo-warning">Waiting on you · </span> : null}
              {agent.runs}
            </span>
          </span>
        </DropdownMenu.Item>
      ))}
      {onOpenAutomations && <DropdownMenu.Separator />}
      {onOpenAutomations && <DropdownMenu.Item icon={ClockIcon} label="All automations" onSelect={onOpenAutomations}>All automations</DropdownMenu.Item>}
    </DropdownMenu>
  )
  // Its glyph alone says one waits as the sidebar's rows do, with a dot at its corner.
  return compact && waiting ? (
    <span className="relative flex">
      {menu}
      <span aria-hidden="true" className={cn('pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-kumo-warning ring-2 ring-kumo-canvas', fit && '@xl:hidden')} />
    </span>
  ) : menu
}
