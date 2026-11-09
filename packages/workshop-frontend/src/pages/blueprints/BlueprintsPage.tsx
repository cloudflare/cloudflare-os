import { useRef, useState, type ChangeEvent } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { ListBullets, UploadSimple } from '@phosphor-icons/react'
import { TemplateIcon } from '../../components/icons/designIcons'
import { useAuthenticatedApi } from '../../AuthContext'
import { SplitPage } from '../../components/AppShell/SplitPage'
import { PageHeader, PageTabs } from '../../components/PageHeader'
import { RoundButton } from '../../components/RoundButton'
import { LibraryIcon } from '../../components/icons/designIcons'
import { LibrarySearch } from '../../features/library/LibraryToolbar'
import type { LibraryLayout } from '../../features/library/LibraryViews'
import { useDocumentTitle } from '../../useDocumentTitle'
import { FeaturedBlueprints } from './FeaturedBlueprints'
import { YourBlueprints } from './YourBlueprints'

/** The Blueprints page's tabs: blueprints featured on this deployment, and the ones the user published or saved. */
export type BlueprintsTab = 'featured' | 'yours'

const TABS: { value: BlueprintsTab; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'yours', label: 'Yours' },
]

const LAYOUT_KEY = 'gadgets:blueprints:layout'

// Featured blueprints read best as their screenshots, so the page opens as a grid unless the user
// chose the list on this device.
const useBlueprintsLayout = (): [LibraryLayout, (layout: LibraryLayout) => void] => {
  const [layout, setLayoutState] = useState<LibraryLayout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const setLayout = (next: LibraryLayout) => {
    setLayoutState(next)
    try { localStorage.setItem(LAYOUT_KEY, next) } catch { /* still applies for this visit */ }
  }
  return [layout, setLayout]
}

/**
 * Blueprints, in the Library's frame: the blueprints to start a gadget from. Featured shows what the
 * deployment offers; Yours lists what the user published or saved, and takes an uploaded
 * `.gadget` archive.
 */
export function BlueprintsPage({ tab, onTabChange }: { tab: BlueprintsTab; onTabChange: (tab: BlueprintsTab) => void }) {
  useDocumentTitle('Blueprints')
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [layout, setLayout] = useBlueprintsLayout()
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  // Bumped after an upload so Yours reads its list again.
  const [uploads, setUploads] = useState(0)
  const uploadInput = useRef<HTMLInputElement>(null)

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Cleared at once so picking the same file again still fires `change`.
    event.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      await authenticatedApi.importBlueprint(file.stream() as ReadableStream<Uint8Array>)
      toasts.add({ title: `Uploaded “${file.name}”` })
      setUploads(n => n + 1)
      onTabChange('yours')
    } catch (err) {
      console.error('Failed to upload blueprint:', err)
      toasts.add({ title: "Couldn't upload the blueprint", variant: 'error' })
    } finally {
      setUploading(false)
    }
  }

  const chooseFile = () => uploadInput.current?.click()

  return (
    <SplitPage>
      <PageHeader icon={<TemplateIcon size={16} />} title="Blueprints" />
      <input ref={uploadInput} type="file" accept=".gadget" className="hidden" onChange={event => void upload(event)} />
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-3 px-3 pb-3 max-md:px-4">
        <PageTabs label="Blueprints" tabs={TABS} value={tab} onChange={next => { setQuery(''); onTabChange(next) }} />
        <span className="flex-1" />
        <div className="flex items-center gap-2 max-md:fixed max-md:inset-x-0 max-md:bottom-4 max-md:z-10 max-md:justify-center">
          {tab === 'featured' && (
            <RoundButton
              label={layout === 'list' ? 'Show as grid' : 'Show as list'}
              onClick={() => setLayout(layout === 'list' ? 'grid' : 'list')}
              className="max-md:!size-11"
            >
              {layout === 'list' ? <LibraryIcon size={16} /> : <ListBullets size={16} weight="light" />}
            </RoundButton>
          )}
          <LibrarySearch key={tab} query={query} onQueryChange={setQuery} placeholder="Search blueprints" />
          <button
            type="button"
            onClick={chooseFile}
            disabled={uploading}
            title="Upload a .gadget archive"
            className="inline-flex h-[34px] max-md:h-11 max-md:px-4 max-md:text-[15px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3 text-[13px] font-medium leading-4 text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-default disabled:opacity-50"
          >
            <UploadSimple size={13} weight="bold" />
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
      <div className="flex-1 px-4 pb-24 pt-2.5 md:px-[45px] md:pb-8">
        {tab === 'featured'
          ? <FeaturedBlueprints layout={layout} query={query} />
          : <YourBlueprints key={uploads} query={query} onBrowseFeatured={() => onTabChange('featured')} onUpload={chooseFile} />}
      </div>
    </SplitPage>
  )
}
