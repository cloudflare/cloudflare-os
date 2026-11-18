import { Badge, type BadgeVariant } from '@cloudflare/kumo'
import type { AdminAccessExposure } from '@gadgets/workshop-shared/api'

// What the Audit tab calls each thing a call's answer can have exposed, how it is colored, and what
// its tooltip says.
const EXPOSURES: Record<AdminAccessExposure, { name: string; variant: BadgeVariant; title: string }> = {
  content: { name: 'Content', variant: 'warning', title: 'The call’s answer held content' },
  metadata: { name: 'Metadata', variant: 'neutral', title: 'The call’s answer held no content' },
}

/**
 * What a call into a workspace exposed, as a badge: only a content read's is colored, so content
 * reads stand out. The log returns each record as it is stored, so `exposed` can be absent or a
 * value the API does not name, and then there is no badge: nothing is said of a call that the
 * record does not say.
 */
export const ExposureBadge = ({ exposed }: { exposed: string | undefined }) => {
  if (exposed === undefined || !Object.hasOwn(EXPOSURES, exposed)) return null
  const { name, variant, title } = EXPOSURES[exposed as AdminAccessExposure]
  return <span className="inline-flex" title={title}><Badge variant={variant}>{name}</Badge></span>
}
