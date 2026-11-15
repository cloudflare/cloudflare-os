import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { KindMark } from '@/components/KindMark'
import type { FavoriteItem } from '@gadgets/workshop-shared/api'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { FanCard } from '@/blocks/FanCard'
import { GadgetCard } from '@/blocks/GadgetCard'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { libraryEntries, removalKey, type LibraryEntry } from './libraryEntries'
import { useLibrary } from './useLibrary'
import { useLibraryPicture } from './useLibraryPicture'

/** Two rows of three, the last of them going to all of them: the handful a user comes back to. */
const SHOWN = 5
/** With fewer than this, blueprints to start from follow. */
const FEW = 3

export type RecentGadgetsProps = {
  onOpen: (entry: LibraryEntry) => void
  href?: (entry: LibraryEntry) => string
  /** Goes to all of them, in the Library. */
  onBrowse: () => void
  browseHref?: string
  /** Shown under them while the user has few, such as blueprints to start from. */
  fewer?: ReactNode
}

// Each its own component, so that each fetches its own picture.
const Card = ({ entry, index, onOpen, href }: { entry: LibraryEntry; index: number; onOpen: () => void; href?: string }) => {
  const { ref, preview } = useLibraryPicture(entry)
  return (
    <GadgetCard
      ref={ref}
      title={entry.title}
      icon={asideItemIcon(entry.item)}
      picture={preview?.type === 'image' ? preview.url : undefined}
      detail={entry.sharedBy ? `From ${entry.sharedBy}` : entry.workspaceTitle}
      waiting={entry.waiting}
      href={href}
      onOpen={onOpen}
      index={index}
    />
  )
}

// One of the next few, on a sheet of the fan that goes to all of them.
const FanPicture = ({ entry }: { entry: LibraryEntry }) => {
  const { ref, preview } = useLibraryPicture(entry)
  return (
    <div ref={ref} className="size-full">
      {preview?.type === 'image' && <img src={preview.url} alt="" className="size-full object-cover object-top" />}
    </div>
  )
}

/**
 * The gadgets the user comes back to, under Home's composer, drawn as the blueprints to start
 * from are: up to two rows of three cards, any with changes waiting on the user to approve first,
 * saying how many, then the starred ones, then the most recently active; and last, a card to all of
 * them in the Library, a fan of their screens. With fewer than three, `fewer` follows instead, as a
 * new user has more use for something to start from. Nothing at all until the Library is read, so
 * Home does not shift as it arrives.
 */
export const RecentGadgets = ({ onOpen, href, onBrowse, browseHref, fewer }: RecentGadgetsProps) => {
  const { api, reconnecting } = useApi()
  const library = useLibrary()
  const workspaces = useWorkspaces()
  const [favorites, setFavorites] = useState<FavoriteItem[]>()
  const [removals, setRemovals] = useState<ReadonlyMap<string, Date>>()

  useEffect(() => {
    if (reconnecting) return
    let cancelled = false
    api.listFavorites().then((items) => !cancelled && setFavorites(items), () => !cancelled && setFavorites([]))
    api.listLibraryRemovals().then(
      (items) => !cancelled && setRemovals(new Map(items.map((item) => [removalKey(item), item.removed]))),
      () => !cancelled && setRemovals(new Map()),
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  const outputs = library.status === 'ready' ? library.outputs : undefined
  const known = workspaces.status === 'ready' ? workspaces.workspaces : undefined
  const ordered = useMemo(() => {
    if (!outputs || !favorites || !removals || !known) return undefined
    const builds = new Set(known.filter(({ role }) => role !== 'use').map(({ id }) => id))
    const { gadgets } = libraryEntries({ outputs, files: [], connected: [], favorites, removals, builds })
    return gadgets.toSorted((a, b) =>
      Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || Number(b.starred) - Number(a.starred) || b.at.getTime() - a.at.getTime())
  }, [outputs, favorites, removals, known])

  if (!ordered) return null
  const shown = ordered.slice(0, SHOWN)
  // The fan shows those not shown first, then those shown, as the blueprints' does.
  const fanned = [...ordered.slice(SHOWN), ...shown].slice(0, 3)

  return (
    <div className="flex w-full flex-col gap-8">
      {shown.length > 0 && (
        <section aria-labelledby="jump-back-in" className="flex w-full flex-col gap-3">
          <h2 id="jump-back-in" className="appears px-1 text-sm text-kumo-subtle">Jump back in</h2>
          <div className="grid grid-cols-3 gap-3">
            {shown.map((entry, index) => (
              <Card key={entry.key} entry={entry} index={index} onOpen={() => onOpen(entry)} href={href?.(entry)} />
            ))}
            {ordered.length >= FEW && (
              <FanCard
                title="All gadgets"
                icon={<KindMark name="collection" />}
                detail={`${ordered.length} in your Library`}
                sheets={fanned.map((entry) => <FanPicture key={entry.key} entry={entry} />)}
                href={browseHref}
                onOpen={onBrowse}
                index={shown.length}
              />
            )}
          </div>
        </section>
      )}
      {ordered.length < FEW && fewer}
    </div>
  )
}
