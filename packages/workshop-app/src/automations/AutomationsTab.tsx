import { useMemo, useState } from 'react'
import { asideItemFor, type AsideItem } from '@/aside/asideItems'
import { useChatLibrary } from '@/aside/useChatLibrary'
import { AutomationRow } from '@/blocks/AutomationRow'
import { Button, ListGroup } from '@gadgets/ui'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { Automation } from './automations'
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
  /** What the tab says while there is nothing to list. */
  empty: string
}

const GROUPS = [
  { key: 'on', label: 'On', has: (automation: Automation) => automation.hook.enabled },
  { key: 'paused', label: 'Paused', has: (automation: Automation) => !automation.hook.enabled },
] as const

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What runs by itself in a workspace, as a tab of a page: what is on, then what is paused, newest
 * first, each saying what it does, what it watches and the gadget it runs, with its switch for
 * whoever builds there. The agents those gadgets start have a tab of their own (`AgentsTab`).
 */
export const AutomationsTab = ({ workspaceId, chatId, filter, onOpenItem, itemHref, empty }: AutomationsTabProps) => {
  const { state, setEnabled } = useAutomations(workspaceId)
  const library = useChatLibrary({ workspaceId, chatId })
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const canChange = workspace !== undefined && workspace.role !== 'use'
  const connection = useConnectionNotice()
  // Why the last change to each, by its key, was refused.
  const [problems, setProblems] = useState<Record<string, string>>({})

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
      {shown.length === 0 && <p className="px-4 text-center text-base text-pretty text-kumo-subtle">{empty}</p>}
      {GROUPS.map(({ key, label, has }) => {
        const rows = shown.filter(has)
        if (rows.length === 0) return null
        return (
          <section key={key} className="flex flex-col gap-2">
            <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
            <ListGroup label={label}>
              {rows.map((automation) => {
                const { hook } = automation
                const { item, title } = gadgetOf(hook.gadgetId)
                return (
                  <AutomationRow
                    key={automation.key}
                    title={hook.description.title}
                    description={hook.description.description || undefined}
                    resource={hook.resourceTitle ? { title: hook.resourceTitle, url: hook.resourceUrl } : undefined}
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
    </>
  )
}
