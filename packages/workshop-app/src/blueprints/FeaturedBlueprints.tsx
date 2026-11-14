import { useEffect, useState } from 'react'
import type { BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { BlueprintSuggestions } from '@/blocks/BlueprintSuggestions'
import { FormatIcon } from '@/components/FormatIcon'
import { useApi } from '@/rpc/ApiContext'

/** How many Home suggests: a row under the composer. */
const SHOWN = 3

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
  const shown = featured.toSorted((a, b) => Number(Boolean(b.screenshotUrl)) - Number(Boolean(a.screenshotUrl))).slice(0, SHOWN)
  return (
    <BlueprintSuggestions
      blueprints={shown.map(({ id, metadata, screenshotUrl }) => ({
        id,
        title: metadata.title || 'Untitled blueprint',
        picture: screenshotUrl,
        icon: <FormatIcon name={metadata.output?.icon} />,
        href: href?.(id),
      }))}
      onOpen={onOpen}
      onBrowse={onBrowse}
      browseHref={browseHref}
    />
  )
}
