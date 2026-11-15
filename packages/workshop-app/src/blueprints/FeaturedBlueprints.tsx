import { useEffect, useState } from 'react'
import type { BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { BlueprintSuggestions } from '@/blocks/BlueprintSuggestions'
import { FormatIcon } from '@/components/FormatIcon'
import { useApi } from '@/rpc/ApiContext'

/** How many Home offers, beside the way to all of them, which fans a few more. */
const SHOWN = 2
const FANNED = 3

export type FeaturedBlueprintsProps = {
  onOpen: (blueprintId: string) => void
  href?: (blueprintId: string) => string
  onBrowse: () => void
  browseHref?: string
}

/**
 * A few of the blueprints the deployment features (`listFeaturedBlueprints`), for Home to offer
 * under its composer: those with a picture first, in the order featured. Nothing at all while they
 * are read, when there are none, or when they cannot be read, as Home is whole without them.
 */
export const FeaturedBlueprints = ({ onOpen, href, onBrowse, browseHref }: FeaturedBlueprintsProps) => {
  const { api, reconnecting } = useApi()
  const [featured, setFeatured] = useState<BlueprintPublicInfo[]>()

  useEffect(() => {
    if (reconnecting) return
    let current = true
    api.listFeaturedBlueprints().then((listed) => { if (current) setFeatured(listed) }, () => {})
    return () => {
      current = false
    }
  }, [api, reconnecting])

  if (!featured?.length) return null
  const ordered = featured.toSorted((a, b) => Number(Boolean(b.screenshotUrl)) - Number(Boolean(a.screenshotUrl)))
  const shown = ordered.slice(0, SHOWN)
  return (
    <BlueprintSuggestions
      blueprints={shown.map(({ id, metadata, screenshotUrl }) => ({
        id,
        title: metadata.title || 'Untitled blueprint',
        picture: screenshotUrl,
        icon: <FormatIcon name={metadata.output?.icon} />,
        href: href?.(id),
      }))}
      // Those not offered first, then those that are: the fan stands for all of them.
      more={[...ordered.slice(SHOWN), ...shown].flatMap(({ screenshotUrl }) => (screenshotUrl ? [screenshotUrl] : [])).slice(0, FANNED)}
      onOpen={onOpen}
      onBrowse={onBrowse}
      browseHref={browseHref}
    />
  )
}
