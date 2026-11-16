import { createElement, type ReactNode } from 'react'
import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { AttachmentKindIcon } from '@/blocks/AttachmentKindIcon'
import { groupByTime } from '@/chat/timeGroups'
import { FormatIcon } from '@/components/FormatIcon'
import { GoogleFileIcon } from '@/components/GoogleFileIcon'
import type { ListFilter, ListOrder } from '@/components/listView'
import { groupByName } from '@/components/nameGroups'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { ListViewSpec } from '@/hooks/useListView'
import type { WorkspaceLooksById } from '@/workspaces/WorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'
import type { LibraryEntry } from './libraryEntries'

/** An order the Library page can be put in. */
export type LibraryOrder = ListOrder<LibraryEntry>

/** What an entry is, as the Library groups and narrows by: an app, a format, a kind of file. */
type EntryType = { id: string; noun: string; plural: string; icon: ReactNode }

const formatType = ({ id, noun, plural, icon }: BlueprintOutput): EntryType => ({
  id,
  noun,
  plural,
  icon: createElement(FormatIcon, { name: icon, className: 'size-4' }),
})

/** What a gadget made as no format is: an app. */
const APP = formatType({ id: 'app', noun: 'App', plural: 'Apps', icon: 'appWindow' })

const GOOGLE: Record<'document' | 'spreadsheet' | 'presentation', EntryType> = {
  document: { id: 'google:document', noun: 'Google Doc', plural: 'Google Docs', icon: createElement(GoogleFileIcon, { kind: 'document', className: 'size-4' }) },
  spreadsheet: { id: 'google:spreadsheet', noun: 'Google Sheet', plural: 'Google Sheets', icon: createElement(GoogleFileIcon, { kind: 'spreadsheet', className: 'size-4' }) },
  presentation: { id: 'google:presentation', noun: 'Google Slides', plural: 'Google Slides', icon: createElement(GoogleFileIcon, { kind: 'presentation', className: 'size-4' }) },
}

/** What a file sent in a chat is. */
const FILE: EntryType = { id: 'file', noun: 'File', plural: 'Files', icon: createElement(AttachmentKindIcon, { kind: 'file', className: 'size-4' }) }

/** What an entry is: the format a gadget was made as, or an app; a Google file's kind; or a file. */
const entryType = ({ item, output }: LibraryEntry): EntryType => {
  if (item.kind === 'output') return output ? formatType(output) : APP
  if (item.kind === 'connected' && item.connected.fileKind) return GOOGLE[item.connected.fileKind]
  return FILE
}

/** The workspace an entry is in, as a workspace is called where it is listed. */
const entryWorkspaceTitle = (entry: LibraryEntry) => workspaceTitle({ title: entry.workspaceTitle ?? '' })

/**
 * What there is to say of an entry under its title, on one line: what it is, the workspace it is
 * in unless that is left out (`workspace`), and whose that is when it is somebody else's.
 */
export const entryDetail = (entry: LibraryEntry, { workspace = true }: { workspace?: boolean } = {}) =>
  [entryType(entry).noun, workspace && entryWorkspaceTitle(entry), entry.sharedBy && `Shared by ${entry.sharedBy}`].filter(Boolean).join(' · ')

/**
 * The types the entries have, each once: apps, then the formats the deployment offers (`formats`),
 * in its order, whether or not anything has been made as one, then whatever else the entries are,
 * such as a format that is no longer offered, a Google file or a file. With no gadgets among them,
 * as on the Files tab, neither apps nor formats.
 */
const libraryTypes = (entries: LibraryEntry[], formats: BlueprintOutput[]): EntryType[] => {
  const types = new Map<string, EntryType>()
  const gadgets = entries.some(({ section }) => section === 'gadget')
  for (const type of [...(gadgets ? [APP, ...formats.map(formatType)] : []), ...entries.map(entryType)]) {
    if (!types.has(type.id)) types.set(type.id, type)
  }
  return [...types.values()]
}

const latestFirst = (entries: LibraryEntry[]) => entries.toSorted((a, b) => b.at.getTime() - a.at.getTime())

/** Latest first, in stretches of time as fine as there are enough entries for. */
const byTime: LibraryOrder = {
  id: 'active',
  label: 'Last active',
  arrange: (entries, enough) => groupByTime(latestFirst(entries).map((entry) => ({ value: entry, at: entry.at })), new Date(), enough),
}

/**
 * Under what they are, in the order of `types`, the latest first within each. A type is a group of
 * its own however few it has: folded into its neighbour it would say nothing of either.
 */
const byType = (types: EntryType[]): LibraryOrder => ({
  id: 'type',
  label: 'Type',
  arrange: (entries) =>
    types
      .map(({ id, plural }) => ({
        key: id,
        label: plural,
        entries: latestFirst(entries.filter((entry) => entryType(entry).id === id)).map((value) => ({ value })),
      }))
      .filter(({ entries: within }) => within.length > 0),
})

/** A filter for each type, once there is more than one to choose between. */
const typeFilters = (types: EntryType[]): ListFilter<LibraryEntry>[] =>
  types.length < 2
    ? []
    : types.map(({ id, plural, icon }) => ({ id: `type:${id}`, label: plural, facet: 'type', icon, test: (entry) => entryType(entry).id === id }))

const OWNER_FILTERS: ListFilter<LibraryEntry>[] = [
  // Whose it is: one somebody shared is in their workspace.
  { id: 'mine', label: 'Mine', facet: 'owner', test: ({ sharedBy }) => sharedBy === undefined },
  { id: 'shared', label: 'Shared with me', facet: 'owner', test: ({ sharedBy }) => sharedBy !== undefined },
]

/** A filter for each workspace the entries are in, by title, once they are in more than one, with its icon as it is drawn (`looks`). */
const workspaceFilters = (entries: LibraryEntry[], looks: WorkspaceLooksById): ListFilter<LibraryEntry>[] => {
  const workspaces = new Map(entries.map((entry) => [entry.workspaceId, entry]))
  if (workspaces.size < 2) return []
  return [...workspaces]
    .map(([id, entry]) => ({ id, title: entryWorkspaceTitle(entry), label: workspaceLabel(entry.workspaceTitle ?? '') }))
    .toSorted((a, b) => a.title.localeCompare(b.title))
    .map(({ id, title, label }): ListFilter<LibraryEntry> => ({
      id: `workspace:${id}`,
      label: title,
      facet: 'workspace',
      icon: createElement(WorkspaceIcon, { label, ...looks[id], small: true }),
      test: ({ workspaceId }) => workspaceId === id,
    }))
}

/**
 * How a tab of the Library page can be ordered, narrowed and searched: by when, by title, by what
 * an entry is (see `libraryTypes`, which `formats` are for), by whether it is starred, by whose it
 * is, and by the workspace it is in, each under its own icon (`looks`).
 */
export const libraryList = (entries: LibraryEntry[], formats: BlueprintOutput[], looks: WorkspaceLooksById = {}): ListViewSpec<LibraryEntry, LibraryOrder> => {
  const types = libraryTypes(entries, formats)
  return {
    orders: [byTime, { id: 'name', label: 'Name', arrange: (all, enough) => groupByName(all, ({ title }) => title, enough) }, byType(types)],
    filters: [
      { id: 'starred', label: 'Starred', test: ({ starred }) => starred },
      ...OWNER_FILTERS,
      ...typeFilters(types),
      ...workspaceFilters(entries, looks),
    ],
    // Both are as many as the deployment and the user have made them, so each has a menu of its own.
    facetMenus: { type: 'Type', workspace: 'Workspace' },
    searchText: (entry) => {
      const { noun, plural } = entryType(entry)
      return [entry.title, noun, plural, entryWorkspaceTitle(entry), entry.sharedBy].filter(Boolean).join(' ')
    },
  }
}
