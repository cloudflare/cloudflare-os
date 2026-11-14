import { useMemo, useState, type ReactNode } from 'react'
import { ArrowSquareOutIcon, ArrowUpRightIcon, FileDocIcon, FileImageIcon, FilePdfIcon, FileAudioIcon, FileXlsIcon, MinusCircleIcon, StarIcon, TrashIcon } from '@phosphor-icons/react'
import { ConnectedFileView } from '@/blocks/ConnectedFileView'
import type { FileThumbnail } from '@/blocks/file-preview/useFileThumbnail'
import { ConnectedFileThumbnail } from '@/blocks/resource-preview/ConnectedFileThumbnail'
import { LibraryRow, type LibraryAction } from '@/blocks/LibraryRow'
import { LibraryTile } from '@/blocks/LibraryTile'
import { LibraryToolbar, type LibraryOrder, type LibraryView } from '@/blocks/LibraryToolbar'
import { documentFixture, presentationFixture, spreadsheetFixture } from '@/blocks/resource-preview/fixtures'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FormatIcon } from '@/components/FormatIcon'
import { GroupedList, type GroupedListGroup } from '@/components/GroupedList'
import { useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

// A picture of its own, as an image file in the Library has: drawn here, as nothing is fetched.
const picture = (from: string, to: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="4" height="4" fill="url(#g)"/></svg>`)}`

const SEA = picture('#9ec5ff', '#1d3f8f')
const NIGHT = picture('#22303f', '#0b1a12')

// A gadget's screen, as the server draws it for the Library: a page of its own colours.
const SCREEN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 80"><rect width="128" height="80" fill="#f7f5f2"/><rect x="10" y="10" width="54" height="6" rx="3" fill="#1f1f1f"/><rect x="10" y="22" width="80" height="3" rx="1.5" fill="#9a9a9a"/><rect x="10" y="34" width="34" height="34" rx="4" fill="#f6821f"/><rect x="48" y="34" width="34" height="34" rx="4" fill="#ffd9b8"/><rect x="86" y="34" width="34" height="34" rx="4" fill="#e8e4de"/></svg>')}`

type Item = { key: string; title: string; icon: ReactNode; thumbnail?: string; preview?: FileThumbnail; time: string; group: string; star?: boolean; canDelete?: boolean }

const ITEMS: Item[] = [
  { key: 'image', title: 'my-favourite-image.jpg', icon: <FileImageIcon aria-hidden="true" />, thumbnail: SEA, time: '1 hour ago', group: 'Today', star: true },
  { key: 'review', title: 'Q3 platform review', icon: <FormatIcon name="fileText" />, preview: { type: 'image', url: SCREEN, whole: false }, time: '4 hours ago', group: 'Today', star: true, canDelete: true },
  { key: 'song', title: 'my-song-with-a-name-long-enough-that-it-has-to-be-cut-off-somewhere-in-the-row.wav', icon: <FileAudioIcon aria-hidden="true" />, time: '12 hours ago', group: 'Today', star: false },
  { key: 'plan', title: 'Aurora Launch Plan', icon: <FileDocIcon aria-hidden="true" />, preview: { type: 'view', view: <ConnectedFileThumbnail preview={documentFixture} /> }, time: 'Yesterday', group: 'Since Monday' },
  { key: 'forecast', title: 'Q3 forecast', icon: <FileXlsIcon aria-hidden="true" />, preview: { type: 'view', view: <ConnectedFileThumbnail preview={spreadsheetFixture} /> }, time: 'Tuesday', group: 'Since Monday' },
  { key: 'night', title: 'milky-way.png', icon: <FileImageIcon aria-hidden="true" />, thumbnail: NIGHT, time: 'Monday', group: 'Since Monday', star: false },
  { key: 'pdf', title: 'my-long-pdf-name-clipped-at-two-lines.pdf', icon: <FilePdfIcon aria-hidden="true" />, time: 'Oct 27', group: 'October', star: false },
]

/**
 * The Library's rows and tiles: star one to see it leave its stretch of time for the starred group
 * at the top, and unstar it to see it go back; remove one, or delete a gadget once asked. A
 * connected file has no star.
 */
const LibraryItemsPreview = () => {
  const { report, say, later } = useReport()
  const [starred, setStarred] = useState<ReadonlySet<string>>(() => new Set(ITEMS.filter(({ star }) => star).map(({ key }) => key)))
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = useState<Item>()
  const [view, setView] = useState<LibraryView>('list')
  const [sort, setSort] = useState<LibraryOrder>('recent')
  const [query, setQuery] = useState('')

  const star = (item: Item, on: boolean) => {
    setStarred((current) => {
      const next = new Set(current)
      if (on) next.add(item.key)
      else next.delete(item.key)
      return next
    })
    say(`${on ? 'starred' : 'unstarred'} ${item.title}`)
  }
  const remove = (item: Item) => {
    setRemoved((current) => new Set([...current, item.key]))
    say(`removed ${item.title} from the Library`)
  }
  const actionsOf = (item: Item): LibraryAction[] => [
    { key: 'open', label: 'Open', icon: ArrowUpRightIcon, onSelect: () => say(`open ${item.title}`) },
    { key: 'tab', label: 'Open in new tab', icon: ArrowSquareOutIcon, onSelect: () => say(`open ${item.title} in a new tab`) },
    ...(item.star !== undefined ? [{ key: 'star', label: starred.has(item.key) ? 'Unstar' : 'Star', icon: StarIcon, onSelect: () => star(item, !starred.has(item.key)) }] : []),
    { key: 'remove', label: 'Remove from Library', icon: MinusCircleIcon, onSelect: () => remove(item) },
    ...(item.canDelete ? [{ key: 'delete', label: 'Delete gadget…', icon: TrashIcon, onSelect: () => setDeleting(item) }] : []),
  ]
  const propsOf = (item: Item) => ({
    title: item.title,
    icon: <>{item.icon}</>,
    thumbnail: item.thumbnail,
    preview: item.preview,
    time: item.time,
    starred: item.star === undefined ? undefined : starred.has(item.key),
    onStarredChange: (on: boolean) => star(item, on),
    actions: actionsOf(item),
    href: `#${item.key}`,
    onSelect: () => say(`open ${item.title}`),
  })

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const kept = ITEMS.filter(({ key, title }) => !removed.has(key) && words.every((word) => title.toLowerCase().includes(word)))
    return sort === 'name' ? kept.toSorted((a, b) => a.title.localeCompare(b.title)) : kept
  }, [removed, query, sort])
  const groups: GroupedListGroup[] = []
  const add = (key: string, label: string, item: Item) => {
    const found = groups.find((group) => group.key === key) ?? groups[groups.push({ key, label, rows: [] }) - 1]
    found.rows.push({ key: item.key, content: <LibraryRow {...propsOf(item)} /> })
  }
  for (const item of shown.filter(({ key }) => starred.has(key))) add('starred', 'Starred', item)
  for (const item of shown.filter(({ key }) => !starred.has(key))) add(sort === 'name' ? 'name' : `time:${item.group}`, sort === 'name' ? 'A to Z' : item.group, item)

  return (
    <>
      <div className="flex w-full justify-end">
        <LibraryToolbar view={view} onViewChange={setView} sort={sort} onSortChange={setSort} query={query} onQueryChange={setQuery} />
      </div>
      <div className="w-full max-w-3xl">
        {view === 'list'
          ? <GroupedList groups={groups} />
          : (
              <div className="flex flex-col gap-4">
                {groups.map(({ key, label, rows }) => (
                  <section key={key} aria-label={label} className="appears grid grid-cols-[repeat(auto-fill,minmax(min(7rem,calc(50%-0.375rem)),1fr))] gap-3 px-1">
                    {rows.map(({ key: row }) => {
                      const item = ITEMS.find(({ key: itemKey }) => itemKey === row)!
                      return <LibraryTile key={row} {...propsOf(item)} />
                    })}
                  </section>
                ))}
              </div>
            )}
      </div>
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={`Delete ${deleting?.title ?? 'the gadget'}?`}
        description="It is deleted for everyone in its workspace, with its files, and can’t be had back. What it was connected to stays connected."
        confirm="Delete gadget"
        destructive
        onConfirm={async () => {
          await later()
          if (deleting) remove(deleting)
        }}
      />
      <p className="w-full text-sm text-kumo-subtle">{report}</p>
    </>
  )
}

// As tall as the pane beside a chat would give it.
const Pane = ({ children }: { children: ReactNode }) => (
  <div className="flex h-[30rem] w-full flex-col overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">{children}</div>
)

/** Everything the Library page is made of, and a Google file beside the page. */
export const LibraryPreview = () => (
  <>
    <Section title="LibraryToolbar, GroupedList, LibraryRow, LibraryTile, ContextMenu (the Library: a list or a grid, latest first or by name, searched; star a row to see it shrink out of its stretch of time and grow into the starred group, and unstar it to send it back; More and the star slide out when pointed at, a starred one keeps its star, and a right-click opens the same menu as More where it was clicked; a tile’s buttons pop out in its corner, an image fills its tile, a gadget’s screen or a file’s first page sits under its name, and pressing a tile gives a little; the review is a gadget the viewer builds, so it can be deleted once asked)">
      <LibraryItemsPreview />
    </Section>
    <Section title="ConnectedFileView (a Google Doc, Sheet and Slides deck beside the page, read only and in their own look, as they will be once the changes waiting are made, counted in a pill; and each while it loads, a blank one of its kind where it will be. These are fixtures: nothing is fetched from Google)">
      <Column>
        <Pane><ConnectedFileView preview={documentFixture} kind="document" /></Pane>
        <Pane><ConnectedFileView preview={spreadsheetFixture} kind="spreadsheet" /></Pane>
        <Pane><ConnectedFileView preview={presentationFixture} kind="presentation" /></Pane>
        <Pane><ConnectedFileView kind="document" /></Pane>
        <Pane><ConnectedFileView kind="spreadsheet" /></Pane>
        <Pane><ConnectedFileView kind="presentation" /></Pane>
      </Column>
    </Section>
  </>
)
