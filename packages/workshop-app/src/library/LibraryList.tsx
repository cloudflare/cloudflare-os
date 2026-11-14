import { useState } from 'react'
import { ArrowSquareOutIcon, ArrowUpRightIcon, LinkIcon, MinusCircleIcon, StarIcon, TrashIcon } from '@phosphor-icons/react'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { LibraryRow, type LibraryAction, type LibraryItemProps } from '@/blocks/LibraryRow'
import { LibraryTile } from '@/blocks/LibraryTile'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { GroupedList } from '@/components/GroupedList'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import type { LibraryEntry, LibraryGroup } from './libraryEntries'
import type { LibraryEntriesState } from './useLibraryEntries'
import { useThumbnail } from './useThumbnail'

export type LibraryListProps = {
  groups: LibraryGroup[]
  /** As rows, grouped by when, or as a grid of tiles. */
  view?: 'list' | 'grid'
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
const Row = ({ entry, ...props }: Omit<LibraryItemProps, 'thumbnail'> & { entry: LibraryEntry }) => <LibraryRow {...props} thumbnail={useThumbnail(entry)} />
const Tile = ({ entry, ...props }: Omit<LibraryItemProps, 'thumbnail'> & { entry: LibraryEntry }) => <LibraryTile {...props} thumbnail={useThumbnail(entry)} />

/**
 * Library entries as rows in groups, or tiles in a grid, each starred from its row and with a menu
 * of what can be done with it: open it, here or in another tab, star it, take it out of the
 * Library, and for someone who builds where it was made, delete a gadget, once asked. A star or a
 * removal shows at once, and is undone, with why, if it does not hold.
 */
export const LibraryList = ({ groups, view = 'list', library, onOpen, href }: LibraryListProps) => {
  const connection = useConnectionNotice()
  // Why the last star or removal did not hold.
  const [problem, setProblem] = useState<string>()
  const [deleting, setDeleting] = useState<LibraryEntry>()
  // The one being asked about, kept while the dialog closes so its words do not change as it goes.
  const [asked, setAsked] = useState<LibraryEntry>()

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
    ...(entry.canDelete
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
      icon: asideItemIcon(entry.item),
      time,
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
              groups={groups.map(({ key, label, rows }) => ({
                key,
                label,
                rows: rows.map(({ entry, time }) => ({ key: entry.key, content: <Row {...propsOf(entry, time)} /> })),
              }))}
            />
          )
        : groups.map(({ key, label, rows }) => (
            <section key={key} aria-label={label} className="appears grid grid-cols-[repeat(auto-fill,minmax(min(7rem,calc(50%-0.375rem)),1fr))] gap-3 px-1">
              {rows.map(({ entry, time }) => <Tile key={entry.key} {...propsOf(entry, time)} />)}
            </section>
          ))}
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
