import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../../AuthContext'
import { BindingBadge, uniqueBindingBadges } from '../../components/BlueprintCard'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import type { LibraryLayout } from '../../features/library/LibraryViews'
import { logRpcFailure } from '../../rpcErrors'
import { BlueprintRow, BlueprintsEmpty, matchesQuery } from './blueprintRows'

type VendorMap = ReadonlyMap<string, VendorDescription>

/** The blueprints this deployment features, as screenshot tiles or Library rows. */
export const FeaturedBlueprints = ({ layout, query }: { layout: LibraryLayout; query: string }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [state, setState] = useState<{ blueprints: BlueprintPublicInfo[]; vendors: VendorMap } | 'loading' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    Promise.all([authenticatedApi.listFeaturedBlueprints(), authenticatedApi.listGatekeeperVendors()]).then(
      ([blueprints, vendors]) => {
        if (!cancelled) setState({ blueprints, vendors: new Map(vendors.map(v => [v.id.toLowerCase(), v.description])) })
      },
      err => { logRpcFailure('Failed to load featured blueprints:', err); if (!cancelled) setState('failed') })
    return () => { cancelled = true }
  }, [authenticatedApi, attempt])

  if (state === 'loading') return <Loading layout={layout} />
  if (state === 'failed') {
    return <BlueprintsEmpty message="Featured blueprints couldn't be loaded." action={{ label: 'Try again', onClick: () => setAttempt(n => n + 1) }} />
  }
  const shown = state.blueprints.filter(b => matchesQuery(query, b.metadata.title, b.metadata.description))
  if (shown.length === 0) {
    return <BlueprintsEmpty message={query ? 'Nothing matches your search.' : 'No blueprints are featured here yet.'} />
  }
  if (layout === 'list') {
    return (
      <div className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
        {shown.map(blueprint => (
          <BlueprintRow
            key={blueprint.id}
            id={blueprint.id}
            title={blueprint.metadata.title}
            description={blueprint.metadata.description}
            glyph={<FormatGlyph output={blueprint.metadata.output} size="md" weight="regular" />}
          />
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {shown.map(blueprint => <BlueprintTile key={blueprint.id} blueprint={blueprint} vendors={state.vendors} />)}
    </div>
  )
}

// A featured blueprint as a Library tile: its screenshot, or its format's glyph before it has one,
// over its name, what it does, and what it connects to.
const BlueprintTile = ({ blueprint, vendors }: { blueprint: BlueprintPublicInfo; vendors: VendorMap }) => {
  const { title, description, output, bindings } = blueprint.metadata
  const badges = uniqueBindingBadges(bindings).slice(0, 2)
  return (
    <Link
      to="/blueprint/$id"
      params={{ id: blueprint.id }}
      className="group flex flex-col gap-2.5 rounded-[20px] bg-kumo-contrast/[0.03] p-2 outline-none transition-colors hover:bg-kumo-contrast/[0.06] focus-visible:ring-2 focus-visible:ring-kumo-ring"
    >
      <span className="relative block aspect-[16/10] overflow-hidden rounded-[14px] bg-kumo-base ring-1 ring-inset ring-kumo-line">
        {blueprint.screenshotUrl ? (
          <img src={blueprint.screenshotUrl} alt="" loading="lazy" className="size-full object-cover object-top" />
        ) : (
          <span className="flex size-full items-center justify-center bg-kumo-tint">
            <span className="flex size-11 items-center justify-center rounded-[14px] bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
              <FormatGlyph output={output} size="lg" />
            </span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-1.5 pb-1.5">
        <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default">{title || 'Untitled blueprint'}</span>
        <span className="truncate text-[13px] leading-[18px] text-kumo-subtle">{description || '\u00a0'}</span>
        {badges.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {badges.map(badge => (
              <BindingBadge key={badge.vendorKey ?? badge.type} badge={badge} vendorDescriptions={vendors as Map<string, VendorDescription>} />
            ))}
          </span>
        )}
      </span>
    </Link>
  )
}

const Loading = ({ layout }: { layout: LibraryLayout }) => layout === 'list' ? (
  <div className="flex flex-col gap-1 rounded-[20px] bg-kumo-contrast/[0.03] p-2" aria-busy="true">
    {[1, 2, 3, 4].map(i => <div key={i} className="h-[49px] animate-pulse rounded-[14px] bg-kumo-tint" />)}
  </div>
) : (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-busy="true">
    {[1, 2, 3, 4, 5, 6].map(i => (
      <div key={i} className="flex flex-col gap-2.5 rounded-[20px] bg-kumo-contrast/[0.03] p-2">
        <div className="aspect-[16/10] animate-pulse rounded-[14px] bg-kumo-tint" />
        <div className="flex flex-col gap-1.5 px-1.5 pb-2">
          <div className="h-3 w-1/2 animate-pulse rounded-full bg-kumo-tint" />
          <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-kumo-tint" />
        </div>
      </div>
    ))}
  </div>
)
