import { useEffect, useId, useRef, useState } from 'react'
import { Banner, Button, LinkButton, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowSquareOut, Warning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { HoursSetting } from './HoursSetting'

type AdminUpdatesPanelProps = {
  admin: RpcStub<AdminApi>
  /** What the server last reported. */
  status: DeploymentUpdateStatus
  /** Re-read the update status after a change, so that the panel shows what the server holds. */
  onChanged: () => Promise<void>
}

const CARD = 'bg-kumo-elevated border border-kumo-line rounded-xl p-6'
const CHECKS_LABEL = 'Check for updates automatically'
const MINIMUM_AGE_LABEL = 'Minimum release age (hours)'
const SNOOZE_LABEL = 'Hide a closed notice for (hours)'

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

// What a check found, announced since the rows it changes are not a live region.
const checkOutcome = (status: DeploymentUpdateStatus): string =>
  status.updateAvailable && status.latestReleaseId !== undefined
    ? `Update available: release ${status.latestReleaseId}`
    : 'No update available: this deployment runs the newest release'

/** The admin Updates tab: which release this deployment runs, the newest one, and a way to update. */
export const AdminUpdatesPanel = ({ admin, status, onChanged }: AdminUpdatesPanelProps) => {
  const toasts = useKumoToastManager()
  const [savingChecks, setSavingChecks] = useState(false)
  const [checking, setChecking] = useState(false)
  const checksHelp = useId()
  const updateUrl = webUrl(status.updateUrl)
  // The switch and Check now are disabled while their call is in flight, and a browser takes focus
  // from a control that becomes disabled without giving it back. So the control that had focus
  // when the last call began gets it again once no call is in flight, unless focus has gone
  // elsewhere since.
  const busy = savingChecks || checking
  const focusBeforeCall = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (busy) return
    if (document.activeElement === document.body) focusBeforeCall.current?.focus()
    focusBeforeCall.current = null
  }, [busy])
  const rememberFocus = () => {
    focusBeforeCall.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  const reportFailure = (title: string, err: unknown) => {
    console.error(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  // Resolves whether `op` went through and the status was re-read after it. A failed re-read is
  // reported on its own, since the change before it did go through.
  const change = async (failureTitle: string, op: () => Promise<unknown>): Promise<boolean> => {
    try {
      await op()
    } catch (err) {
      reportFailure(failureTitle, err)
      return false
    }
    try {
      await onChanged()
      return true
    } catch (err) {
      reportFailure('Couldn’t reload the update status', err)
      return false
    }
  }

  const changeChecksEnabled = async (enabled: boolean) => {
    rememberFocus()
    setSavingChecks(true)
    try {
      await change(`Couldn’t update “${CHECKS_LABEL}”`, () => admin.setUpdateChecksEnabled(enabled))
    } finally {
      setSavingChecks(false)
    }
  }

  const checkNow = async () => {
    rememberFocus()
    setChecking(true)
    try {
      await change('Couldn’t check for updates', async () => {
        const checked = await admin.checkForUpdates()
        if (checked !== null) toasts.add({ title: checkOutcome(checked), variant: 'success' })
      })
    } finally {
      setChecking(false)
    }
  }

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

      <div className={CARD}>
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

        <div className="flex flex-wrap items-center justify-end gap-2 mt-4">
          <Button variant="secondary" size="sm" loading={checking} disabled={checking} onClick={checkNow}>
            Check now
          </Button>
          {updateUrl !== null && (
            <LinkButton href={updateUrl} external variant="primary" size="sm" icon={ArrowSquareOut}>
              Update
            </LinkButton>
          )}
        </div>
      </div>

      <div className={CARD}>
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">Update notice</h2>
        <p className="text-sm text-kumo-subtle mb-5">
          When a newer release is available, admins see a notice on Home. These settings apply to
          the whole deployment.
        </p>

        <div className="flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3 mb-5">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-kumo-default">{CHECKS_LABEL}</p>
            <p id={checksHelp} className="mt-0.5 text-kumo-subtle">
              When on, the deployment asks for the newest release every few hours and notifies
              admins of an update. When off, it asks only when an admin chooses Check now, and no
              one is notified.
            </p>
          </div>
          <Switch
            aria-label={CHECKS_LABEL}
            aria-describedby={checksHelp}
            checked={status.checksEnabled}
            disabled={savingChecks}
            onCheckedChange={changeChecksEnabled}
          />
        </div>

        <div className="grid items-start gap-6 sm:grid-cols-2">
          <HoursSetting
            label={MINIMUM_AGE_LABEL}
            help={
              'How long a newer release must have been available before admins are notified. It ' +
              'delays the notice only: Update always installs the newest release. 0 notifies as ' +
              'soon as a check finds an update.'
            }
            hours={status.minimumAgeHours}
            onSave={(hours) =>
              change(`Couldn’t update “${MINIMUM_AGE_LABEL}”`, () => admin.setUpdateMinimumAgeHours(hours))}
          />
          <HoursSetting
            label={SNOOZE_LABEL}
            help={
              'How long a closed notice stays hidden in the browser it was closed in. 0 means a ' +
              'closed notice comes back on the next visit to Home.'
            }
            hours={status.noticeSnoozeHours}
            onSave={(hours) =>
              change(`Couldn’t update “${SNOOZE_LABEL}”`, () => admin.setUpdateNoticeSnoozeHours(hours))}
          />
        </div>
      </div>
    </div>
  )
}
