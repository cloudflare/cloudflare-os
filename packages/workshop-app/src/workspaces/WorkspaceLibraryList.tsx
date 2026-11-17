import { workspaceAsideItems, type AsideItem } from '@/aside/asideItems'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { FileListItem } from '@/blocks/FileListItem'
import { ListGroup } from '@/blocks/ListGroup'
import { groupByTime } from '@/chat/timeGroups'
import { Button } from '@/components/Button'
import { useLibrary } from '@/library/useLibrary'

export type WorkspaceLibraryListProps = {
  workspaceId: string
  onOpenItem: (item: AsideItem) => void
  /** Where an item opens, for its row to link to so that it can be opened in another tab. */
  itemHref?: (item: AsideItem) => string
}

/** What a workspace has made, from the library, latest first, grouped by when. */
export const WorkspaceLibraryList = ({ workspaceId, onOpenItem, itemHref }: WorkspaceLibraryListProps) => {
  const library = useLibrary(workspaceId)
  const items = library.status === 'ready' ? workspaceAsideItems(workspaceId, undefined, library.outputs, []) : []
  const groups = groupByTime(items.map((item) => ({ value: item, at: item.at })))

  return (
    <>
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
            />
          ))}
        </ListGroup>
      ))}
    </>
  )
}
