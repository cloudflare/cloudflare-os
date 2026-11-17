import { useEffect, useMemo, useState } from 'react'
import { asideItemFor, type AsideItem } from '@/aside/asideItems'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { AgentRow } from '@/blocks/AgentRow'
import { AutomationRow } from '@/blocks/AutomationRow'
import { ListGroup } from '@/blocks/ListGroup'
import { Button } from '@/components/Button'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaceChats } from '@/workspaces/useWorkspaceChats'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { agentsOf, runsWords } from './agents'
import type { Automation } from './automations'
import { cadenceWords, scheduleStanding } from './cadence'
import { useAutomations } from './useAutomations'

export type AutomationsTabProps = {
  workspaceId: string
  /** The chat whose automations these are, whose gadgets open with its changes. */
  chatId?: number
  /** Which of the workspace's are shown, such as those a chat set up. All when absent. */
  filter?: (automation: Automation) => boolean
  /** Shows the gadget an automation runs. */
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
  /**
   * Opens one of the workspace's chats: given, the agents its gadgets call on are listed after
   * the automations, each opening its latest run.
   */
  onOpenChat?: (chat: { id: number; title: string }) => void
  /** A chat's address, for an agent's row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /** What the tab says while there is nothing to list. */
  empty: string
}

const GROUPS = [
  { kind: 'schedule', label: 'Scheduled' },
  { kind: 'event', label: 'When something happens' },
] as const

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What runs by itself in a workspace, as a tab of a page: the scheduled tasks, then what an event
 * sets off, each saying when it runs and when next or why it stopped, what it does and the gadget
 * it runs, with its switch for whoever builds there. Then, where chats can be opened, the agents
 * its gadgets call on. The clock moves on while it is shown, so "next in 5 minutes" stays true.
 */
export const AutomationsTab = ({ workspaceId, chatId, filter, onOpenItem, itemHref, onOpenChat, chatHref, empty }: AutomationsTabProps) => {
  const { state, setEnabled } = useAutomations(workspaceId)
  const library = useChatLibrary({ workspaceId, chatId })
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const canChange = workspace !== undefined && workspace.role !== 'use'
  const connection = useConnectionNotice()
  // Why the last change to each, by its key, was refused.
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [])

  const shown = useMemo(
    () => (state.status === 'ready' ? (filter ? state.automations.filter(filter) : state.automations) : []),
    [state, filter],
  )
  // A gadget as its workspace lists it; one not listed yet is still opened, by its id alone, and
  // named for what it is rather than "Untitled", which it may not be.
  const gadgetOf = (gadgetId: number) => {
    const item = asideItemFor(workspaceId, { kind: 'output', workpieceId: gadgetId }, chatId, library.items)
    return { item, title: library.items.includes(item) ? item.title : 'its gadget' }
  }

  const change = (automation: Automation, enabled: boolean) => {
    if (connection?.blocked()) return
    setProblems(({ [automation.key]: _, ...rest }) => rest)
    return setEnabled(automation, enabled).catch((error: unknown) => {
      setProblems((current) => ({ ...current, [automation.key]: `Couldn’t turn it ${enabled ? 'on' : 'off'}: ${messageOf(error)}` }))
    })
  }

  if (state.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading automations…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
        Couldn’t load automations: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }

  return (
    <>
      {shown.length === 0 && !onOpenChat && <p className="px-4 text-center text-base text-pretty text-kumo-subtle">{empty}</p>}
      {GROUPS.map(({ kind, label }) => {
        const rows = shown.filter((automation) => automation.kind === kind)
        if (rows.length === 0) return null
        return (
          <section key={kind} className="flex flex-col gap-2">
            <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
            <ListGroup label={label}>
              {rows.map((automation) => {
                const { hook, schedule } = automation
                const { item, title } = gadgetOf(hook.gadgetId)
                return (
                  <AutomationRow
                    key={automation.key}
                    kind={automation.kind}
                    title={hook.description.title}
                    when={schedule && cadenceWords(schedule.cadence)}
                    standing={schedule && scheduleStanding(schedule, now)}
                    description={hook.description.description || undefined}
                    // A schedule's resource is the scheduler itself, which says nothing.
                    resource={automation.kind === 'event' && hook.resourceTitle ? { title: hook.resourceTitle, url: hook.resourceUrl } : undefined}
                    gadget={{ title, href: itemHref?.(item), onOpen: () => onOpenItem(item) }}
                    enabled={hook.enabled}
                    onEnabledChange={canChange ? (enabled) => change(automation, enabled) : undefined}
                    problem={problems[automation.key]}
                  />
                )
              })}
            </ListGroup>
          </section>
        )
      })}
      {onOpenChat && <WorkspaceAgents workspaceId={workspaceId} onOpenChat={onOpenChat} chatHref={chatHref} now={now} empty={shown.length === 0 ? empty : undefined} />}
    </>
  )
}

type WorkspaceAgentsProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
  chatHref?: (chatId: number) => string
  now: number
  /** What is said when there are no agents either. */
  empty?: string
}

/** The agents a workspace's gadgets call on, by their runs among its chats. */
const WorkspaceAgents = ({ workspaceId, onOpenChat, chatHref, now, empty }: WorkspaceAgentsProps) => {
  const chats = useWorkspaceChats(workspaceId)
  const agents = useMemo(() => (chats.status === 'ready' ? agentsOf(chats.chats) : []), [chats])
  if (chats.status === 'loading') return null
  if (agents.length === 0) return empty ? <p className="px-4 text-center text-base text-pretty text-kumo-subtle">{empty}</p> : null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-4 text-sm font-medium text-kumo-subtle">Agents</h2>
      <ListGroup label="Agents">
        {agents.map((agent) => {
          const [latest] = agent.runs
          return (
            <AgentRow
              key={agent.key}
              name={agent.name}
              runs={runsWords(agent, new Date(now))}
              href={chatHref?.(latest.chatId)}
              onSelect={() => onOpenChat({ id: latest.chatId, title: latest.title })}
            />
          )
        })}
      </ListGroup>
    </section>
  )
}
