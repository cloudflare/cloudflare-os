import { useEffect, useState } from 'react'
import { RefreshCwIcon } from '@/components/icons'
import { ADMIN_WORKSPACE_ACCESS_LEVELS, MAX_ADMIN_AUDIT_RETENTION_DAYS, type AdminAuditStats, type AdminWorkspaceAccess } from '@gadgets/workshop-shared/api'
import { Button, type SaveOutcome, Select, SettingField, SettingRow, SettingsGroup } from '@gadgets/ui'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { messageOf, useAttempt } from '../useAttempt'
import type { AdminCapability } from './AdminContext'
import { AdminSettingsStatus } from './AdminSettingsStatus'
import type { AuditFilter } from './audit/auditFilter'
import { AuditLog } from './audit/AuditLog'
import { auditSettingsOf, type AuditSettings } from './audit/auditSettings'
import { AuditStats } from './audit/AuditStats'
import { ACCESS_LEVEL_NAMES, accessHelp } from './audit/auditText'
import { useAdminSettings } from './useAdminSettings'

// The days the statistics are of.
const STATS_DAYS = 7

const NUMBER = new Intl.NumberFormat('en')

// The answer to one load of the statistics, for the load it answered.
type StatsAnswer = { loads: number } & ({ stats: AdminAuditStats } | { failed: string })

const rank = (level: AdminWorkspaceAccess) => ADMIN_WORKSPACE_ACCESS_LEVELS.indexOf(level)

type AuditPartsProps = {
  admin: AdminCapability
  settings: AuditSettings
  /** Reads the settings again after a change, so that what the server holds is shown. */
  onSettingsChanged: () => Promise<void>
}

const AuditParts = ({ admin, settings, onSettingsChanged }: AuditPartsProps) => {
  const notice = useConnectionNotice()
  const { problem, attempt } = useAttempt()
  // Each load is one of these; a new one replaces those before it (Refresh).
  const [loads, setLoads] = useState(0)
  // Each change to the settings is one of these, which sends the log back to its newest page.
  const [changes, setChanges] = useState(0)
  const [statsAnswer, setStatsAnswer] = useState<StatsAnswer>()
  const [filter, setFilter] = useState<AuditFilter>({})
  const { adminWorkspaceAccess: access, adminAuditRetentionDays: retention } = settings

  useEffect(() => {
    let current = true
    admin.getAdminAuditStats({ days: STATS_DAYS }).then(
      (stats) => {
        if (current) setStatsAnswer({ loads, stats })
      },
      (error) => {
        if (current) setStatsAnswer({ loads, failed: messageOf(error) })
      },
    )
    return () => {
      current = false
    }
  }, [admin, loads])

  // What is shown stays until the load that replaces it answers.
  const stats = statsAnswer && 'stats' in statsAnswer ? statsAnswer.stats : undefined
  const refreshing = statsAnswer?.loads !== loads
  const statsFailed = statsAnswer && 'failed' in statsAnswer && !refreshing ? statsAnswer.failed : undefined
  const reload = () => setLoads((count) => count + 1)

  // Once a change is made, the log is loaded again, so that the change's own record shows, and the
  // settings are read again.
  const change = async (call: () => Promise<unknown>) => {
    await call()
    reload()
    setChanges((count) => count + 1)
    await onSettingsChanged()
  }

  const setAccess = (level: AdminWorkspaceAccess) => {
    // Against the level chosen, not the one shown: setting the one shown while the maximum holds a
    // higher choice down makes it the admins' own, which a later rise of the maximum cannot raise.
    if (level === access.chosen) return
    void attempt(`set inspection access to ${ACCESS_LEVEL_NAMES[level]}`, () => change(() => admin.setAdminWorkspaceAccess(level)))
  }

  const setRetention = async (typed: string): Promise<SaveOutcome> => {
    if (notice?.blocked()) return { saved: false }
    const days = Number(typed.replace(/[\s,]/g, ''))
    if (!Number.isInteger(days) || days < retention.min || days > MAX_ADMIN_AUDIT_RETENTION_DAYS) {
      return { saved: false, problem: `Enter a whole number of days from ${NUMBER.format(retention.min)} to ${NUMBER.format(MAX_ADMIN_AUDIT_RETENTION_DAYS)}.` }
    }
    try {
      await change(() => admin.setAdminAuditRetentionDays(days))
      return { saved: true }
    } catch (error) {
      return { saved: false, problem: messageOf(error) }
    }
  }

  return (
    <>
      {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
      <SettingsGroup
        title="Admin activity"
        description={`Every change an admin makes to the deployment’s settings, and every admin call into a workspace or a user’s account, kept for ${NUMBER.format(retention.effective)} days.`}
        action={<Button icon={RefreshCwIcon} disabled={refreshing} onClick={reload}>Refresh</Button>}
        plain
      >
        {stats === undefined && statsFailed === undefined && <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading what admins did this week…</p>}
        {statsFailed !== undefined && (
          <p role="alert" className="flex flex-wrap items-center gap-3 px-5 text-base text-kumo-subtle">
            Couldn’t load what admins did this week: {statsFailed}
            <Button variant="ghost" onClick={reload}>Try again</Button>
          </p>
        )}
        {stats !== undefined && statsFailed === undefined && <AuditStats stats={stats} onFilterByAdmin={(name) => setFilter((current) => ({ ...current, admin: name }))} />}
      </SettingsGroup>
      <SettingsGroup title="Activity log" plain>
        <AuditLog
          admin={admin}
          filter={filter}
          onFilterChange={setFilter}
          admins={stats?.topAdmins.map(({ admin: name }) => name) ?? []}
          reloads={loads}
          restarts={changes}
        />
      </SettingsGroup>
      <SettingsGroup title="Inspection access">
        <SettingRow
          title="Access level"
          description={accessHelp(access).map((text) => <span key={text} className="block not-first:mt-1">{text}</span>)}
        >
          <Select
            aria-label="Inspection access"
            value={access.effective}
            // A level above the deployment's maximum cannot be set from here.
            options={ADMIN_WORKSPACE_ACCESS_LEVELS.filter((level) => rank(level) <= rank(access.max)).map((level) => ({ id: level, label: ACCESS_LEVEL_NAMES[level] }))}
            onValueChange={setAccess}
          />
          {access.chosen !== access.effective && (
            <Button onClick={() => void attempt(`set inspection access to ${ACCESS_LEVEL_NAMES[access.effective]}`, () => change(() => admin.setAdminWorkspaceAccess(access.effective)))}>
              Set here
            </Button>
          )}
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Audit retention">
        <SettingField
          title="Keep records for"
          description={retention.chosen < retention.min
            ? `In days. The retention set here is ${NUMBER.format(retention.chosen)} days, so this deployment’s minimum of ${NUMBER.format(retention.min)} days (ADMIN_AUDIT_RETENTION_MIN_DAYS) is what holds it up. A deploy that lowers or removes that minimum brings ${NUMBER.format(retention.chosen)} days back. To keep a retention either way, enter it here, even the minimum.`
            : `In days. This deployment keeps at least ${NUMBER.format(retention.min)}, which its ADMIN_AUDIT_RETENTION_MIN_DAYS sets, and at most ${NUMBER.format(MAX_ADMIN_AUDIT_RETENTION_DAYS)}.`}
          value={String(retention.effective)}
          onSave={setRetention}
        />
      </SettingsGroup>
    </>
  )
}

/**
 * What the deployment's admins have done, and may do: what the audit log holds for the last week,
 * the log itself, narrowed and a page at a time, how far an admin may inspect a workspace or a
 * user's account, and how long the log keeps a record. Main's Audit tab. A backend older than the
 * audit log has none of it, which is said in its place.
 */
export const AdminAuditSettings = () => {
  const { admin, state, reload } = useAdminSettings()
  return (
    <AdminSettingsStatus state={state}>
      {(view) => {
        const settings = auditSettingsOf(view)
        if (!settings) return <p className="px-5 text-base text-kumo-subtle">This deployment’s backend has no admin audit log yet. It comes with an update of the backend.</p>
        // Between connections, until the new one's capability is there.
        if (!admin) return <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading…</p>
        return <AuditParts admin={admin} settings={settings} onSettingsChanged={reload} />
      }}
    </AdminSettingsStatus>
  )
}
