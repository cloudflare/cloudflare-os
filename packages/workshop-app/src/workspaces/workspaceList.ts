import { createElement } from 'react'
import { UserIcon } from '@phosphor-icons/react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { groupByTime } from '@/chat/timeGroups'
import { Avatar } from '@/components/Avatar'
import type { ListFilter, ListOrder } from '@/components/listView'
import { groupByName } from '@/components/nameGroups'
import type { ListViewSpec } from '@/hooks/useListView'
import { membersOnly, type WorkspaceMember } from './workspaceMembers'

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
 * A filter for each way the workspaces are shared, as far as is known of who is in them
 * (`memberships`, by workspace id, of whom its members count): with nobody, and with each person
 * other than the viewer, by name. A workspace that has not said who its members are passes none of them.
 */
const memberFilters = (workspaces: Workspace[], memberships: ReadonlyMap<string, WorkspaceMember[]>, viewerId: string): ListFilter<Workspace>[] => {
  const membersOf = ({ id }: Workspace) => {
    const everyone = memberships.get(id)
    return everyone && membersOnly(everyone)
  }
  const people = new Map<string, string>()
  for (const workspace of workspaces) {
    for (const { profile } of membersOf(workspace) ?? []) {
      if (profile.id !== viewerId) people.set(profile.id, profile.name)
    }
  }
  if (people.size === 0) return []
  return [
    {
      id: 'member:none',
      label: 'No one else',
      facet: 'member',
      icon: createElement(UserIcon, { 'aria-hidden': true, className: 'size-4' }),
      test: (workspace) => membersOf(workspace)?.length === 1,
    },
    ...[...people]
      .toSorted(([, a], [, b]) => a.localeCompare(b))
      .map(([id, name]): ListFilter<Workspace> => ({
        id: `member:with:${id}`,
        label: name,
        facet: 'member',
        icon: createElement(Avatar, { name, small: true }),
        test: (workspace) => membersOf(workspace)?.some(({ profile }) => profile.id === id) === true,
      })),
  ]
}

/**
 * How the Workspaces page can be ordered, narrowed and searched: by title, by whether anything in
 * it is unread (`unread`, the ids of those that have), by whose it is, and by who has access to it,
 * as far as `memberships` knows (by workspace id).
 */
export const workspaceList = (
  workspaces: Workspace[],
  memberships: ReadonlyMap<string, WorkspaceMember[]>,
  viewerId: string,
  unread: ReadonlySet<string> = new Set(),
): ListViewSpec<Workspace, WorkspaceOrder> => ({
  orders: ORDERS,
  filters: [...filtersFor(unread), ...memberFilters(workspaces, memberships, viewerId)],
  facetMenus: { member: 'Members' },
  searchText: (workspace) =>
    [workspaceTitle(workspace), workspace.owner?.name, ...membersOnly(memberships.get(workspace.id) ?? []).map(({ profile }) => profile.name)].filter(Boolean).join(' '),
})
