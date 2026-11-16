import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { KindMark } from '@/components/KindMark'
import type { FavoriteItem } from '@gadgets/workshop-shared/api'
import { asideItemIcon } from '@/aside/asideItemIcon'
import { FanCard } from '@/blocks/FanCard'
import { GadgetCard } from '@/blocks/GadgetCard'
import { SheetPicture } from '@/blocks/SheetPicture'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { readLibraryStarOrder } from '@/prefs/libraryStars'
import { libraryEntries, recentOrder, removalKey, type LibraryEntry } from './libraryEntries'
import { useLibrary } from './useLibrary'
import { useLibraryPicture } from './useLibraryPicture'

/** Two rows of three, the last of them going to all of them: the handful a user comes back to. */
const SHOWN = 5
/** With fewer than this, blueprints to start from follow. */
const FEW = 3
/**
 * How long the row waits for its pictures the first time, to come in with them, before it comes in
 * with those there are and the rest fade in as they arrive. A gadget the server has to draw afresh
 * can take seconds.
 */
const GATHER_MS = 1200

export type RecentGadgetsProps = {
  onOpen: (entry: LibraryEntry) => void
  href?: (entry: LibraryEntry) => string
  /** Goes to all of them, in the Library. */
  onBrowse: () => void
  browseHref?: string
  /** Shown under them while the user has few, such as blueprints to start from. */
  fewer?: ReactNode
}

// Where the row is in coming in: its pictures fade in only once it is in view, and the cards do
// not come in one by one, as the row comes in whole.
type Showing = { visible: boolean; onLoad: (key: string) => void }

// Each its own component, so that each fetches its own picture.
const Card = ({ entry, onOpen, href, showing }: { entry: LibraryEntry; onOpen: () => void; href?: string; showing: Showing }) => {
  const { ref, preview } = useLibraryPicture(entry)
  const { onLoad } = showing
  return (
    <GadgetCard
      ref={ref}
      title={entry.title}
      icon={asideItemIcon(entry.item)}
      picture={preview?.type === 'image' ? preview.url : undefined}
      fadePicture={showing.visible}
      onPictureLoad={() => onLoad(entry.key)}
      entrance={false}
      detail={entry.sharedBy ? `From ${entry.sharedBy}` : entry.workspaceTitle}
      waiting={entry.waiting}
      href={href}
      onOpen={onOpen}
    />
  )
}

// One of the next few, on a sheet of the fan that goes to all of them.
const FanPicture = ({ entry, showing }: { entry: LibraryEntry; showing: Showing }) => {
  const { ref, preview } = useLibraryPicture(entry)
  const { onLoad } = showing
  return (
    <div ref={ref} className="size-full">
      <SheetPicture picture={preview?.type === 'image' ? preview.url : undefined} fade={showing.visible} onLoad={() => onLoad(`fan:${entry.key}`)} />
    </div>
  )
}

// The row has come in once since the page was loaded: drawn again, as when Home is come back to or
// the window narrows, it is simply there, its pictures drawn from what was fetched.
let cameIn = false

/**
 * The gadgets the user comes back to, under Home's composer, drawn as the blueprints to start
 * from are: up to two rows of three cards, any with changes waiting on the user to approve first,
 * saying how many, then the starred ones in the order the user put them in, then the most
 * recently active, as the Library's Recent has them (`recentOrder`); and last, a card to all of
 * them in the Library, a fan of their screens. With fewer than three, `fewer` follows instead, as a
 * new user has more use for something to start from. Nothing at all until the Library is read, so
 * Home does not shift as it arrives; then, the first time, it comes in whole once its pictures are
 * ready (or a moment has passed), rather than card by card and picture by picture. Its order is
 * kept while it is shown.
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
    const all = libraryEntries({ outputs, files: [], connected: [], favorites, removals, builds })
    // In the Library's Recent order, of its gadgets alone.
    const { waiting, stars, rest } = recentOrder(all.gadgets, {
      starred: all.favorites.filter(({ section }) => section === 'gadget'),
      starOrder: readLibraryStarOrder(),
    })
    return [...waiting, ...stars, ...rest]
  }, [outputs, favorites, removals, known])

  // The first time, the row waits unseen, its room kept, until its pictures are ready to draw or
  // `GATHER_MS` has passed, and then comes in whole, rather than card by card and picture by picture.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set())
  const [late, setLate] = useState(cameIn)
  const listed = ordered !== undefined
  useEffect(() => {
    if (!listed || late) return
    const timer = setTimeout(() => setLate(true), GATHER_MS)
    return () => clearTimeout(timer)
  }, [listed, late])
  const onLoad = useCallback((key: string) => setLoaded((had) => (had.has(key) ? had : new Set(had).add(key))), [])
  // The order it came in, kept while it is shown: a gadget worked on meanwhile is not moved under
  // the pointer.
  // (Only ever added to, and the same whenever it is read, so drawing it again changes nothing.)
  const [order] = useState(() => new Map<string, number>())

  if (!ordered) return null
  for (const { key } of ordered) if (!order.has(key)) order.set(key, order.size)
  const placed = ordered.toSorted((a, b) => order.get(a.key)! - order.get(b.key)!)
  const shown = placed.slice(0, SHOWN)
  // The fan shows those not shown first, then those shown, as the blueprints' does.
  const fanned = placed.length >= FEW ? [...placed.slice(SHOWN), ...shown].slice(0, 3) : []
  const all = [...shown.map(({ key }) => key), ...fanned.map(({ key }) => `fan:${key}`)]
  const visible = late || all.every((key) => loaded.has(key))
  if (visible) cameIn = true
  const showing: Showing = { visible, onLoad }

  return (
    <div className="flex w-full flex-col gap-8">
      {shown.length > 0 && (
        <section
          aria-labelledby="jump-back-in"
          aria-busy={!visible}
          className={cn('flex w-full flex-col gap-3 transition-opacity duration-500 ease-out motion-reduce:transition-none', !visible && 'opacity-0')}
        >
          <h2 id="jump-back-in" className="px-1 text-sm text-kumo-subtle">Jump back in</h2>
          <div className="grid grid-cols-3 gap-3">
            {shown.map((entry) => (
              <Card key={entry.key} entry={entry} onOpen={() => onOpen(entry)} href={href?.(entry)} showing={showing} />
            ))}
            {ordered.length >= FEW && (
              <FanCard
                title="All gadgets"
                icon={<KindMark name="collection" />}
                detail={`${ordered.length} in your Library`}
                sheets={fanned.map((entry) => <FanPicture key={entry.key} entry={entry} showing={showing} />)}
                href={browseHref}
                onOpen={onBrowse}
                entrance={false}
              />
            )}
          </div>
        </section>
      )}
      {ordered.length < FEW && fewer}
    </div>
  )
}
