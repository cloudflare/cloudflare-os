import { ClockIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import { KindMark } from '@/components/KindMark'

/** An agent a gadget calls on, as its header lists it. */
export type GadgetAgentsMenuAgent = {
  key: string
  name: string
  /** Its runs, in words: "12 runs · latest 5 min ago", or that there are none yet. */
  runs: string
  /** A run of it stopped on something only a person can decide. */
  waiting?: boolean
}

export type GadgetAgentsMenuProps = {
  /** The gadget's name, which the menu says the agents work for. */
  title: string
  /** Those it calls on, the one that ran last first. */
  agents: readonly GadgetAgentsMenuAgent[]
  /** When the latest run of any of them was, in words that follow "ran": "2 hours ago". Absent before any has run. */
  latest?: string
  /** Opens an agent's page, with its runs. */
  onOpenAgent: (key: string) => void
  /** Opens the gadget's automations, for whoever may change them. */
  onOpenAutomations?: () => void
  /** The button is its glyph alone, as on a phone or beside a chat. */
  compact?: boolean
}

const AgentGlyph = ({ className }: { className?: string }) => <KindMark name="agent" className={className} />

/**
 * That a gadget has agents working for it, and when they last did, at the end of its header: the
 * agent's name, or how many there are, and the time of the latest run, marked when one waits on
 * the viewer. Its menu lists them with their runs, each opening its page, so their conversations
 * are a step away without having to be read; and then the gadget's automations. Nothing, for a
 * gadget that calls on none.
 */
export const GadgetAgentsMenu = ({ title, agents, latest, onOpenAgent, onOpenAutomations, compact = false }: GadgetAgentsMenuProps) => {
  if (agents.length === 0) return null
  const waiting = agents.some((agent) => agent.waiting)
  const who = agents.length === 1 ? agents[0].name : `${agents.length} agents`
  const when = waiting ? 'waiting on you' : latest && `ran ${latest}`
  const summary = when ? `${who} · ${when}` : who
  const dot = waiting && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />
  const menu = (
    <DropdownMenu
      icon={AgentGlyph}
      label={compact ? undefined : (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-36 truncate">{who}</span>
          {when && <span className={waiting ? 'flex shrink-0 items-center gap-1.5 text-kumo-warning' : 'shrink-0 text-kumo-subtle'}>{dot}{when}</span>}
        </span>
      )}
      aria-label={`Agents for ${title}: ${summary}`}
      align="end"
      triggerClassName={compact ? undefined : 'px-3'}
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
      <span aria-hidden="true" className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-kumo-warning ring-2 ring-kumo-canvas" />
    </span>
  ) : menu
}
