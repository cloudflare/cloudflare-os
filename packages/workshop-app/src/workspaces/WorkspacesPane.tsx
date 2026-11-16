import { useState } from 'react'
import { FolderIcon } from '@phosphor-icons/react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { ListToolbar } from '@/blocks/ListToolbar'
import { WorkspaceCard } from '@/blocks/WorkspaceCard'
import { WorkspaceRow } from '@/blocks/WorkspaceRow'
import { Button } from '@/components/Button'
import { CardGrid } from '@/components/CardGrid'
import { GroupedList } from '@/components/GroupedList'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { readStarOrder, writeStarOrder } from '@/prefs/starOrder'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useSetWorkspacePinned, useWorkspaces } from './WorkspacesContext'
import { formatActivity } from './formatActivity'
import { orderStarred } from './starredOrder'
import { workspaceLabel } from './workspaceLabel'
import { useWorkspaceMemberships } from './useWorkspaceMemberships'
import { workspaceList, workspaceTitle } from './workspaceList'

export type WorkspacesPaneProps = {
  onOpenWorkspace: (id: string) => void
  /** A workspace's address, for its row to link to so that it can be opened in another tab. */
  workspaceHref?: (id: string) => string
  /** Starts a chat in a new workspace. */
  onNewWorkspace: () => void
}

/**
 * All the user's workspaces: the starred ones first, in the order the user put them in (the latest
 * starred first until then), then the rest in the order chosen (most recently active first, until
 * another is), grouped as that order groups them. Over them, the list's controls: a search, rows
 * or cards, the order, filters, and the way to start a new one.
 */
export const WorkspacesPane = ({ onOpenWorkspace, workspaceHref, onNewWorkspace }: WorkspacesPaneProps) => {
  const workspaces = useWorkspaces()
  const setPinned = useSetWorkspacePinned()
  const connection = useConnectionNotice()
  const [starOrder, setStarOrder] = useState(readStarOrder)
  // Why the last star or unstar did not hold.
  const [starProblem, setStarProblem] = useState<string>()
  useDocumentTitle('Workspaces')

  const { user } = useApi()
  const all = workspaces.status === 'ready' ? workspaces.workspaces : []
  const memberships = useWorkspaceMemberships(all)
  const list = useListView('workspaces', workspaceList(all, memberships, user.id))
  // Every starred one's place is kept, whichever of them the search and the filters leave.
  const starredIds = orderStarred(all.filter(({ pinned }) => pinned), starOrder).map(({ id }) => id)
  const shown = list.narrow(all)
  const starred = orderStarred(shown.filter(({ pinned }) => pinned), starOrder)
  const timeOf = (workspace: WorkspaceMetadataWithTimestamps) => formatActivity(list.order.at(workspace))
  const groups = [
    ...(starred.length > 0 ? [{ key: 'starred', label: 'Starred', entries: starred.map((workspace) => ({ value: workspace, time: timeOf(workspace) })) }] : []),
    ...list.arrange(shown.filter(({ pinned }) => !pinned)).map(({ key, label, entries }) => ({
      key: `${list.order.id}:${key}`,
      label,
      entries: entries.map(({ value, time }) => ({ value, time: time ?? timeOf(value) })),
    })),
  ]

  const keepOrder = (order: string[]) => {
    setStarOrder(order)
    writeStarOrder(order)
  }
  const star = (id: string, on: boolean) => {
    setStarProblem(undefined)
    if (connection?.blocked()) return
    // The whole order is kept, so that one starred elsewhere since stays after this one.
    keepOrder(on ? [id, ...starredIds.filter((other) => other !== id)] : starredIds.filter((other) => other !== id))
    setPinned(id, on).catch((error: unknown) => {
      setStarProblem(`Couldn’t ${on ? 'star' : 'unstar'} the workspace: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Only with all of the starred there: putting some of them in order would lose the others' places.
  const reorderStarred = list.narrowed ? undefined : keepOrder
  // What a row and a card are both given.
  const propsOf = (workspace: WorkspaceMetadataWithTimestamps) => ({
    workspaceLabel: workspaceLabel(workspace.title),
    title: workspaceTitle(workspace),
    members: memberships.get(workspace.id)?.map(({ profile }) => ({ id: profile.id, name: profile.name, you: profile.id === user.id })),
    starred: workspace.pinned === true,
    onStarredChange: (on: boolean) => star(workspace.id, on),
    href: workspaceHref?.(workspace.id),
    onSelect: () => onOpenWorkspace(workspace.id),
  })

  // Under the list on a narrow screen, in reach of a thumb, and over it otherwise.
  const narrow = useNarrowScreen()
  const toolbar = (
    <ListToolbar
      noun="workspaces"
      {...list.controls}
      at={narrow ? 'bottom' : 'top'}
      action={<Button variant="primary" onClick={onNewWorkspace}>New</Button>}
    />
  )

  return (
    <PageLayout
      footer={narrow ? toolbar : undefined}
      header={(
        <HeaderBubble>
          <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <FolderIcon aria-hidden="true" />
            Workspaces
          </h1>
        </HeaderBubble>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-8">
        {!narrow && toolbar}
        {workspaces.status === 'loading' && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading workspaces…</p>}
        {workspaces.status === 'failed' && <p className="px-4 text-base text-kumo-subtle">Couldn’t load workspaces: {workspaces.message}</p>}
        {workspaces.status === 'ready' && all.length === 0 && (
          <p className="px-4 text-center text-base text-kumo-subtle">No workspaces yet. Each chat you start makes one.</p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
            No workspaces match.
            <Button variant="ghost" onClick={list.showAll}>Show all</Button>
          </p>
        )}
        {starProblem && <p role="alert" className="px-4 text-base text-kumo-subtle">{starProblem}</p>}
        {shown.length > 0 && (
          // Another order or view is another list, faded to rather than moved to row by row.
          <div key={`${list.mode}:${list.order.id}`} className="appears">
            {list.mode === 'list'
              ? (
                  <GroupedList
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      rows: entries.map(({ value, time }) => ({ key: value.id, content: <WorkspaceRow {...propsOf(value)} time={time} /> })),
                      onReorder: key === 'starred' ? reorderStarred : undefined,
                    }))}
                  />
                )
              : (
                  <CardGrid
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      cards: entries.map(({ value, time }) => ({ key: value.id, content: <WorkspaceCard {...propsOf(value)} time={time} /> })),
                      onReorder: key === 'starred' ? reorderStarred : undefined,
                    }))}
                  />
                )}
          </div>
        )}
      </div>
    </PageLayout>
  )
}
