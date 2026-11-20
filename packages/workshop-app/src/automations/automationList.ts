import { createElement } from 'react'
import { type ArrangedGroup, type ListFilter, type ListOrder, type ListViewSpec, groupByName } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLooksById } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import type { Automation } from './automations'

/** An automation as the Automations page lists it, with the names of where it is and what it runs. */
export type ListedAutomation = Automation & {
  workspaceTitle: string
  /** The gadget it runs, by its title, where the library has it. */
  gadgetTitle?: string
}

const title = ({ hook }: Automation) => hook.description.title
const byTitle = (a: Automation, b: Automation) => title(a).localeCompare(title(b))

/** The groups of the first order, each its own however few it has: what is on, then what is paused. */
const STANDINGS = [
  { key: 'on', label: 'On', has: (each: Automation) => each.hook.enabled },
  { key: 'paused', label: 'Paused', has: (each: Automation) => !each.hook.enabled },
] as const

const standingOrder = <T extends Automation>(items: T[]) =>
  STANDINGS.map((standing) => items.filter(standing.has).toSorted(byTitle)).flat()

const arrangeByStanding = <T extends Automation>(items: T[]): ArrangedGroup<T>[] =>
  STANDINGS.flatMap(({ key, label, has }) => {
    const entries = items.filter(has).toSorted(byTitle).map((value) => ({ value }))
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
 * How the Automations page can be ordered, narrowed and searched: by whether each is on or
 * paused, by workspace, or by name; narrowed to on or paused, and to a workspace, each under its
 * icon (`looks`); and found by its name, what it does, what it watches, what it runs and where.
 */
export const automationList = (items: ListedAutomation[], looks: WorkspaceLooksById = {}): ListViewSpec<ListedAutomation, ListOrder<ListedAutomation>> => ({
  orders: [
    { id: 'standing', label: 'Status', arrange: (all) => arrangeByStanding(all) },
    { id: 'workspace', label: 'Workspace', arrange: (all) => arrangeByWorkspace(all) },
    { id: 'name', label: 'Name', arrange: (all, enough) => groupByName(all, title, enough) },
  ],
  filters: [
    { id: 'on', label: 'On', facet: 'state', test: ({ hook }) => hook.enabled },
    { id: 'paused', label: 'Paused', facet: 'state', test: ({ hook }) => !hook.enabled },
    ...workspaceFilters(items, looks),
  ],
  facetMenus: { workspace: 'Workspace' },
  searchText: ({ hook, workspaceTitle, gadgetTitle }) =>
    [hook.description.title, hook.description.description, hook.resourceTitle, gadgetTitle, workspaceTitle]
      .filter(Boolean).join(' '),
})
