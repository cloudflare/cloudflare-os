import type { ArrangedGroup, ListOrder } from '@/components/listView'
import type { ListViewSpec } from '@/hooks/useListView'
import type { WorkspaceMember } from './workspaceMembers'

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** Everyone in one group: a workspace has too few members to be told apart by letters or time. */
const together = (members: WorkspaceMember[]): ArrangedGroup<WorkspaceMember>[] =>
  members.length === 0 ? [] : [{ key: 'members', label: 'Members', entries: members.map((value) => ({ value })) }]

const ORDERS: ListOrder<WorkspaceMember>[] = [
  // As they are given: the owner, then the others in the server's order.
  { id: 'owner', label: 'Owner first', arrange: together },
  { id: 'name', label: 'Name', arrange: (members) => together(members.toSorted((a, b) => collator.compare(a.profile.name, b.profile.name))) },
]

/** How a workspace's members can be ordered and searched, by name. */
export const memberList: ListViewSpec<WorkspaceMember, ListOrder<WorkspaceMember>> = {
  orders: ORDERS,
  searchText: ({ profile }) => profile.name,
}
