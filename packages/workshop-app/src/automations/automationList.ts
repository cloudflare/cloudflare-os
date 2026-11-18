import { createElement } from 'react'
import { groupByName } from '@/components/nameGroups'
import type { ArrangedGroup, ListFilter, ListOrder } from '@/components/listView'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { ListViewSpec } from '@/hooks/useListView'
import type { WorkspaceLooksById } from '@/workspaces/WorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import type { Automation } from './automations'
import { cadenceWords } from './cadence'

/** An automation as the Automations page lists it, with the names of where it is and what it runs. */
export type ListedAutomation = Automation & {
  workspaceTitle: string
  /** The gadget it runs, by its title, where the library has it. */
  gadgetTitle?: string
}

/** Whether a schedule needs seeing to: it stopped, or its last run failed and it is trying again. */
export const needsAttention = ({ hook, schedule }: Automation) =>
  hook.enabled && (schedule?.status === 'dead' || (schedule?.status === 'active' && schedule.retrying === true))

const title = ({ hook }: Automation) => hook.description.title
const byTitle = (a: Automation, b: Automation) => title(a).localeCompare(title(b))
// When a schedule runs next, where it is to run again and that is known.
const nextFire = ({ schedule }: Automation) => (schedule?.status === 'active' ? schedule.nextFire : undefined) ?? Infinity
// Soonest first; one with no time known after those that have one.
const bySoonest = (a: Automation, b: Automation) => nextFire(a) - nextFire(b) || byTitle(a, b)

/**
 * The groups of the first order, each its own however few it has: what needs seeing to, the
 * scheduled ones that are on (soonest first), what an event sets off, then what is paused.
 */
const STANDINGS = [
  { key: 'attention', label: 'Needs attention', has: needsAttention, order: byTitle },
  { key: 'schedule', label: 'Scheduled', has: (each: Automation) => each.hook.enabled && each.kind === 'schedule' && !needsAttention(each), order: bySoonest },
  { key: 'event', label: 'When something happens', has: (each: Automation) => each.hook.enabled && each.kind === 'event', order: byTitle },
  { key: 'paused', label: 'Paused', has: (each: Automation) => !each.hook.enabled, order: byTitle },
] as const

const standingOrder = <T extends Automation>(items: T[]) =>
  STANDINGS.map((standing) => items.filter(standing.has).toSorted(standing.order)).flat()

const arrangeByStanding = <T extends Automation>(items: T[]): ArrangedGroup<T>[] =>
  STANDINGS.flatMap(({ key, label, has, order }) => {
    const entries = items.filter(has).toSorted(order).map((value) => ({ value }))
    return entries.length > 0 ? [{ key, label, entries }] : []
  })

const arrangeByWorkspace = (items: ListedAutomation[]): ArrangedGroup<ListedAutomation>[] => {
  const workspaces = new Map<string, ListedAutomation[]>()
  for (const each of items) workspaces.set(each.workspaceId, [...(workspaces.get(each.workspaceId) ?? []), each])
  return [...workspaces]
    .map(([id, each]) => ({ key: `workspace:${id}`, label: each[0].workspaceTitle, entries: standingOrder(each).map((value) => ({ value })) }))
    .toSorted((a, b) => a.label.localeCompare(b.label))
}

/** A filter for each workspace with automations, once there is more than one, under its icon (`looks`). */
const workspaceFilters = (items: ListedAutomation[], looks: WorkspaceLooksById): ListFilter<ListedAutomation>[] => {
  const workspaces = new Map(items.map((each) => [each.workspaceId, each.workspaceTitle]))
  if (workspaces.size < 2) return []
  return [...workspaces]
    .toSorted(([, a], [, b]) => a.localeCompare(b))
    .map(([id, workspaceTitle]) => ({
      id: `workspace:${id}`,
      label: workspaceTitle,
      facet: 'workspace',
      icon: createElement(WorkspaceIcon, { label: workspaceLabel(workspaceTitle), ...looks[id], small: true }),
      test: ({ workspaceId }) => workspaceId === id,
    }))
}

/**
 * How the Automations page can be ordered, narrowed and searched: by how each stands (what needs
 * seeing to, then the scheduled, soonest first, then what an event sets off, then what is paused),
 * by workspace, or by name; narrowed to a kind, to on or paused, and to a workspace, each under its
 * icon (`looks`); and found by its name, what it does, when it runs, what it watches, what it runs
 * and where.
 */
export const automationList = (items: ListedAutomation[], looks: WorkspaceLooksById = {}): ListViewSpec<ListedAutomation, ListOrder<ListedAutomation>> => ({
  orders: [
    { id: 'standing', label: 'Status', arrange: (all) => arrangeByStanding(all) },
    { id: 'workspace', label: 'Workspace', arrange: (all) => arrangeByWorkspace(all) },
    { id: 'name', label: 'Name', arrange: (all, enough) => groupByName(all, title, enough) },
  ],
  filters: [
    { id: 'schedule', label: 'Scheduled', facet: 'kind', test: ({ kind }) => kind === 'schedule' },
    { id: 'event', label: 'When something happens', facet: 'kind', test: ({ kind }) => kind === 'event' },
    { id: 'on', label: 'On', facet: 'state', test: ({ hook }) => hook.enabled },
    { id: 'paused', label: 'Paused', facet: 'state', test: ({ hook }) => !hook.enabled },
    ...workspaceFilters(items, looks),
  ],
  facetMenus: { workspace: 'Workspace' },
  searchText: ({ hook, schedule, workspaceTitle, gadgetTitle }) =>
    [hook.description.title, hook.description.description, schedule && cadenceWords(schedule.cadence), hook.resourceTitle, gadgetTitle, workspaceTitle]
      .filter(Boolean).join(' '),
})
