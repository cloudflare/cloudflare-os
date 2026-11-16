import { useState } from 'react'
import { ArrowSquareOutIcon, ArrowUpRightIcon, ExportIcon, LinkIcon, MinusCircleIcon, StarIcon, TrashIcon } from '@phosphor-icons/react'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { LibraryCard } from '@/blocks/LibraryCard'
import { LibraryRow, type LibraryAction, type LibraryItemProps } from '@/blocks/LibraryRow'
import { CardGrid } from '@/components/CardGrid'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { GroupedList } from '@/components/GroupedList'
import type { ListViewMode } from '@/components/listView'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ShareGadgetDialog } from '@/sharing/ShareGadgetDialog'
import type { LibraryEntry, LibraryGroup } from './libraryEntries'
import { entryDetail } from './libraryList'
import type { LibraryEntriesState } from './useLibraryEntries'
import { useLibraryPicture } from './useLibraryPicture'

export type LibraryEntryListProps = {
  groups: LibraryGroup[]
  /** As rows, or as cards. */
  view?: ListViewMode
  /**
   * Whether each says which workspace it is in, as where they are from many do. A card has no room
   * to, whatever this says.
   */
  withWorkspace?: boolean
  /** Rows show their groups' labels over them, as where nothing else sets the groups apart. */
  headed?: boolean
  /** Puts the starred group in another order, giving the keys in the new one. */
  onReorderStarred?: (keys: string[]) => void
  /** What can be done with the entries: star, take out, delete. */
  library: Pick<LibraryEntriesState, 'setStarred' | 'remove' | 'deleteGadget'>
  onOpen: (entry: LibraryEntry) => void
  /** Where an entry opens, for it to link to so that it can be opened in another tab. */
  href?: (entry: LibraryEntry) => string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

// Each its own component, so that each fetches its own picture.
const Row = ({ entry, ...props }: Omit<LibraryItemProps, 'thumbnail'> & { entry: LibraryEntry }) => <LibraryRow {...props} thumbnail={useLibraryPicture(entry).photo} />
const Card = ({ entry, ...props }: Omit<LibraryItemProps, 'thumbnail'> & { entry: LibraryEntry }) => {
  const { ref, photo, preview } = useLibraryPicture(entry)
  return <LibraryCard ref={ref} {...props} thumbnail={photo} preview={photo ? undefined : preview} />
}

/**
 * Library entries as rows or cards in groups, each starred from its row and with a menu
 * of what can be done with it: open it, here or in another tab, star it, take it out of the
 * Library, and for someone who builds where it was made, delete a gadget, once asked. A star or a
 * removal shows at once, and is undone, with why, if it does not hold.
 */
export const LibraryEntryList = ({ groups, view = 'list', withWorkspace = true, headed = true, onReorderStarred, library, onOpen, href }: LibraryEntryListProps) => {
  const connection = useConnectionNotice()
  // Why the last star or removal did not hold.
  const [problem, setProblem] = useState<string>()
  const [deleting, setDeleting] = useState<LibraryEntry>()
  // The one being asked about, kept while the dialog closes so its words do not change as it goes.
  const [asked, setAsked] = useState<LibraryEntry>()
  // The gadget being shared, kept while its dialog closes.
  const [sharing, setSharing] = useState<{ entry: LibraryEntry; page: string; open: boolean }>()

  const act = (doing: string, run: () => Promise<void>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    run().catch((error: unknown) => setProblem(`Couldn’t ${doing}: ${messageOf(error)}`))
  }

  const actionsOf = (entry: LibraryEntry, address: string | undefined): LibraryAction[] => [
    { key: 'open', label: 'Open', icon: ArrowUpRightIcon, onSelect: () => onOpen(entry) },
    ...(address
      ? [
          { key: 'tab', label: 'Open in new tab', icon: ArrowSquareOutIcon, onSelect: () => window.open(address, '_blank', 'noopener') },
          { key: 'link', label: 'Copy link', icon: LinkIcon, onSelect: () => copyLink(address) },
          // As from its settings: by whoever builds where it is, apart from its workspace.
          ...(entry.builds && entry.item.kind === 'output'
            ? [{ key: 'share', label: 'Share…', icon: ExportIcon, onSelect: () => setSharing({ entry, page: new URL(address, window.location.origin).href, open: true }) }]
            : []),
        ]
      : []),
    ...(entry.favorite
      ? [{
          key: 'star',
          label: entry.starred ? 'Unstar' : 'Star',
          icon: StarIcon,
          onSelect: () => act(entry.starred ? 'unstar it' : 'star it', () => library.setStarred(entry, !entry.starred)),
        }]
      : []),
    { key: 'remove', label: 'Remove from Library', icon: MinusCircleIcon, onSelect: () => act('remove it', () => library.remove(entry)) },
    ...(entry.builds
      ? [{
          key: 'delete',
          label: 'Delete gadget…',
          icon: TrashIcon,
          onSelect: () => {
            setDeleting(entry)
            setAsked(entry)
          },
        }]
      : []),
  ]

  const propsOf = (entry: LibraryEntry, time: string | undefined) => {
    const address = href?.(entry)
    return {
      entry,
      title: entry.title,
      detail: entryDetail(entry, { workspace: withWorkspace && view === 'list' }),
      icon: asideItemIcon(entry.item),
      time,
      waiting: entry.waiting,
      starred: entry.favorite ? entry.starred : undefined,
      onStarredChange: (starred: boolean) => act(starred ? 'star it' : 'unstar it', () => library.setStarred(entry, starred)),
      actions: actionsOf(entry, address),
      href: address,
      onSelect: () => onOpen(entry),
    }
  }

  return (
    <>
      {problem && <p role="alert" className="px-4 text-base text-kumo-subtle">{problem}</p>}
      {view === 'list'
        ? (
            <GroupedList
              headed={headed}
              groups={groups.map(({ key, label, rows }) => ({
                key,
                label,
                rows: rows.map(({ entry, time }) => ({ key: entry.key, content: <Row {...propsOf(entry, time)} /> })),
                onReorder: key === 'starred' ? onReorderStarred : undefined,
              }))}
            />
          )
        : (
            <CardGrid
              groups={groups.map(({ key, label, rows }) => ({
                key,
                label,
                cards: rows.map(({ entry, time }) => ({ key: entry.key, content: <Card {...propsOf(entry, time)} /> })),
                onReorder: key === 'starred' ? onReorderStarred : undefined,
              }))}
            />
          )}
      {sharing?.entry.item.kind === 'output' && (
        <ShareGadgetDialog
          workspaceId={sharing.entry.workspaceId}
          gadgetId={sharing.entry.item.output.workpieceId}
          title={sharing.entry.title}
          page={sharing.page}
          open={sharing.open}
          onOpenChange={(open) => setSharing((current) => current && { ...current, open })}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={`Delete ${asked?.title ?? 'the gadget'}?`}
        description="It is deleted for everyone in its workspace, with its files, and can’t be had back. What it was connected to stays connected."
        confirm="Delete gadget"
        destructive
        onConfirm={async () => {
          if (!deleting || connection?.blocked()) return
          await library.deleteGadget(deleting)
        }}
      />
    </>
  )
}
