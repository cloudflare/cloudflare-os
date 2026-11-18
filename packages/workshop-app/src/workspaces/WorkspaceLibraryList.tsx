import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { workspaceAsideItems, type AsideItem } from '@/aside/asideItems'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { FileListItem } from '@/blocks/FileListItem'
import { ListGroup } from '@/blocks/ListGroup'
import { groupByTime } from '@/chat/timeGroups'
import { Button } from '@/components/Button'
import { withEdits } from '@/library/libraryEdits'
import { useLibrary } from '@/library/useLibrary'
import { useLibraryActions } from '@/library/useLibraryActions'
import { gadgetKey } from '@/gadgets/WaitingAsks'
import { useWaitingAsks } from '@/gadgets/WaitingAsksProvider'

export type WorkspaceLibraryListProps = {
  workspaceId: string
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
  /** An output's own page, which sharing it from its more menu lets people in to. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to an output's settings, from its more menu. */
  onOpenSettings?: (output: OutputSummary) => void
}

/**
 * What a workspace has made, from the library, latest first, grouped by when, each with a more
 * menu for whoever builds in the workspace, as the Library page has (`useLibraryActions`).
 */
export const WorkspaceLibraryList = ({ workspaceId, onOpenItem, itemHref, outputHref, onOpenSettings }: WorkspaceLibraryListProps) => {
  const library = useLibrary(workspaceId)
  const read = library.status === 'ready' ? library.outputs : []
  const { edits, actionsOf, problem, dialogs } = useLibraryActions({ read, outputHref, onOpenSettings })
  const outputs = withEdits(read, edits)
  const items = library.status === 'ready' ? workspaceAsideItems(workspaceId, undefined, outputs, []) : []
  const moreOf = (item: AsideItem) => {
    const output = item.kind === 'output' ? outputs.find(({ workpieceId }) => workpieceId === item.output.workpieceId) : undefined
    return output && actionsOf(output)
  }
  // What each gadget asks of the user, which its own pane asks when it is opened.
  const asks = useWaitingAsks()
  const waitingOf = (item: AsideItem) => (item.kind === 'output' ? asks.byGadget.get(gadgetKey(workspaceId, item.output.workpieceId)) ?? 0 : 0)
  const groups = groupByTime(items.map((item) => ({ value: item, at: item.at })))

  return (
    <>
      {problem && <p role="alert" className="px-4 text-center text-base text-kumo-subtle">{problem}</p>}
      {library.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the library…</p>}
      {library.status === 'failed' && (
        <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
          Couldn’t load the library: {library.message}
          <Button variant="ghost" onClick={library.retry}>Try again</Button>
        </p>
      )}
      {library.status === 'ready' && items.length === 0 && (
        <p className="px-4 text-center text-base text-kumo-subtle">Nothing here yet. What this workspace makes shows here.</p>
      )}
      {groups.map(({ key, label, entries }) => (
        <ListGroup key={key} label={label}>
          {entries.map(({ value: item, time }) => (
            <FileListItem
              key={item.key}
              title={item.title}
              icon={asideItemIcon(item)}
              time={time}
              href={itemHref?.(item)}
              onSelect={() => onOpenItem(item)}
              more={moreOf(item)}
              waiting={waitingOf(item)}
            />
          ))}
        </ListGroup>
      ))}
      {dialogs}
    </>
  )
}
