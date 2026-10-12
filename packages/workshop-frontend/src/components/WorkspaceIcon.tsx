import { useState } from 'react'
import { workspaceLogoUrl, type GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

const SIZES = {
  sm: 'h-6 w-6 rounded-md text-[10px]',
  md: 'h-9 w-9 rounded-lg text-[12px]',
}

function initials(title: string | undefined): string {
  const t = (title || 'Untitled').trim()
  if (!t) return 'UG'
  const parts = t.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || t.slice(0, 2).toUpperCase()
}

/**
 * A workspace's logo, drawn by its chat 0 model, or its initials until it has one. Decorative:
 * every caller names the workspace beside it.
 */
export const WorkspaceIcon = ({ gadget, size }: {
  gadget: Pick<GadgetMetadataWithTimestamps, 'id' | 'title' | 'logo'>
  size: keyof typeof SIZES
}) => {
  const url = workspaceLogoUrl(gadget)
  const [failedUrl, setFailedUrl] = useState<string>()

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-kumo-fill font-medium text-kumo-subtle ${SIZES[size]}`}
      aria-hidden="true"
    >
      {url !== undefined && url !== failedUrl ? (
        // Only ever an <img>: the SVG is model-written, and an image runs no script and loads nothing.
        <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full"
          onError={() => setFailedUrl(url)} />
      ) : initials(gadget.title)}
    </div>
  )
}
