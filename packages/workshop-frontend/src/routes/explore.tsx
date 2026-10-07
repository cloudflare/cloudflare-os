import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Tabs } from '@cloudflare/kumo'
import BlueprintsPage from '../BlueprintsPage'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { SpaceDirectory } from '../features/spaces/directory/SpaceDirectory'
import { useLastKnown } from '../features/spaces/useSpaces'
import { useDocumentTitle } from '../useDocumentTitle'

type ExploreTab = 'blueprints' | 'spaces'

// `tab` names the tab shown while the `spaces` flag is on. Blueprints, the default, is left out
// of the URL, and so is anything that names no tab.
type ExploreSearch = { tab?: 'spaces' }

const TABS: { value: ExploreTab; label: string }[] = [
  { value: 'blueprints', label: 'Blueprints' },
  { value: 'spaces', label: 'Spaces' },
]

/**
 * Explore. With the `spaces` flag on it holds two tabs, the featured blueprints and the directory
 * of spaces that publish workspaces, the chosen one kept in the URL so it can be linked to. With
 * the flag off it is the featured blueprints alone.
 */
const ExplorePage = () => {
  useDocumentTitle('Explore')
  const { tab } = useSearch({ from: '/explore' })
  const navigate = useNavigate({ from: '/explore' })
  const flag = useUiFeatureFlag('spaces')
  // The page shows nothing until the flag is first known, rather than a layout it would then
  // replace, and keeps its layout while a session that replaced another loads its flags.
  const enabled = useLastKnown(flag.loading ? null : flag.enabled, !flag.loading)

  if (enabled === null) return null
  if (!enabled) return <BlueprintsPage />

  const selected: ExploreTab = tab ?? 'blueprints'
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-3 sm:px-10">
      <header className="px-3 pb-4 pt-6 sm:pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Explore</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Discover featured blueprints to start a workspace from, and spaces that publish their
          workspaces to everyone.
        </p>
      </header>
      <Tabs
        variant="underline"
        value={selected}
        onValueChange={value => {
          void navigate({ search: value === 'spaces' ? { tab: 'spaces' } : {}, replace: true })
        }}
        tabs={TABS}
        className="px-3 pb-4"
      />
      {selected === 'spaces' ? <SpaceDirectory /> : <BlueprintsPage showHeader={false} />}
    </div>
  )
}

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
  validateSearch: (search: Record<string, unknown>): ExploreSearch =>
    ({ tab: search.tab === 'spaces' ? 'spaces' : undefined }),
})
