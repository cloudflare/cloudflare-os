import { useState } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { itemPage, outputPage } from '@/aside/asideItems'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { useNow } from '@/hooks/useNow'
import { outputKey, outputTitle } from '@/library/libraryList'
import { useLibrary } from '@/library/useLibrary'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'
import { automationList, type ListedAutomation } from './automationList'
import { AutomationsView } from './AutomationsView'
import { cadenceWords, scheduleState } from './cadence'
import { useAllAutomations } from './useAllAutomations'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The Automations page (`AutomationsView`) over what it lists: every workspace's automations
 * (`useAllAutomations`), each named with its workspace and the gadget it runs, from the library,
 * which open them; its switch and its deletion for whoever builds there, as on a workspace's tab; and, with none,
 * a chat started from one of the things to ask for. The clock moves on while it is shown, so
 * "next in 5 minutes" stays true. It starts searched for `query` where a link to it asks for one.
 */
export const AutomationsPane = ({ query }: { query?: string }) => {
  const { state, setEnabled, remove } = useAllAutomations()
  const workspaces = useWorkspaces()
  const library = useLibrary()
  const looks = useWorkspaceLooks()
  const navigate = useNavigate()
  const router = useRouter()
  const connection = useConnectionNotice()
  const narrow = useNarrowScreen()
  const now = useNow()
  // Why the last change to each, by its key, was refused.
  const [problems, setProblems] = useState<Record<string, string>>({})
  useDocumentTitle('Automations')

  const listedWorkspaces = workspaces.status === 'ready' ? workspaces.workspaces : []
  const titleOf = (workspaceId: string) => {
    const workspace = listedWorkspaces.find(({ id }) => id === workspaceId)
    return workspace ? workspaceTitle(workspace) : 'Untitled workspace'
  }
  const outputs = new Map(library.status === 'ready' ? library.outputs.map((output) => [outputKey(output), output]) : [])
  const listed: ListedAutomation[] = state.automations.map((automation) => {
    const output = outputs.get(outputKey({ workspaceId: automation.workspaceId, workpieceId: automation.hook.gadgetId }))
    return { ...automation, workspaceTitle: titleOf(automation.workspaceId), gadgetTitle: output && outputTitle(output) }
  })
  const list = useListView('automations', { ...automationList(listed, looks), startsSearchedFor: query })
  const groups = list.arrange(list.narrow(listed))

  const change = (automation: ListedAutomation, enabled: boolean) => {
    if (connection?.blocked()) return
    setProblems(({ [automation.key]: _, ...rest }) => rest)
    return setEnabled(automation, enabled).catch((error: unknown) => {
      setProblems((current) => ({ ...current, [automation.key]: `Couldn’t turn it ${enabled ? 'on' : 'off'}: ${messageOf(error)}` }))
    })
  }
  // Refused while the connection is down, which the island says; anything else is said where it was asked.
  const removeOne = async (automation: ListedAutomation) => {
    if (connection?.blocked()) return
    await remove(automation)
  }

  const rowOf = (automation: ListedAutomation) => {
    const { hook, schedule, workspaceId } = automation
    const canChange = listedWorkspaces.find(({ id }) => id === workspaceId)?.role !== 'use'
    const output = outputs.get(outputKey({ workspaceId, workpieceId: hook.gadgetId }))
    const gadgetPage = output ? outputPage(output) : itemPage(workspaceId, { kind: 'output', workpieceId: hook.gadgetId }, true)
    const workspacePage = { to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'automations' } } as const
    return {
      kind: automation.kind,
      title: hook.description.title,
      when: schedule && cadenceWords(schedule.cadence),
      ...(schedule && scheduleState(schedule, now)),
      description: hook.description.description || undefined,
      // A schedule's resource is the scheduler itself, which says nothing.
      resource: automation.kind === 'event' && hook.resourceTitle ? { title: hook.resourceTitle, url: hook.resourceUrl } : undefined,
      // One the library has not listed yet is still opened, by its id alone, and named for what
      // it is rather than "Untitled", which it may not be.
      gadget: {
        title: output ? outputTitle(output) : 'its gadget',
        href: router.buildLocation(gadgetPage).href,
        onOpen: () => void navigate(gadgetPage),
      },
      workspace: {
        title: automation.workspaceTitle,
        icon: <WorkspaceIcon label={workspaceLabel(automation.workspaceTitle)} {...looks[workspaceId]} small />,
        href: router.buildLocation(workspacePage).href,
        onOpen: () => void navigate(workspacePage),
      },
      enabled: hook.enabled,
      onEnabledChange: canChange ? (enabled: boolean) => change(automation, enabled) : undefined,
      onDelete: canChange ? () => removeOne(automation) : undefined,
      problem: problems[automation.key],
    }
  }

  return (
    <AutomationsView
      status={state.status}
      groups={groups.map(({ key, label, entries }) => ({ key, label, rows: entries.map(({ value }) => ({ key: value.key, row: rowOf(value) })) }))}
      total={listed.length}
      reading={state.reading}
      unreachable={state.unreachable.map(titleOf)}
      controls={list.controls}
      onShowAll={list.showAll}
      onTry={(prompt) => void navigate({ to: '/', state: { draft: prompt } })}
      narrow={narrow}
    />
  )
}
