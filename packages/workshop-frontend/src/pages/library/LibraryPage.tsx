import { useMemo, useState } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import { useDocumentTitle } from '../../useDocumentTitle'
import { SplitPage } from '../../components/AppShell/SplitPage'
import { PageHeader, PageTabs } from '../../components/PageHeader'
import { LibraryIcon } from '../../components/icons/designIcons'
import { MENU_ITEM } from '../../components/menuStyles'
import { formatOf } from '../../components/format/formats'
import { useOutputFormats } from '../../components/format/useOutputFormats'
import { useWorkspaces } from '../../features/workspaces/WorkspacesContext'
import { LibraryCollection, type LibraryItem } from '../../features/library/LibraryViews'
import {
  LibrarySearch,
  LibraryViewControls,
  NewMenuButton,
  arrangeLibraryItems,
  type LibraryFilterOption,
  type LibrarySort,
} from '../../features/library/LibraryToolbar'
import { LibraryPreviewPane } from '../../features/library/LibraryPreviewPane'
import { useExternalFiles, useFavorites, useOutputs, useWorkspaceFiles } from '../../features/library/useLibraryData'
import { mediaKind } from '../../features/drafts/drafts'
import { useLibraryItems } from '../../features/library/useLibraryItems'
import { useLibraryLayout } from '../../features/library/useLibraryLayout'

/** The Library's tabs (Figma "Frame 804"). */
export type LibraryTab = 'favorites' | 'apps' | 'files'

const TABS: { value: LibraryTab; label: string }[] = [
  { value: 'favorites', label: 'Favorites' },
  { value: 'apps', label: 'Apps' },
  { value: 'files', label: 'Files' },
]

const FILE_FILTERS: LibraryFilterOption[] = [
  { value: 'all', label: 'All files' },
  { value: 'image', label: 'Images' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'audio', label: 'Audio' },
  { value: 'google', label: 'Docs, Sheets and Slides' },
  { value: 'other', label: 'Other' },
]

const fileKind = (mimeType = '') => mediaKind(mimeType) ? 'google' : mimeType.startsWith('image/') ? 'image'
  : mimeType === 'application/pdf' ? 'pdf' : mimeType.startsWith('audio/') ? 'audio' : 'other'

// Favorites shows starred items, then a card of the most recent others to reach for.
const RECENT_UNSTARRED = 8

/**
 * The Library (Figma "MacBook Pro 14\" - 26", with "- 18" and "- 19" for its list and grid): the
 * apps and files of every workspace in one place, starred ones under Favorites.
 */
export function LibraryPage({ tab, onTabChange }: { tab: LibraryTab; onTabChange: (tab: LibraryTab) => void }) {
  useDocumentTitle('Library')
  const navigate = useNavigate()
  const { workspaces } = useWorkspaces()
  const { favorites, starred, setStarred } = useFavorites()
  const { outputs } = useOutputs()
  const outputFormats = useOutputFormats()
  const [layout, setLayout] = useLibraryLayout()
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Record<LibraryTab, string>>({ favorites: 'all', apps: 'all', files: 'all' })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [paneExpanded, setPaneExpanded] = useState(false)

  // Files are read from each workspace the user can build in, most recently active first.
  const fileWorkspaces = useMemo(() => workspaces
    // Never one the user hasn't opened yet: listing its files would count as opening it.
    .filter(w => w.owner === undefined || (w.role === 'build' && !w.invited))
    .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
    .map(w => ({ id: w.id, title: w.title })), [workspaces])
  const files = useWorkspaceFiles(workspaces.length ? fileWorkspaces : null)
  const external = useExternalFiles(workspaces.length ? fileWorkspaces : null)

  const apps = useMemo(() => (outputs ?? []).map(output => ({
    workspaceId: output.workspaceId, workpieceId: output.workpieceId, title: output.title,
    output: output.output, date: output.lastActive, workspaceTitle: output.workspaceTitle,
  })), [outputs])
  const { appItems, fileItems, favoriteItems, preview, setPreview } = useLibraryItems({
    apps, files: files ?? [], external: external ?? undefined, favorites: favorites ?? [], starred, showContext: true,
  })

  const appFilters: LibraryFilterOption[] = useMemo(() => [
    { value: 'all', label: 'All apps' },
    ...[...new Set(appItems.map(item => formatOf(item.output).noun))].map(noun => ({ value: noun, label: noun })),
  ], [appItems])
  const favoriteFilters: LibraryFilterOption[] = [
    { value: 'all', label: 'Everything' }, { value: 'app', label: 'Apps' }, { value: 'file', label: 'Files' },
  ]
  const filterOptions = tab === 'apps' ? appFilters : tab === 'files' ? FILE_FILTERS : favoriteFilters
  const filter = filters[tab]

  const loading = tab === 'apps' ? outputs === null : tab === 'files' ? files === null
    : favorites === null
  const shown: LibraryItem[] = useMemo(() => {
    if (tab === 'apps') {
      return arrangeLibraryItems(appItems.filter(item => filter === 'all' || formatOf(item.output).noun === filter), sort, query)
    }
    if (tab === 'files') {
      return arrangeLibraryItems(fileItems.filter(item => filter === 'all' || fileKind(item.mimeType) === filter), sort, query)
    }
    const ofKind = (item: LibraryItem) => filter === 'all' || item.kind === filter
    const starredItems = arrangeLibraryItems(favoriteItems.filter(ofKind), sort, query)
    const recent = arrangeLibraryItems([...appItems, ...fileItems].filter(item => !item.starred && ofKind(item)), 'recent', query)
      .slice(0, RECENT_UNSTARRED)
    return [...starredItems, ...recent]
  }, [tab, appItems, fileItems, favoriteItems, filter, sort, query])

  const toggleStar = (item: LibraryItem) => { if (item.favorite) void setStarred(item.favorite, !item.starred) }
  const selectedItems = shown.filter(item => selected.has(item.key))

  return (
    <SplitPage
      paneExpanded={paneExpanded}
      pane={preview && (
        <LibraryPreviewPane
          preview={preview}
          onClose={() => { setPreview(null); setPaneExpanded(false) }}
          expanded={paneExpanded}
          onExpandedChange={setPaneExpanded}
        />
      )}
    >
      <PageHeader icon={<LibraryIcon size={16} />} title="Library" />
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-3 px-3 pb-3 max-md:px-4">
        <PageTabs label="Library" tabs={TABS} value={tab} onChange={next => { setSelected(new Set()); onTabChange(next) }} />
        <span className="flex-1" />
        <div className="flex items-center gap-2 max-md:fixed max-md:inset-x-0 max-md:bottom-4 max-md:z-10 max-md:justify-center">
          <LibraryViewControls
            layout={layout}
            onLayoutChange={setLayout}
            sort={sort}
            onSortChange={setSort}
            filters={filterOptions}
            filter={filter}
            onFilterChange={value => setFilters(current => ({ ...current, [tab]: value }))}
          />
          <LibrarySearch query={query} onQueryChange={setQuery} placeholder="Search the library" />
          <NewMenuButton>
            <DropdownMenu.Item onClick={() => navigate({ to: '/' })} className={MENU_ITEM}>Chat</DropdownMenu.Item>
            {outputFormats.formats.map(format => (
              <DropdownMenu.Item
                key={format.blueprintId}
                disabled={outputFormats.creating !== null}
                onClick={() => void outputFormats.create(format)}
                className={MENU_ITEM}
              >
                {format.output.noun}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item onClick={() => navigate({ to: '/blueprints' })} className={MENU_ITEM}>From a template…</DropdownMenu.Item>
          </NewMenuButton>
        </div>
      </div>
      <div className="flex-1 px-4 pb-24 pt-2.5 md:px-[45px] md:pb-8">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        ) : (
          <LibraryCollection
            items={shown}
            layout={layout}
            grouping={tab === 'favorites' ? 'favorites' : 'recency'}
            onToggleStar={toggleStar}
            empty={query ? 'Nothing matches your search.'
              : tab === 'favorites' ? 'Star apps and files to keep them here.'
              : tab === 'apps' ? 'Apps you make will show up here.'
              : 'Files you add to chats, and Google files agents work on, will show up here.'}
            selection={{
              selected,
              onChange: (key, isSelected) => setSelected(current => {
                const next = new Set(current)
                if (isSelected) next.add(key)
                else next.delete(key)
                return next
              }),
            }}
          />
        )}
      </div>
      {selectedItems.length > 0 && (
        <div className="pointer-events-none sticky bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-kumo-contrast p-1 pl-4 text-[13px] text-kumo-inverse shadow-lg">
            <span className="mr-2">{selectedItems.length} selected</span>
            <button type="button" className="h-7 cursor-pointer rounded-full px-3 hover:bg-kumo-inverse/15"
              onClick={() => {
                const star = selectedItems.some(item => !item.starred)
                for (const item of selectedItems) if (item.favorite && item.starred !== star) void setStarred(item.favorite, star)
                setSelected(new Set())
              }}>
              {selectedItems.some(item => !item.starred) ? 'Star' : 'Unstar'}
            </button>
            <button type="button" className="h-7 cursor-pointer rounded-full px-3 hover:bg-kumo-inverse/15"
              onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      )}
    </SplitPage>
  )
}
