import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { FileText, ImageSquare } from '@phosphor-icons/react'
import type { BlueprintOutput, FavoriteItemSpec } from '@gadgets/workshop-shared/api'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import { DraftFileIcon } from '../drafts/DraftFileIcon'
import { mediaKind } from '../drafts/drafts'
import { FileAudioIcon, FilePdfIcon, MoreIcon, StarIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { ContextMenu, DropdownMenuEntries, type MenuEntry } from '../../components/ContextMenu'
import { libraryBucket, libraryTimeLabel } from './libraryTime'

/** One app or file as the Library shows it, in a list row or a grid tile. */
export type LibraryItem = {
  key: string
  kind: 'app' | 'file'
  title: string
  /** When it was last touched: an app's workspace activity, a file's upload. */
  date: Date
  starred: boolean
  /**
   * What starring it records; see `AuthenticatedApi.setFavorite()`. Absent for what can't be
   * starred: a file in a connected service, which lives there rather than here.
   */
  favorite?: FavoriteItemSpec
  /** Where it lives, shown under its name in the global Library. */
  context?: string
  mimeType?: string
  output?: BlueprintOutput
  /** Fetches a file's bytes, for an image's thumbnail and preview. */
  loadContent?: () => Promise<Uint8Array>
  onOpen: () => void
  /** What can be done with it, in its More menu and on a right-click, if anything. */
  actions?: MenuEntry[]
}

/** A filled version of the design's star, for starred items. */
export const StarFilledIcon = (props: { size?: number; className?: string }) =>
  <StarIcon fill="currentColor" {...props} />

// Images and PDFs are shown as themselves once they scroll into view; past this size the icon
// stands in.
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024

/** Whether a file of this type gets a picture of itself as its thumbnail. */
export const hasThumbnail = (mimeType?: string) =>
  mimeType?.startsWith('image/') === true || mimeType === 'application/pdf'

/**
 * A file's thumbnail once it is on screen, as an object URL revoked on unmount: an image as
 * itself, a PDF as its first page. Other kinds, and files too big to fetch for a thumbnail, keep
 * their type's icon.
 */
export function useImageUrl(item: Pick<LibraryItem, 'mimeType' | 'loadContent'>, enabled = true) {
  const [url, setUrl] = useState<string | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const shown = hasThumbnail(item.mimeType) && item.loadContent !== undefined
  useEffect(() => {
    if (!shown || !enabled || !ref.current) return
    let cancelled = false
    let objectUrl: string | null = null
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      item.loadContent!().then(async bytes => {
        if (cancelled || bytes.byteLength > MAX_THUMBNAIL_BYTES) return
        const blob = item.mimeType === 'application/pdf'
          ? await (await import('./PdfPages')).pdfThumbnail(bytes)
          : new Blob([bytes as BlobPart], { type: item.mimeType })
        if (cancelled || !blob) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }).catch(() => {})
    })
    observer.observe(ref.current)
    return () => {
      cancelled = true
      observer.disconnect()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [shown, enabled, item.loadContent, item.mimeType])
  return { ref, url }
}

/**
 * The icon the design gives a file of this type: a Google file, PDF and audio drawn as such, the
 * rest generic.
 */
export function FileTypeIcon({ mimeType, size = 16 }: { mimeType?: string; size?: number }) {
  const google = mimeType && mediaKind(mimeType)
  if (google) return <DraftFileIcon kind={google} size={size + 2} />
  if (mimeType === 'application/pdf') return <FilePdfIcon size={size + 4} />
  if (mimeType?.startsWith('audio/')) return <FileAudioIcon size={size} />
  if (mimeType?.startsWith('image/')) return <ImageSquare size={size} weight="light" />
  return <FileText size={size} weight="light" />
}

/** An item's 25px glyph (Figma "Frame 704"): an image's thumbnail, else its type's icon. */
function ItemGlyph({ item }: { item: LibraryItem }) {
  const { ref, url } = useImageUrl(item)
  return (
    <span ref={ref} className="flex size-[25px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-kumo-default">
      {url ? <img src={url} alt="" className={`size-full object-cover ${item.mimeType === 'application/pdf' ? 'bg-white object-top' : ''}`} />
        : item.kind === 'app' ? <FormatGlyph output={item.output} size="md" weight="regular" />
        : <FileTypeIcon mimeType={item.mimeType} />}
    </span>
  )
}

function StarButton({ item, onToggle, alwaysVisible }: {
  item: LibraryItem
  onToggle: (item: LibraryItem) => void
  alwaysVisible: boolean
}) {
  return (
    <button
      type="button"
      onClick={event => { event.stopPropagation(); onToggle(item) }}
      aria-label={item.starred ? `Unstar ${item.title}` : `Star ${item.title}`}
      aria-pressed={item.starred}
      className={`flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-default transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
        item.starred || alwaysVisible ? 'opacity-50 hover:opacity-100' : 'opacity-0 group-hover/row:opacity-50 hover:!opacity-100'
      }`}
    >
      {item.starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
    </button>
  )
}

function ItemMenu({ item, className = '' }: { item: LibraryItem; className?: string }) {
  if (!item.actions) return null
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={
        <button
          type="button"
          onClick={event => event.stopPropagation()}
          aria-label={`More for ${item.title}`}
          className={`flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-default opacity-0 transition-opacity hover:!opacity-100 focus-visible:opacity-100 focus-visible:outline-none group-hover/row:opacity-50 data-[popup-open]:opacity-100 ${className}`}
        >
          <MoreIcon size={16} />
        </button>
      } />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
        <DropdownMenuEntries items={item.actions} />
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

// A right-click offers the More menu's actions, and starring.
const contextActions = (item: LibraryItem, onToggleStar: (item: LibraryItem) => void): MenuEntry[] => [
  ...(item.actions ?? []),
  ...(item.actions?.length && item.favorite ? ['separator' as const] : []),
  ...(item.favorite ? [{ label: item.starred ? 'Unstar' : 'Star', onSelect: () => onToggleStar(item) }] : []),
]

/** A Library row (Figma "Frame 681"): glyph, name, when, star and More. */
function LibraryRow({ item, onToggleStar, selection }: {
  item: LibraryItem
  onToggleStar: (item: LibraryItem) => void
  selection?: { selected: boolean; onChange: (selected: boolean) => void }
}) {
  return (
    <ContextMenu items={contextActions(item, onToggleStar)}>
      <div className="group/row relative">
        {selection && (
          // The design's selection box (Figma "Frame 818") sits in the gutter left of the card.
          <input
            type="checkbox"
            checked={selection.selected}
            onChange={event => selection.onChange(event.target.checked)}
            aria-label={`Select ${item.title}`}
            className={`absolute -left-[33px] top-1/2 size-[15px] -translate-y-1/2 cursor-pointer appearance-none rounded-[4px] bg-kumo-base ring-1 ring-kumo-contrast/10 transition-opacity checked:bg-kumo-contrast max-md:hidden ${
              selection.selected ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100'
            }`}
          />
        )}
        <div
          role="button"
          tabIndex={0}
          onClick={item.onOpen}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.onOpen() }
          }}
          className="flex h-[49px] cursor-pointer items-center gap-3 rounded-[14px] px-3 outline-none transition-colors hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring [[data-popup-open]>*>&]:bg-kumo-tint"
        >
          <ItemGlyph item={item} />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default">{item.title}</span>
            {item.context && (
              <span className="hidden truncate text-[13px] text-kumo-subtle sm:inline">{item.context}</span>
            )}
          </span>
          <span className="shrink-0 text-[13px] leading-[22px] text-kumo-subtle">{libraryTimeLabel(item.date)}</span>
          {item.favorite
            ? <StarButton item={item} onToggle={onToggleStar} alwaysVisible={false} />
            : <span className="size-6 shrink-0" />}
          <ItemMenu item={item} />
        </div>
      </div>
    </ContextMenu>
  )
}

/** A Library grid tile (Figma "MacBook Pro 14\" - 19"): an image fills it; else icon and name. */
function LibraryTile({ item, onToggleStar }: { item: LibraryItem; onToggleStar: (item: LibraryItem) => void }) {
  const { ref, url } = useImageUrl(item)
  const isPdf = item.mimeType === 'application/pdf'
  return (
    <ContextMenu items={contextActions(item, onToggleStar)}>
      <div
        role="button"
        tabIndex={0}
        onClick={item.onOpen}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.onOpen() }
        }}
        title={item.title}
        className="group/row relative aspect-square cursor-pointer overflow-hidden rounded-2xl bg-kumo-base outline-none ring-1 ring-kumo-line transition-colors hover:bg-kumo-elevated focus-visible:ring-2 focus-visible:ring-kumo-ring"
      >
        <span ref={ref} className="absolute inset-0">
          {url && <img src={url} alt="" className={`size-full object-cover ${isPdf ? 'bg-white object-top' : ''}`} />}
        </span>
        {/* A page doesn't say what it is the way a photo does, so a PDF keeps its name. */}
        {url && isPdf && (
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-kumo-base via-kumo-base/95 to-transparent px-3.5 pb-3 pt-6">
            <span className="line-clamp-2 break-all text-[13px] leading-[18px] text-kumo-default">{item.title}</span>
          </span>
        )}
        {!url && (
          <>
            <span className="absolute left-3.5 top-3.5 text-kumo-default">
              {item.kind === 'app' ? <FormatGlyph output={item.output} size="md" weight="regular" /> : <FileTypeIcon mimeType={item.mimeType} />}
            </span>
            <span className="absolute inset-x-3.5 bottom-3.5 line-clamp-2 break-all text-[13px] leading-[18px] text-kumo-default">
              {item.title}
            </span>
          </>
        )}
        {item.favorite && <span className={`absolute right-2 top-2 ${url && !isPdf ? 'text-white [&_button]:!text-white' : ''}`}>
          <button
            type="button"
            onClick={event => { event.stopPropagation(); onToggleStar(item) }}
            aria-label={item.starred ? `Unstar ${item.title}` : `Star ${item.title}`}
            aria-pressed={item.starred}
            className={`flex size-6 cursor-pointer items-center justify-center rounded-md transition-opacity focus-visible:opacity-100 focus-visible:outline-none ${
              item.starred ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
            }`}
          >
            {item.starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
          </button>
        </span>}
        <ItemMenu item={item} className="absolute bottom-2 right-2 bg-kumo-base/80" />
      </div>
    </ContextMenu>
  )
}

export type LibraryLayout = 'list' | 'grid'

/** How a Library splits its list into cards: favorites first, by recency, or as one card. */
export type LibraryGrouping = 'favorites' | 'recency' | 'none'

/** The Library's list or grid of items, grouped into the design's grey cards (Figma "Frame 817"). */
export function LibraryCollection({
  items,
  layout,
  grouping,
  onToggleStar,
  empty,
  selection,
}: {
  items: LibraryItem[]
  layout: LibraryLayout
  grouping: LibraryGrouping
  onToggleStar: (item: LibraryItem) => void
  empty: ReactNode
  selection?: { selected: ReadonlySet<string>; onChange: (key: string, selected: boolean) => void }
}) {
  if (items.length === 0) {
    return <div className="py-16 text-center text-[13px] leading-5 text-kumo-subtle">{empty}</div>
  }
  if (layout === 'grid') {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(121px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,121px)]">
        {items.map(item => <LibraryTile key={item.key} item={item} onToggleStar={onToggleStar} />)}
      </div>
    )
  }
  const groups = grouping === 'none' ? [items]
    : grouping === 'favorites'
      ? [items.filter(item => item.starred), items.filter(item => !item.starred)]
      : [items.filter(item => libraryBucket(item.date) === 'recent'),
         items.filter(item => libraryBucket(item.date) === 'earlier')]
  return (
    <div className="flex flex-col gap-2.5">
      {groups.filter(group => group.length > 0).map((group, index) => (
        <div key={index} className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
          {group.map(item => (
            <LibraryRow
              key={item.key}
              item={item}
              onToggleStar={onToggleStar}
              selection={selection && {
                selected: selection.selected.has(item.key),
                onChange: selected => selection.onChange(item.key, selected),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
