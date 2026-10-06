import { Banner, LinkButton } from '@cloudflare/kumo'
import { ArrowSquareOut, Warning } from '@phosphor-icons/react'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'

type AdminUpdatesPanelProps = {
  status: DeploymentUpdateStatus
}

// The link comes from the service that installed this deployment; anything but a web URL (a
// `javascript:` one, say) is not rendered as a link.
const webUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

const updateAvailability = (status: DeploymentUpdateStatus): string => {
  if (status.updateAvailable) return 'Yes'
  return status.checkedAt === undefined ? 'Not known until a check succeeds' : 'No'
}

/** The admin Updates tab: which release this deployment runs, the newest one, and a way to update. */
export const AdminUpdatesPanel = ({ status }: AdminUpdatesPanelProps) => {
  const updateUrl = webUrl(status.updateUrl)

  return (
    <div className="space-y-6">
      {status.modified && (
        <Banner
          role="alert"
          variant="error"
          icon={<Warning />}
          title="This deployment was changed outside the deploy flow"
          description="Its running code is not what the deploy flow installed, so the deploy flow will refuse to upgrade it until that change is undone."
        />
      )}

      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">Release</h2>
        <p className="text-sm text-kumo-subtle mb-5">
          New releases are installed through the deploy flow, where anyone with access to this
          deployment&rsquo;s Cloudflare account can finish the upgrade.
        </p>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-kumo-subtle">Running release</dt>
          <dd className="font-mono text-kumo-default">{status.currentReleaseId}</dd>
          <dt className="text-kumo-subtle">Newest release</dt>
          <dd className={status.latestReleaseId === undefined ? 'text-kumo-default' : 'font-mono text-kumo-default'}>
            {status.latestReleaseId ?? 'No check has succeeded yet'}
          </dd>
          <dt className="text-kumo-subtle">Last checked</dt>
          <dd className="text-kumo-default">
            {status.checkedAt === undefined ? 'Never' : formatFullTimestamp(status.checkedAt)}
          </dd>
          <dt className="text-kumo-subtle">Update available</dt>
          <dd className="text-kumo-default">{updateAvailability(status)}</dd>
        </dl>

        {updateUrl !== null && (
          <div className="flex justify-end mt-4">
            <LinkButton href={updateUrl} external variant="primary" size="sm" icon={ArrowSquareOut}>
              Update
            </LinkButton>
          </div>
        )}
      </div>
    </div>
  )
}
