import { useState } from 'react'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { AdminCapabilityProvider } from '@/settings/admin/AdminContext'
import { AdminUpdateSettings } from '@/settings/admin/AdminUpdateSettings'
import { UpdateNoticeView } from '@/settings/admin/updates/UpdateNoticeView'
import { never, previewAdmin, previewDelay } from './adminPreview'
import { useReport } from './previewState'
import { Section } from './Section'

const CURRENT: DeploymentUpdateStatus = {
  currentReleaseId: '2026.11.03-a1b2c3d',
  latestReleaseId: '2026.11.03-a1b2c3d',
  updateAvailable: false,
  notify: false,
  checksEnabled: true,
  checkIntervalMinutes: 60,
  minimumAgeHours: 24,
  noticeSnoozeHours: 24,
  modified: false,
  modifiedWorkers: [],
  unfinishedWorkers: [],
  updateUrl: 'https://deploy.example.com/upgrade/abc',
  checkedAt: new Date(Date.now() - 40 * 60_000),
}

const AVAILABLE: DeploymentUpdateStatus = {
  ...CURRENT,
  latestReleaseId: '2026.11.15-d4e5f6a',
  updateAvailable: true,
  availableSince: new Date(Date.now() - 3 * 86_400_000),
  notify: true,
}

const TROUBLED: DeploymentUpdateStatus = {
  ...AVAILABLE,
  notify: false,
  modified: true,
  modifiedWorkers: ['router'],
  unfinishedWorkers: ['backend', 'google'],
  checkedAt: undefined,
  latestReleaseId: undefined,
  updateAvailable: false,
}

/** A fake deployment whose update status changes as the part changes it; a check finds `found`. */
const useFakeUpdates = (initial: DeploymentUpdateStatus, found: DeploymentUpdateStatus = initial) => {
  const [admin] = useState(() => {
    let status = initial
    const set = async (changes: Partial<DeploymentUpdateStatus>) => {
      await previewDelay()
      status = { ...status, ...changes }
    }
    return previewAdmin({
      getUpdateStatus: async () => {
        await previewDelay()
        return status
      },
      checkForUpdates: async () => {
        await previewDelay()
        status = { ...found, checkedAt: new Date() }
        return status
      },
      setUpdateChecksEnabled: (checksEnabled) => set({ checksEnabled }),
      setUpdateCheckIntervalMinutes: (checkIntervalMinutes) => set({ checkIntervalMinutes }),
      setUpdateMinimumAgeHours: (minimumAgeHours) => set({ minimumAgeHours }),
      setUpdateNoticeSnoozeHours: (noticeSnoozeHours) => set({ noticeSnoozeHours }),
    })
  })
  return admin
}

const Part = ({ status, found }: { status: DeploymentUpdateStatus; found?: DeploymentUpdateStatus }) => {
  const admin = useFakeUpdates(status, found)
  return (
    <AdminCapabilityProvider admin={admin}>
      <AdminUpdateSettings />
    </AdminCapabilityProvider>
  )
}

/** The admin Updates part over a fake deployment in each of its states, and the notice an admin is shown of an update. */
export const AdminUpdatesPreview = () => {
  const { report, say } = useReport()
  const [dismissed, setDismissed] = useState(false)
  return (
    <>
      <Section title="AdminUpdateSettings: the newest release already (Check now finds one), with an update available, with a way to it and a part changed outside the deploy flow and an update that did not finish; the durations refuse what is not a whole number in range">
        <div className="flex w-full max-w-3xl flex-col gap-24">
          <div className="flex flex-col gap-12"><Part status={CURRENT} found={AVAILABLE} /></div>
          <div className="flex flex-col gap-12"><Part status={AVAILABLE} /></div>
          <div className="flex flex-col gap-12"><Part status={TROUBLED} /></div>
        </div>
      </Section>
      <Section title="AdminUpdateSettings for a deployment the deploy flow did not install, while the status loads, and when it could not be read">
        <div className="flex w-full max-w-3xl flex-col gap-6">
          <AdminCapabilityProvider admin={previewAdmin({ getUpdateStatus: async () => null })}>
            <AdminUpdateSettings />
          </AdminCapabilityProvider>
          <AdminCapabilityProvider admin={previewAdmin({ getUpdateStatus: never })}>
            <AdminUpdateSettings />
          </AdminCapabilityProvider>
          <AdminCapabilityProvider admin={previewAdmin({ getUpdateStatus: async () => { throw new Error('The deployment didn’t answer.') } })}>
            <AdminUpdateSettings />
          </AdminCapabilityProvider>
        </div>
      </Section>
      <Section title="UpdateNoticeView: what UpdateNotice shows an admin of a newer release, until it is closed (closing it here brings it back after a moment)">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          {!dismissed && (
            <UpdateNoticeView
              onOpen={() => say('opened the admin settings’ Updates')}
              onDismiss={() => {
                say('closed the notice')
                setDismissed(true)
                setTimeout(() => setDismissed(false), 1500)
              }}
            />
          )}
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
    </>
  )
}
