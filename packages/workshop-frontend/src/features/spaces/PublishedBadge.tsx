import { Badge } from '@cloudflare/kumo'
import type { CollaboratorRole } from '@gadgets/workshop-shared/api'

/** How the role a workspace is published with is named in the UI. */
export const PUBLIC_ACCESS_LABELS: Record<CollaboratorRole, string> = {
  use: 'Can use',
  build: 'Can build',
}

/**
 * Marks a workspace as published: anyone signed in to the deployment may open it, in `role`
 * (see `GadgetMetadata.publicAccess`).
 */
export const PublishedBadge = ({ role }: { role: CollaboratorRole }) => (
  <Badge variant="outline" className="shrink-0">
    Published · {PUBLIC_ACCESS_LABELS[role]}
  </Badge>
)
