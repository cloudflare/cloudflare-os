import { createElement } from 'react'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { groupByTime } from '@/chat/timeGroups'
import { FormatIcon } from '@/components/FormatIcon'
import type { ListFilter, ListOrder } from '@/components/listView'
import { groupByName } from '@/components/nameGroups'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { ListViewSpec } from '@/hooks/useListView'
import type { WorkspaceLooksById } from '@/workspaces/WorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'

/** An order the Library page can be put in. */
export type LibraryOrder = ListOrder<OutputSummary> & {
  /** The time an output is listed with in this order: the one it is ordered by, if it is by one. */
  at: (output: OutputSummary) => Date
}

/** What an output made as no format is: an app. */
export const APP: BlueprintOutput = { id: 'app', noun: 'App', plural: 'Apps', icon: 'appWindow' }

/** What an output is called where it is listed. */
export const outputTitle = ({ title }: { title: string }) => title || 'Untitled'

/** Tells an output from every other, across workspaces. */
export const outputKey = ({ workspaceId, workpieceId }: OutputSummary) => `${workspaceId}/${workpieceId}`

/** What an output is: the format it was made as, or an app. */
const outputType = ({ output }: OutputSummary): BlueprintOutput => output ?? APP

/**
 * What the user could publish as a template: the apps of their own, which a blueprint is made
 * from, and not those shared with them or made as a format. By title.
 */
export const ownApps = (outputs: OutputSummary[]) =>
  outputs.filter(({ output, owner }) => !output && !owner).toSorted((a, b) => outputTitle(a).localeCompare(outputTitle(b)))

/** The workspace an output is in, as a workspace is called where it is listed. */
const outputWorkspaceTitle = ({ workspaceTitle: title }: OutputSummary) => workspaceTitle({ title })

/** The workspace an output is in, as it is drawn (`looks`) and called where workspaces are listed. */
export const outputWorkspace = (output: OutputSummary, looks: WorkspaceLooksById = {}) => ({
  title: outputWorkspaceTitle(output),
  label: workspaceLabel(output.workspaceTitle),
  ...looks[output.workspaceId],
})

/**
 * What there is to say of an output under its title, on one line: what it is, the workspace it is
 * in unless that is left out (`workspace`), and whose that is when it is somebody else's.
 */
export const outputDetail = (output: OutputSummary, { workspace = true }: { workspace?: boolean } = {}) =>
  [outputType(output).noun, workspace && outputWorkspaceTitle(output), output.owner && `Shared by ${output.owner.name}`].filter(Boolean).join(' · ')

/**
 * The types the library has, each once: apps, then the formats the deployment offers (`formats`),
 * in its order, whether or not anything has been made as one, then whatever else `outputs` were
 * made as, such as a format that is no longer offered.
 */
const libraryTypes = (outputs: OutputSummary[], formats: BlueprintOutput[]): BlueprintOutput[] => {
  const types = new Map<string, BlueprintOutput>()
  for (const type of [APP, ...formats, ...outputs.map(outputType)]) {
    if (!types.has(type.id)) types.set(type.id, type)
  }
  return [...types.values()]
}

const latestFirst = (outputs: OutputSummary[], at: (output: OutputSummary) => Date) => outputs.toSorted((a, b) => at(b).getTime() - at(a).getTime())

/** Latest first, in stretches of time as fine as there are enough outputs for. */
const byTime = (id: string, label: string, at: (output: OutputSummary) => Date): LibraryOrder => ({
  id,
  label,
  at,
  arrange: (outputs, enough) => groupByTime(latestFirst(outputs, at).map((output) => ({ value: output, at: at(output) })), new Date(), enough),
})

/**
 * Under what they are, in the order of `types`, the latest active first within each. A type is a
 * group of its own however few it has: folded into its neighbour it would say nothing of either.
 */
const byType = (types: BlueprintOutput[]): LibraryOrder => ({
  id: 'type',
  label: 'Type',
  at: ({ lastActive }) => lastActive,
  arrange: (outputs) =>
    types
      .map(({ id, plural }) => ({
        key: id,
        label: plural,
        entries: latestFirst(outputs.filter((output) => outputType(output).id === id), ({ lastActive }) => lastActive).map((value) => ({ value })),
      }))
      .filter(({ entries }) => entries.length > 0),
})

/** A filter for each type, once there is more than one to choose between. */
const typeFilters = (types: BlueprintOutput[]): ListFilter<OutputSummary>[] =>
  types.length < 2
    ? []
    : types.map(({ id, plural, icon }) => ({
        id: `type:${id}`,
        label: plural,
        facet: 'type',
        icon: createElement(FormatIcon, { name: icon, className: 'size-4' }),
        test: (output) => outputType(output).id === id,
      }))

const OWNER_FILTERS: ListFilter<OutputSummary>[] = [
  // Whose it is: an output with an owner is in somebody else's workspace.
  { id: 'mine', label: 'Mine', facet: 'owner', test: ({ owner }) => owner === undefined },
  { id: 'shared', label: 'Shared with me', facet: 'owner', test: ({ owner }) => owner !== undefined },
]

/** A filter for each workspace the outputs are in, by title, once they are in more than one, with its icon as it is drawn (`looks`). */
const workspaceFilters = (outputs: OutputSummary[], looks: WorkspaceLooksById): ListFilter<OutputSummary>[] => {
  const workspaces = new Map(outputs.map((output) => [output.workspaceId, output]))
  if (workspaces.size < 2) return []
  return [...workspaces]
    .map(([id, output]) => ({ id, title: outputWorkspaceTitle(output), label: workspaceLabel(output.workspaceTitle) }))
    .toSorted((a, b) => a.title.localeCompare(b.title))
    .map(({ id, title, label }): ListFilter<OutputSummary> => ({
      id: `workspace:${id}`,
      label: title,
      facet: 'workspace',
      icon: createElement(WorkspaceIcon, { label, ...looks[id], small: true }),
      test: ({ workspaceId }) => workspaceId === id,
    }))
}

/**
 * How the Library page can be ordered, narrowed and searched: by when, by title, by what an output
 * is (see `libraryTypes`, which `formats` are for), by whether it is starred (`starred`, the keys
 * of those that are), by whose it is, and by the workspace it is in, each under its own icon
 * (`looks`).
 */
export const libraryList = (
  outputs: OutputSummary[],
  formats: BlueprintOutput[],
  starred: ReadonlySet<string>,
  looks: WorkspaceLooksById = {},
): ListViewSpec<OutputSummary, LibraryOrder> => {
  const types = libraryTypes(outputs, formats)
  return {
    orders: [
      byTime('active', 'Last active', ({ lastActive }) => lastActive),
      byTime('created', 'Date created', ({ created }) => created),
      { id: 'name', label: 'Name', at: ({ lastActive }) => lastActive, arrange: (all, enough) => groupByName(all, outputTitle, enough) },
      byType(types),
    ],
    filters: [
      { id: 'starred', label: 'Starred', test: (output) => starred.has(outputKey(output)) },
      ...OWNER_FILTERS,
      ...typeFilters(types),
      ...workspaceFilters(outputs, looks),
    ],
    // Both are as many as the deployment and the user have made them, so each has a menu of its own.
    facetMenus: { type: 'Type', workspace: 'Workspace' },
    searchText: (output) => {
      const { noun, plural } = outputType(output)
      return [outputTitle(output), noun, plural, outputWorkspaceTitle(output), output.owner?.name].filter(Boolean).join(' ')
    },
  }
}
