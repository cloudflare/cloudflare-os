import { useState } from 'react'
import { FolderIcon } from '@phosphor-icons/react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { WorkspaceRow } from '@/blocks/WorkspaceRow'
import { groupByTime } from '@/chat/timeGroups'
import { Button } from '@/components/Button'
import { GroupedList, type GroupedListGroup } from '@/components/GroupedList'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { readStarOrder, writeStarOrder } from '@/prefs/starOrder'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useSetWorkspacePinned, useWorkspaces } from './WorkspacesContext'
import { formatActivity } from './formatActivity'
import { orderStarred } from './starredOrder'
import { workspaceLabel } from './workspaceLabel'

export type WorkspacesPaneProps = {
  onOpenWorkspace: (id: string) => void
  /** A workspace's address, for its row to link to so that it can be opened in another tab. */
  workspaceHref?: (id: string) => string
  /** Starts a chat in a new workspace. */
  onNewWorkspace: () => void
}

/**
 * All the user's workspaces: the starred ones first, in the order the user put them in (the latest
 * starred first until then), then the rest, most recently active first, grouped by when.
 */
export const WorkspacesPane = ({ onOpenWorkspace, workspaceHref, onNewWorkspace }: WorkspacesPaneProps) => {
  const workspaces = useWorkspaces()
  const setPinned = useSetWorkspacePinned()
  const connection = useConnectionNotice()
  const [starOrder, setStarOrder] = useState(readStarOrder)
  // Why the last star or unstar did not hold.
  const [starProblem, setStarProblem] = useState<string>()
  useDocumentTitle('Workspaces')

  const all = workspaces.status === 'ready' ? workspaces.workspaces : []
  const starred = orderStarred(all.filter(({ pinned }) => pinned), starOrder)
  const starredIds = starred.map(({ id }) => id)
  const groups = groupByTime(all.filter(({ pinned }) => !pinned).map((workspace) => ({ value: workspace, at: workspace.lastActive })))

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

  const rowProps = (workspace: WorkspaceMetadataWithTimestamps) => ({
    workspaceLabel: workspaceLabel(workspace.title),
    title: workspace.title || 'Untitled workspace',
    starred: workspace.pinned === true,
    onStarredChange: (on: boolean) => star(workspace.id, on),
    href: workspaceHref?.(workspace.id),
    onSelect: () => onOpenWorkspace(workspace.id),
  })
  const rowOf = (workspace: WorkspaceMetadataWithTimestamps, time?: string) => ({
    key: workspace.id,
    content: <WorkspaceRow {...rowProps(workspace)} time={time} />,
  })
  const listGroups: GroupedListGroup[] = [
    ...(starred.length > 0
      ? [{ key: 'starred', label: 'Starred', rows: starred.map((workspace) => rowOf(workspace, formatActivity(workspace.lastActive))), onReorder: keepOrder }]
      : []),
    ...groups.map(({ key, label, entries }) => ({ key: `time:${key}`, label, rows: entries.map(({ value, time }) => rowOf(value, time)) })),
  ]

  return (
    <PageLayout
      header={(
        <>
          <HeaderBubble>
            <h1 className="flex h-9 items-center gap-2 rounded-full bg-kumo-base pr-4 pl-3 text-base font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
              <FolderIcon aria-hidden="true" />
              Workspaces
            </h1>
          </HeaderBubble>
          <HeaderBubble className="ms-auto">
            <Button variant="primary" onClick={onNewWorkspace}>Add new</Button>
          </HeaderBubble>
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-5 pb-8">
        {workspaces.status === 'loading' && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading workspaces…</p>}
        {workspaces.status === 'failed' && <p className="px-4 text-base text-kumo-subtle">Couldn’t load workspaces: {workspaces.message}</p>}
        {workspaces.status === 'ready' && all.length === 0 && (
          <p className="px-4 text-center text-base text-kumo-subtle">No workspaces yet. Each chat you start makes one.</p>
        )}
        {starProblem && <p role="alert" className="px-4 text-base text-kumo-subtle">{starProblem}</p>}
        {all.length > 0 && <GroupedList groups={listGroups} />}
      </div>
    </PageLayout>
  )
}
