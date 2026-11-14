import { useEffect, useMemo, useState } from 'react'
import { AutomationRow } from '@/blocks/AutomationRow'
import { ListGroup } from '@/blocks/ListGroup'
import { useLibrary } from '@/library/useLibrary'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useChatThreads, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { placeOf, type Automation, type AutomationPlace } from './automations'
import { cadenceWords, scheduleStanding } from './cadence'
import { useAutomations } from './useAutomations'

/** Where a place in a workspace is, for an automation's row to open and link to. */
export type AutomationLink = (workspaceId: string, place: AutomationPlace) => { href?: string; onOpen: () => void }

export type AutomationsTabProps = {
  /** The workspaces whose automations are listed: one, or all of the user's. */
  workspaceIds: readonly string[] | undefined
  /** Which of them are shown, such as a chat's or a gadget's. All when absent. */
  filter?: (automation: Automation) => boolean
  /** Whether each place says its workspace too, as across workspaces. */
  withWorkspace?: boolean
  /** Newest first, as they come, or by name. */
  order?: 'recent' | 'name'
  /** Words their names or what they do must have, as the Library's search. */
  query?: string
  /** Whether the viewer may turn them on and off, and delete them, in a workspace. */
  canChange: (workspaceId: string) => boolean
  link: AutomationLink
  /** What the tab says while there are none. */
  empty: string
}

const GROUPS = [
  { kind: 'schedule', label: 'Scheduled' },
  { kind: 'event', label: 'When something happens' },
] as const

// What an event hook was asked to watch, when it says.
const watching = ({ hook }: Automation) => (hook.resourceTitle ? `Watches ${hook.resourceTitle}` : undefined)

/**
 * Automations, as a tab of a page: the scheduled ones, then those an event sets off, each saying
 * when it runs, when next or why it stopped, what it does and where it reports, with its switch
 * and Delete for whoever builds where it is. What each reports to is named from the chats and
 * gadgets already listed elsewhere. Nothing is read until shown, and the clock moves on while it
 * is.
 */
export const AutomationsTab = ({ workspaceIds, filter, withWorkspace, order = 'recent', query = '', canChange, link, empty }: AutomationsTabProps) => {
  const { list, snapshot } = useAutomations(workspaceIds)
  const connection = useConnectionNotice()
  const chats = useChatThreads()
  const workspaces = useWorkspaces()
  const all = useMemo(
    () => (snapshot.status === 'ready' ? (filter ? snapshot.automations.filter(filter) : snapshot.automations) : []),
    [snapshot, filter],
  )
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const found = all.filter(({ hook: { description } }) => {
      const text = `${description.title} ${description.description}`.toLowerCase()
      return words.every((word) => text.includes(word))
    })
    return order === 'name' ? found.toSorted((a, b) => a.hook.description.title.localeCompare(b.hook.description.title)) : found
  }, [all, query, order])
  // Gadgets' names, read only when one is a gadget's.
  const library = useLibrary(all.some(({ hook }) => hook.chatId === undefined) ? 'automations' : null)
  // "next in 5 minutes" stays true while the tab is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [])

  const workspaceTitle = (id: string) => (workspaces.status === 'ready' ? workspaces.workspaces.find((each) => each.id === id)?.title : undefined)
  const label = (automation: Automation) => {
    const place = placeOf(automation)
    const name = place.type === 'chat'
      ? chats?.find((chat) => chat.workspaceId === automation.workspaceId && chat.chatId === place.chatId)?.chatTitle || 'Chat'
      : (library.status === 'ready' ? library.outputs.find((output) => output.workspaceId === automation.workspaceId && output.workpieceId === place.gadgetId)?.title : undefined) || 'Gadget'
    const where = withWorkspace ? workspaceTitle(automation.workspaceId) : undefined
    return where && where !== name ? `${name} · ${where}` : name
  }

  if (snapshot.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading automations…</p>
  if (snapshot.status === 'failed') return <p role="alert" className="px-4 text-center text-base text-kumo-danger">Couldn’t load automations. {snapshot.message}</p>
  if (all.length === 0) return <p className="px-4 text-center text-base text-pretty text-kumo-subtle">{empty}</p>
  if (shown.length === 0) return <p className="px-4 text-center text-base text-kumo-subtle">No automation here says “{query.trim()}”.</p>

  return (
    <div className="flex flex-col gap-6">
      {GROUPS.map(({ kind, label: groupLabel }) => {
        const rows = shown.filter((automation) => automation.kind === kind)
        if (rows.length === 0) return null
        return (
          <section key={kind} className="flex flex-col gap-2">
            <h2 className="px-4 text-sm font-medium text-kumo-subtle">{groupLabel}</h2>
            <ListGroup label={groupLabel}>
              {rows.map((automation) => {
                const { hook, schedule, workspaceId } = automation
                const place = placeOf(automation)
                const changes = canChange(workspaceId) && list !== undefined
                return (
                  <AutomationRow
                    key={automation.key}
                    kind={automation.kind}
                    title={hook.description.title}
                    when={schedule ? cadenceWords(schedule.cadence) : automation.kind === 'event' ? watching(automation) : undefined}
                    standing={schedule && scheduleStanding(schedule, now)}
                    description={hook.description.description || undefined}
                    place={{ kind: place.type, label: label(automation), ...link(workspaceId, place) }}
                    enabled={hook.enabled}
                    onEnabledChange={changes ? async (enabled) => {
                      if (connection?.blocked()) return
                      await list.setEnabled(automation, enabled)
                    } : undefined}
                    onDelete={changes ? async () => {
                      if (connection?.blocked()) return false
                      await list.remove(automation)
                      return true
                    } : undefined}
                  />
                )
              })}
            </ListGroup>
          </section>
        )
      })}
      {snapshot.unread > 0 && (
        <p className="px-4 text-sm text-kumo-subtle">
          {snapshot.unread === 1 ? 'One workspace’s automations' : `${snapshot.unread} workspaces’ automations`} couldn’t be read, so aren’t here.
        </p>
      )}
    </div>
  )
}
