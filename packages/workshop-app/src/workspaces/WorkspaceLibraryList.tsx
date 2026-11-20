import { PlusIcon, TrayIcon } from '@phosphor-icons/react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { workspaceAsideItems, type AsideItem } from '@/aside/asideItems'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { FileListItem } from '@/blocks/FileListItem'
import { Button, EmptyState, ListGroup, ListToolbar, NoMatches, useListView } from '@gadgets/ui'
import { withEdits } from '@/library/libraryEdits'
import { useLibrary } from '@/library/OutputsFeedContext'
import { useLibraryActions } from '@/library/useLibraryActions'
import { gadgetAsks } from './WorkspaceSummaries'
import { useWorkspaceSummaries } from './WorkspaceSummariesContext'
import { libraryItemList } from './libraryItemList'

export type WorkspaceLibraryListProps = {
  workspaceId: string
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens beside the workspace, for what has no page of its own. */
  itemHref?: (item: AsideItem) => string
  /** An output's own page, which its row links to so that it opens on its own in another tab, and which sharing it from its more menu lets people in to. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to an output's settings, from its more menu. */
  onOpenSettings?: (output: OutputSummary) => void
  /** Starts a chat in the workspace, to make something, offered while it has made nothing. */
  onMake?: () => void
}

/**
 * What a workspace has made, from the library, latest first until another order is chosen, grouped
 * as that order groups it, each with a more menu for whoever builds in the workspace, as the
 * Library page has (`useLibraryActions`). Over it, a search, the order and filters.
 */
export const WorkspaceLibraryList = ({ workspaceId, onOpenItem, itemHref, outputHref, onOpenSettings, onMake }: WorkspaceLibraryListProps) => {
  const library = useLibrary()
  const read = library.status === 'ready' ? library.outputs : []
  const { edits, actionsOf, problem, dialogs } = useLibraryActions({ read, outputHref, onOpenSettings })
  const outputs = withEdits(read, edits)
  const items = library.status === 'ready' ? workspaceAsideItems(workspaceId, undefined, outputs, []) : []
  const outputOf = (item: AsideItem) => (item.kind === 'output' ? outputs.find(({ workpieceId }) => workpieceId === item.output.workpieceId) : undefined)
  const moreOf = (item: AsideItem) => {
    const output = outputOf(item)
    return output && actionsOf(output)
  }
  // Opened in another tab, an output is on its own page, as the Library opens it, not beside the workspace.
  const hrefOf = (item: AsideItem) => {
    const output = outputOf(item)
    return output && outputHref ? outputHref(output) : itemHref?.(item)
  }
  // What each gadget asks of the user, which its own pane asks when it is opened.
  const summaries = useWorkspaceSummaries()
  const waitingOf = (item: AsideItem) => (item.kind === 'output' ? gadgetAsks(summaries, workspaceId, item.output.workpieceId) : 0)
  const list = useListView('workspace-library', libraryItemList(items, (item) => waitingOf(item) > 0))
  const shown = list.narrow(items)
  const groups = list.arrange(shown)

  return (
    <div className="flex flex-col gap-4">
      {items.length > 0 && <ListToolbar noun="the library" search={list.controls.search} order={list.controls.order} filter={list.controls.filter} />}
      {problem && <p role="alert" className="px-4 text-center text-base text-kumo-subtle">{problem}</p>}
      {library.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the library…</p>}
      {library.status === 'failed' && (
        <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
          Couldn’t load the library: {library.message}
          <Button variant="ghost" onClick={library.retry}>Try again</Button>
        </p>
      )}
      {library.status === 'ready' && items.length === 0 && (
        <EmptyState
          size="section"
          tinted
          icon={TrayIcon}
          title="Nothing made here yet"
          description="The apps, documents and files this workspace’s chats make show here, to open beside the page."
          actions={onMake && [{ label: 'Make something', icon: PlusIcon, variant: 'primary', onClick: onMake }]}
        />
      )}
      {items.length > 0 && shown.length === 0 && <NoMatches onShowAll={list.showAll} />}
      {/* Another order is another list, cut to rather than moved to row by row. */}
      <div key={list.order.id} className="flex flex-col gap-3">
        {groups.map(({ key, label, entries }) => (
          <ListGroup key={key} label={label}>
            {entries.map(({ value: item, time }) => (
              <FileListItem
                key={item.key}
                title={item.title}
                icon={asideItemIcon(item)}
                time={time}
                href={hrefOf(item)}
                onSelect={() => onOpenItem(item)}
                more={moreOf(item)}
                waiting={waitingOf(item)}
              />
            ))}
          </ListGroup>
        ))}
      </div>
      {dialogs}
    </div>
  )
}
