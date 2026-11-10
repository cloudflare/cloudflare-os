import { Banner } from '@cloudflare/kumo'
import { ShieldWarningIcon } from '@phosphor-icons/react'
import type { WorkspaceMetadata } from '@gadgets/workshop-shared/api'

type Props = {
  metadata: WorkspaceMetadata
}

/**
 * Why sharing is restricted, and what recipients will see, once the workspace has read sensitive
 * data. Nothing is shown otherwise.
 */
export const RestrictedDataNotice = ({ metadata }: Props) => {
  if (metadata.ownerInvitesOnly === true) {
    return (
      <Banner
        variant="alert"
        size="sm"
        className="mb-3 items-start rounded-xl [&>span:first-child]:pt-px"
        icon={<ShieldWarningIcon weight="fill" />}
        title="Only the owner can add people"
        description="This workspace has read data from a connection that requires each person to be added by the owner. People added are asked to verify their own access to its connections and some may be unable to open it. Anything it has already saved is visible to everyone who can."
      />
    )
  }
  if (metadata.containsRestrictedData === true) {
    return (
      <Banner
        variant="alert"
        size="sm"
        className="mb-3 items-start rounded-xl [&>span:first-child]:pt-px"
        icon={<ShieldWarningIcon weight="fill" />}
        title="This workspace has read sensitive data"
        description="People you add are asked to verify their own access to its connections and some may be unable to open it. Anything it has already saved is visible to everyone who can."
      />
    )
  }
  return null
}
