import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { type ListFilter, type ListOrder, type ListViewSpec, groupByName, groupByTime } from '@gadgets/ui'

type Workspace = WorkspaceMetadataWithTimestamps

/** An order the Workspaces page can be put in. */
export type WorkspaceOrder = ListOrder<Workspace> & {
  /** The time a workspace is listed with in this order: the one it is ordered by, if it is by one. */
  at: (workspace: Workspace) => Date
}

/**
 * The workspaces the viewer is in, which are the ones listed as workspaces: not those they were
 * only shared an app of to use (`role === 'use'`), which the server lists too once they open it.
 * They were not let into those, and the app is in their Library.
 */
export const joinedWorkspaces = <Listed extends Pick<Workspace, 'role'>>(workspaces: readonly Listed[]): Listed[] =>
  workspaces.filter(({ role }) => role !== 'use')

/** What a workspace is called where it is listed. */
export const workspaceTitle = ({ title }: { title: string }) => title || 'Untitled workspace'

/** Latest first, in stretches of time as fine as there are enough workspaces for. */
const byTime = (id: string, label: string, at: (workspace: Workspace) => Date): WorkspaceOrder => ({
  id,
  label,
  at,
  arrange: (workspaces, enough) =>
    groupByTime(workspaces.toSorted((a, b) => at(b).getTime() - at(a).getTime()).map((workspace) => ({ value: workspace, at: at(workspace) })), new Date(), enough),
})

const ORDERS: WorkspaceOrder[] = [
  byTime('active', 'Last active', ({ lastActive }) => lastActive),
  byTime('created', 'Date created', ({ created }) => created),
  { id: 'name', label: 'Name', at: ({ lastActive }) => lastActive, arrange: (workspaces, enough) => groupByName(workspaces, workspaceTitle, enough) },
]

// Those with anything unread (by id), as far as the account has said.
const filtersFor = (unread: ReadonlySet<string>): ListFilter<Workspace>[] => [
  { id: 'starred', label: 'Pinned', test: ({ pinned }) => pinned === true },
  { id: 'unread', label: 'Unread', test: ({ id }) => unread.has(id) },
  // Whose it is: a workspace with an owner is somebody else's.
  { id: 'mine', label: 'Mine', facet: 'owner', test: ({ owner }) => owner === undefined },
  { id: 'shared', label: 'Shared with me', facet: 'owner', test: ({ owner }) => owner !== undefined },
]

/**
 * How the Workspaces page can be ordered, narrowed and searched: by title, by whether anything in
 * it is unread (`unread`, the ids of those that have), and by whose it is.
 */
export const workspaceList = (
  unread: ReadonlySet<string> = new Set(),
): ListViewSpec<Workspace, WorkspaceOrder> => ({
  orders: ORDERS,
  filters: filtersFor(unread),
  searchText: (workspace) => [workspaceTitle(workspace), workspace.owner?.name].filter(Boolean).join(' '),
})
