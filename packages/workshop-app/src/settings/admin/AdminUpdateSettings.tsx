import { useState, type ReactNode } from 'react'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { MAX_UPDATE_CHECK_INTERVAL_MINUTES, MAX_UPDATE_HOURS, type DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { Banner, Button, type SaveOutcome, SettingField, SettingRow, SettingsGroup, Switch, webUrl } from '@gadgets/ui'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { messageOf, useAttempt } from '../useAttempt'
import { useAdmin, type AdminCapability } from './AdminContext'
import { probeRouterTag } from './updates/probeRouterTag'
import { checkOutcome, updateAvailability, wholeNumberIn, workerList } from './updates/updateStatus'
import { useUpdateStatus } from './updates/useUpdateStatus'

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** What a row says it is set to, where it is only said: as wide as it is, and selectable. */
const Value = ({ mono = false, children }: { mono?: boolean; children: ReactNode }) => (
  <span className={mono ? 'max-w-full truncate font-mono text-sm text-kumo-default select-all' : 'text-kumo-default'}>{children}</span>
)

type UpdateSettingsProps = {
  admin: AdminCapability
  update: DeploymentUpdateStatus
  /** Shows what a check answered with, or reads the status again. Rejects where it could not be read. */
  onChanged: (update?: DeploymentUpdateStatus | null) => Promise<void>
}

/** The release, a check for a newer one and the way to it, and how admins are told of one. */
const UpdateSettings = ({ admin, update, onChanged }: UpdateSettingsProps) => {
  const notice = useConnectionNotice()
  const { problem, attempt } = useAttempt()
  const [checking, setChecking] = useState(false)
  const [savingChecks, setSavingChecks] = useState(false)
  // What the last check found, said once it is done (and announced), as the rows it changes are not.
  const [outcome, setOutcome] = useState<string>()
  const updateUrl = webUrl(update.updateUrl)

  const checkNow = async () => {
    setOutcome(undefined)
    setChecking(true)
    await attempt('check for updates', async () => {
      await probeRouterTag()
      const checked = await admin.checkForUpdates()
      if (checked) setOutcome(checkOutcome(checked))
      await onChanged(checked)
    })
    setChecking(false)
  }

  // A number of minutes or hours, from `min` to `max`, kept as it is typed; what is not one is said under it.
  const duration = (min: number, max: number, unit: string, save: (value: number) => Promise<unknown>) => async (typed: string): Promise<SaveOutcome> => {
    const parsed = wholeNumberIn(typed, min, max, unit)
    if ('problem' in parsed) return { saved: false, problem: parsed.problem }
    if (notice?.blocked()) return { saved: false }
    try {
      await save(parsed.value)
      await onChanged()
      return { saved: true }
    } catch (error) {
      return { saved: false, problem: messageOf(error) }
    }
  }

  return (
    <>
      {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
      {update.modified && (
        <Banner
          title="This deployment was changed outside the deploy flow"
          description={`Not running what the deploy flow installed: ${workerList(update.modifiedWorkers)}. The deploy flow will refuse to update it until that change is undone.`}
        />
      )}
      <SettingsGroup title="Release">
        <SettingRow title="Running release">
          <Value mono>{update.currentReleaseId}</Value>
        </SettingRow>
        <SettingRow title="Newest release">
          {update.latestReleaseId === undefined ? <Value>No check has succeeded yet</Value> : <Value mono>{update.latestReleaseId}</Value>}
        </SettingRow>
        <SettingRow title="Last checked">
          <Value>{update.checkedAt === undefined ? 'Never' : WHEN.format(update.checkedAt)}</Value>
        </SettingRow>
        <SettingRow title="Update available">
          <Value>{updateAvailability(update)}</Value>
        </SettingRow>
        <SettingRow
          title="Update"
          description={update.unfinishedWorkers.length > 0
            ? `An update did not finish: ${workerList(update.unfinishedWorkers)} still ${update.unfinishedWorkers.length === 1 ? 'runs' : 'run'} another release. ${update.modifiedWorkers.length > 0 ? 'The deploy flow can finish it once what was changed outside it is restored.' : 'The deploy flow can finish it.'}`
            : outcome ? <span role="status">{outcome}</span> : 'New releases are installed through the deploy flow, where anyone with access to this deployment’s Cloudflare account can finish the update.'}
        >
          <Button disabled={checking} onClick={() => void checkNow()}>{checking ? 'Checking…' : 'Check now'}</Button>
          {updateUrl && <Button variant="primary" icon={ArrowSquareOutIcon} onClick={() => window.open(updateUrl, '_blank', 'noopener')}>Update</Button>}
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Update notice">
        <SettingRow
          title="Check for updates automatically"
          description="Asks for the newest release while admins use the deployment, at most as often as set below, and tells them of an update. When off, it asks only when an admin chooses Check now, and no one is told."
        >
          <Switch
            aria-label="Check for updates automatically"
            checked={update.checksEnabled}
            busy={savingChecks}
            onCheckedChange={(enabled) => void (async () => {
              setSavingChecks(true)
              await attempt('change whether updates are checked for', async () => {
                await admin.setUpdateChecksEnabled(enabled)
                await onChanged()
              })
              setSavingChecks(false)
            })()}
          />
        </SettingRow>
        <SettingField
          title="Check every"
          description="How many minutes the last check that succeeded is relied on. It asks again when an admin opens Home or these settings, never on a schedule."
          value={String(update.checkIntervalMinutes)}
          placeholder="Minutes"
          onSave={duration(1, MAX_UPDATE_CHECK_INTERVAL_MINUTES, 'minutes', (minutes) => admin.setUpdateCheckIntervalMinutes(minutes))}
        />
        <SettingField
          title="Minimum release age"
          description="How many hours a newer release must have been out before admins are told. It only holds back the notice: Update always installs the newest release. 0 tells them at once."
          value={String(update.minimumAgeHours)}
          placeholder="Hours"
          onSave={duration(0, MAX_UPDATE_HOURS, 'hours', (hours) => admin.setUpdateMinimumAgeHours(hours))}
        />
        <SettingField
          title="Hide a closed notice for"
          description="How many hours a notice an admin closed stays hidden in the browser it was closed in. 0 brings it back on the next visit."
          value={String(update.noticeSnoozeHours)}
          placeholder="Hours"
          onSave={duration(0, MAX_UPDATE_HOURS, 'hours', (hours) => admin.setUpdateNoticeSnoozeHours(hours))}
        />
      </SettingsGroup>
    </>
  )
}

/**
 * Which release the deployment runs, whether there is a newer one, and how its admins are told:
 * main's Admin page's Updates tab. A deployment the deploy flow did not install is not updated
 * from here, which is all that is said of it.
 */
export const AdminUpdateSettings = () => {
  const admin = useAdmin()
  const { state, reload } = useUpdateStatus(admin)

  if (state.status === 'loading' || !admin) return <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading the update status…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex flex-wrap items-center gap-3 px-5 text-base text-kumo-subtle">
        Couldn’t read the update status: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }
  if (state.status === 'absent') {
    return (
      <SettingsGroup title="Release">
        <SettingRow
          title="Not updated from here"
          description="This deployment wasn’t installed by the deploy flow, so new releases aren’t offered here. Update it the way it was installed."
        />
      </SettingsGroup>
    )
  }
  return <UpdateSettings admin={admin} update={state.update} onChanged={reload} />
}
