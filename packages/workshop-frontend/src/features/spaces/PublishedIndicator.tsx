import { Tooltip } from '@cloudflare/kumo'
import { Globe, GlobeX } from '@phosphor-icons/react'
import type { CollaboratorRole, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { titleOf } from './tree/parentOptions'

/** How the role a workspace is published with is named in the UI. */
export const PUBLIC_ACCESS_LABELS: Record<CollaboratorRole, string> = {
  use: 'Can use',
  build: 'Can build',
}

/**
 * That an unpublished workspace above a published one in its space's tree keeps the publication
 * from taking effect (`SpaceWorkspaceInfo.hiddenBy`), with that workspace's title when known.
 */
export type PublicationHeldBack = { blockerTitle: string | undefined }

/**
 * Whether an unpublished workspace above `entry` holds its publication back, naming that workspace
 * as `titleOf` does when `listing`, the listing of the space that lists `entry`, has it.
 */
export const publicationHeldBack = (
  listing: readonly SpaceWorkspaceInfo[],
  entry: Pick<SpaceWorkspaceInfo, 'hiddenBy'>,
): PublicationHeldBack | undefined => {
  if (entry.hiddenBy === undefined) return undefined
  const blocker = listing.find(other => other.id === entry.hiddenBy)
  return { blockerTitle: blocker && titleOf(blocker) }
}

// What the indicator says of a workspace published with `access`, held back as `heldBack` says.
const publishedIndicatorText = (access: CollaboratorRole, heldBack: PublicationHeldBack | undefined) => {
  if (heldBack === undefined) {
    return `Published to everyone signed in · ${PUBLIC_ACCESS_LABELS[access].toLowerCase()}`
  }
  const blocker = heldBack.blockerTitle === undefined ? 'a workspace above it' : `'${heldBack.blockerTitle}'`
  return `Published, but not visible until ${blocker} is published`
}

type PublishedIndicatorProps = {
  /** The role the workspace is published with (`GadgetMetadata.publicAccess`). */
  access: CollaboratorRole
  /** Set while an unpublished workspace above this one holds the publication back. */
  heldBack?: PublicationHeldBack
}

/**
 * Marks a workspace as published to everyone signed in to the deployment, as a small globe that
 * a row has room for. The full text is its tooltip and its accessible name, so it is read with
 * the row it sits in. It is not focusable, since the rows it sits in are links and buttons,
 * which nothing interactive may be nested in; the workspace's Share dialog states its
 * publication as text.
 */
export const PublishedIndicator = ({ access, heldBack }: PublishedIndicatorProps) => {
  const text = publishedIndicatorText(access, heldBack)
  const Icon = heldBack === undefined ? Globe : GlobeX
  return (
    <Tooltip
      content={text}
      render={<span role="img" aria-label={text} className="inline-flex shrink-0 items-center" />}
    >
      <Icon
        aria-hidden="true"
        size={14}
        className={heldBack === undefined ? 'text-kumo-subtle' : 'text-kumo-inactive'}
      />
    </Tooltip>
  )
}
