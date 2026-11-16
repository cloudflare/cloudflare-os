import { useMemo, useState, type ReactNode } from 'react'
import { ArrowSquareOutIcon, ArrowUpRightIcon, FileDocIcon, FileImageIcon, FilePdfIcon, FileAudioIcon, FileXlsIcon, MinusCircleIcon, StarIcon, TrashIcon } from '@phosphor-icons/react'
import { ConnectedFileView } from '@/blocks/ConnectedFileView'
import { LibraryCard } from '@/blocks/LibraryCard'
import { LibraryRow, type LibraryAction } from '@/blocks/LibraryRow'
import { ListToolbar } from '@/blocks/ListToolbar'
import { documentFixture, longDocumentFixture, presentationFixture, spreadsheetFixture } from '@/blocks/resource-preview/fixtures'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FormatIcon } from '@/components/FormatIcon'
import { CardGrid } from '@/components/CardGrid'
import { GroupedList, type GroupedListGroup } from '@/components/GroupedList'
import type { ListViewMode } from '@/components/listView'
import { useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

// A picture of its own, as an image file in the Library has: drawn here, as nothing is fetched.
const picture = (from: string, to: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="4" height="4" fill="url(#g)"/></svg>`)}`

const SEA = picture('#9ec5ff', '#1d3f8f')
const NIGHT = picture('#22303f', '#0b1a12')


type Item = { key: string; title: string; detail: string; icon: ReactNode; thumbnail?: string; time: string; waiting?: number; group: string; star?: boolean; canDelete?: boolean }

const ITEMS: Item[] = [
  { key: 'image', title: 'my-favourite-image.jpg', detail: 'File · Trip planner', icon: <FileImageIcon aria-hidden="true" />, thumbnail: SEA, time: '1 hour ago', group: 'Today', star: true },
  { key: 'review', title: 'Q3 platform review', detail: 'Document · Engineering notes', icon: <FormatIcon name="fileText" />, waiting: 3, time: '4 hours ago', group: 'Today', star: true, canDelete: true },
  { key: 'song', title: 'my-song-with-a-name-long-enough-that-it-has-to-be-cut-off-somewhere-in-the-row.wav', detail: 'File · Demos', icon: <FileAudioIcon aria-hidden="true" />, time: '12 hours ago', group: 'Today', star: false },
  { key: 'plan', title: 'Aurora Launch Plan', detail: 'Google Doc · Launch · Shared by Grace Hopper', icon: <FileDocIcon aria-hidden="true" />, time: 'Yesterday', group: 'Since Monday' },
  { key: 'forecast', title: 'Q3 forecast', detail: 'Google Sheet · Budget 2026', icon: <FileXlsIcon aria-hidden="true" />, time: 'Tuesday', group: 'Since Monday' },
  { key: 'night', title: 'milky-way.png', detail: 'File · Trip planner', icon: <FileImageIcon aria-hidden="true" />, thumbnail: NIGHT, time: 'Monday', group: 'Since Monday', star: false },
  { key: 'pdf', title: 'my-long-pdf-name-clipped-at-two-lines.pdf', detail: 'File · Contracts', icon: <FilePdfIcon aria-hidden="true" />, time: 'Oct 27', group: 'October', star: false },
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
  const [view, setView] = useState<ListViewMode>('list')
  const [sort, setSort] = useState('recent')
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
    detail: item.detail,
    thumbnail: item.thumbnail,
    time: item.time,
    waiting: item.waiting,
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
      <div className="w-full max-w-3xl">
        <ListToolbar
          noun="the library"
          search={{ value: query, onChange: setQuery }}
          view={{ value: view, onChange: setView }}
          order={{ value: sort, options: [{ id: 'recent', label: 'Last active' }, { id: 'name', label: 'Name' }], onChange: setSort }}
        />
      </div>
      <div key={view} className="appears w-full max-w-3xl">
        {view === 'list'
          ? <GroupedList groups={groups} />
          : (
              <CardGrid
                groups={groups.map(({ key, label, rows }) => ({
                  key,
                  label,
                  cards: rows.map(({ key: row }) => ({ key: row, content: <LibraryCard {...propsOf(ITEMS.find(({ key: itemKey }) => itemKey === row)!)} /> })),
                }))}
              />
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
    <Section title="GroupedList, CardGrid, LibraryRow, LibraryCard, ContextMenu (the Library’s entries as rows or cards, latest first or by name, searched; star one to see it shrink out of its stretch of time and grow into the starred group, and unstar it to send it back; More and the star slide out when pointed at, a starred one keeps its star, and a right-click opens the same menu as More where it was clicked; an image fills its icon’s place; the review is a gadget the viewer builds, with changes waiting, so it says so in place of when, and can be deleted once asked)">
      <LibraryItemsPreview />
    </Section>
    <Section title="ConnectedFileView (a Google Doc, Sheet and Slides deck beside the page, read only and in their own look, as they will be once the changes waiting are made, counted in a pill; a long Doc broken into Letter pages where Docs would break it, a manual page break included; and each while it loads, a blank one of its kind where it will be. These are fixtures: nothing is fetched from Google)">
      <Column>
        <Pane><ConnectedFileView preview={documentFixture} kind="document" /></Pane>
        <Pane><ConnectedFileView preview={longDocumentFixture} kind="document" /></Pane>
        <Pane><ConnectedFileView preview={spreadsheetFixture} kind="spreadsheet" /></Pane>
        <Pane><ConnectedFileView preview={presentationFixture} kind="presentation" /></Pane>
        <Pane><ConnectedFileView kind="document" /></Pane>
        <Pane><ConnectedFileView kind="spreadsheet" /></Pane>
        <Pane><ConnectedFileView kind="presentation" /></Pane>
      </Column>
    </Section>
  </>
)
