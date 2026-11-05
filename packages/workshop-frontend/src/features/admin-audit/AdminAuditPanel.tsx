import { useEffect, useId, useState } from 'react'
import { Button, Loader, Table, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowsClockwise } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import { MAX_ADMIN_AUDIT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type {
  AdminApi,
  AdminAuditRecord,
  AdminAuditStats,
  AdminSettingChange,
  AdminSettingRecord,
  AdminVia,
} from '@gadgets/workshop-shared/api'
import { DurationSetting } from '../../components/DurationSetting'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type { AuditSettings } from './auditSettings'
import { AuditValue } from './AuditValue'

type AdminAuditPanelProps = {
  admin: RpcStub<AdminApi>
  /** What the server last reported. */
  settings: AuditSettings
  /**
   * Re-reads the settings after a change, so that the panel shows what the server holds. Rejects
   * when the re-read failed.
   */
  onSettingsChanged: () => Promise<void>
}

const CARD = 'bg-kumo-elevated border border-kumo-line rounded-xl p-6'
const RETENTION_LABEL = 'Keep audit records for (days)'
const STATS_DAYS = 7
const RECENT_LIMIT = 20

const VIA_NAMES: Record<AdminVia, string> = { api: 'API', cli: 'CLI' }

// The settings stored as lists of entries with ids, whose keyless change is a change of order.
const ORDERED_SETTING_NAMES = new Map([
  ['formats', 'formats'],
  ['addedModels', 'added models'],
])

const NUMBER = new Intl.NumberFormat('en')

// A UTC day (YYYY-MM-DD), named as a date. The stats count UTC days, so it is read in UTC.
const DAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayName = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? day : DAY.format(date)
}

type Activity =
  | { state: 'loading' }
  | { state: 'failed' }
  | {
    state: 'loaded'
    stats: AdminAuditStats
    records: AdminAuditRecord[]
    refreshing: boolean
  }

const changeName = (change: AdminSettingChange) => {
  if (change.key !== undefined) return `${change.setting} · ${change.key}`
  const ordered = ORDERED_SETTING_NAMES.get(change.setting)
  return ordered === undefined ? change.setting : `Order of ${ordered}`
}

// Where an excerpt starts and how long the values it was cut from are, in words.
const excerptLabel = ({ offset, beforeLength, afterLength }: NonNullable<AdminSettingChange['excerpt']>) => {
  const length = (characters: number | undefined) => characters === undefined ? '—' : NUMBER.format(characters)
  return `Excerpt from character ${NUMBER.format(offset + 1)} · ` +
    `${length(beforeLength)} → ${length(afterLength)} characters`
}

const SettingChanges = ({ record }: { record: AdminSettingRecord }) => (
  <ul className="mt-2 space-y-2">
    {record.changes.map((change, index) => (
      <li key={index} className="text-sm">
        <p className="font-mono text-xs text-kumo-subtle break-all">{changeName(change)}</p>
        <div className="mt-0.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2">
          <AuditValue value={change.before} label={`${changeName(change)}, before`} />
          {/* The arrow glyph reads as "right arrow", and a plain span's aria-label is ignored. */}
          <span className="text-kumo-subtle">
            <span aria-hidden="true">→</span>
            <span className="sr-only"> changed to </span>
          </span>
          <AuditValue value={change.after} label={`${changeName(change)}, after`} />
        </div>
        {change.excerpt && (
          <p className="mt-0.5 text-xs text-kumo-subtle">{excerptLabel(change.excerpt)}</p>
        )}
      </li>
    ))}
  </ul>
)

const RecentRecord = ({ record }: { record: AdminAuditRecord }) => (
  <li className="py-3 first:pt-0 last:pb-0">
    <p className="text-xs text-kumo-subtle">
      {formatFullTimestamp(record.at)} · <span className="text-kumo-default">{record.admin}</span>
      {' '}via {VIA_NAMES[record.via]}
    </p>
    <p className="mt-1 font-mono text-sm text-kumo-default">{record.method}</p>
    <SettingChanges record={record} />
  </li>
)

const EmptyNote = ({ children }: { children: string }) => (
  <p className="text-sm text-kumo-subtle">{children}</p>
)

const ActivityCards = ({ stats, records }: { stats: AdminAuditStats; records: AdminAuditRecord[] }) => (
  <>
    <div className="grid items-start gap-6 md:grid-cols-2">
      <div className={CARD}>
        <h3 className="text-lg font-semibold text-kumo-strong mb-1">Settings changes, last {stats.days} days</h3>
        <p className="text-sm text-kumo-subtle mb-4">
          <span className="text-2xl font-semibold text-kumo-default tabular-nums">{NUMBER.format(stats.totalEvents)}</span>
          {' '}{stats.totalEvents === 1 ? 'change' : 'changes'}, by UTC day
        </p>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Day</Table.Head>
              <Table.Head className="text-right">Changes</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {stats.byDay.map(({ day, count }) => (
              <Table.Row key={day}>
                <Table.Cell><time dateTime={day}>{dayName(day)}</time></Table.Cell>
                <Table.Cell className="text-right tabular-nums">{NUMBER.format(count)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>

      <div className={CARD}>
        <h3 className="text-lg font-semibold text-kumo-strong mb-1">Most active admins</h3>
        <p className="text-sm text-kumo-subtle mb-4">By settings changes in the last {stats.days} days</p>
        {stats.topAdmins.length === 0
          ? <EmptyNote>No admin activity in this window.</EmptyNote>
          : (
            <ul className="space-y-2 text-sm">
              {stats.topAdmins.map(({ admin, count }) => (
                <li key={admin} className="flex items-baseline justify-between gap-4">
                  <span className="min-w-0 break-all text-kumo-default">{admin}</span>
                  <span className="tabular-nums text-kumo-subtle">{NUMBER.format(count)}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>

    <div className={CARD}>
      <h3 className="text-lg font-semibold text-kumo-strong mb-4">Recent activity</h3>
      {records.length === 0
        ? <EmptyNote>No admin activity is recorded yet.</EmptyNote>
        : (
          <ul className="divide-y divide-kumo-line">
            {records.map((record, index) => (
              <RecentRecord key={`${record.at.getTime()}:${index}`} record={record} />
            ))}
          </ul>
        )}
    </div>
  </>
)

/**
 * The admin Audit tab: what the deployment-wide admin audit log holds for the last week, its most
 * recent records, and the log's retention.
 */
export const AdminAuditPanel = ({ admin, settings, onSettingsChanged }: AdminAuditPanelProps) => {
  const toasts = useKumoToastManager()
  const [activity, setActivity] = useState<Activity>({ state: 'loading' })
  // Each load is one value of this; a new one supersedes those before it.
  const [loads, setLoads] = useState(0)
  const activityHeading = useId()
  const retention = settings.adminAuditRetentionDays

  useEffect(() => {
    let current = true
    // Both or neither: a backend older than the audit log rejects either as an unknown method.
    Promise.all([
      admin.getAdminAuditStats({ days: STATS_DAYS }),
      admin.listAdminAudit({ limit: RECENT_LIMIT }),
    ]).then(
      ([stats, page]) => {
        if (current) setActivity({ state: 'loaded', stats, records: page.records, refreshing: false })
      },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the admin audit log:', err)
        setActivity({ state: 'failed' })
      },
    )
    return () => { current = false }
  }, [admin, loads])

  // Loads the log again, keeping what is shown until the new load answers.
  const reload = () => {
    setActivity((shown) => shown.state === 'loaded' ? { ...shown, refreshing: true } : { state: 'loading' })
    setLoads((n) => n + 1)
  }

  const reportFailure = (title: string, err: unknown) => {
    logRpcFailure(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  // Resolves whether `op` went through and the settings were re-read after it. Once it went
  // through, the log is loaded again so that the change's own record shows.
  const change = async (failureTitle: string, op: () => Promise<unknown>): Promise<boolean> => {
    try {
      await op()
    } catch (err) {
      reportFailure(failureTitle, err)
      return false
    }
    reload()
    try {
      await onSettingsChanged()
      return true
    } catch (err) {
      reportFailure('Couldn’t reload the admin settings', err)
      return false
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-6" aria-labelledby={activityHeading}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 id={activityHeading} className="text-lg font-semibold text-kumo-strong">Admin activity</h2>
            <p className="text-sm text-kumo-subtle mt-0.5">
              Every change an admin makes to the deployment&rsquo;s settings, kept
              for {NUMBER.format(retention.effective)} days.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={ArrowsClockwise}
            loading={activity.state === 'loaded' && activity.refreshing}
            disabled={activity.state === 'loading' || (activity.state === 'loaded' && activity.refreshing)}
            onClick={reload}
          >
            Refresh
          </Button>
        </div>

        {activity.state === 'loading' && (
          <div className="flex justify-center py-16">
            <Loader size="lg" />
          </div>
        )}
        {activity.state === 'failed' && (
          <div className={`${CARD} text-center`}>
            <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the admin audit log.</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>Retry</Button>
          </div>
        )}
        {activity.state === 'loaded' && (
          <ActivityCards stats={activity.stats} records={activity.records} />
        )}
      </section>

      <div className={CARD}>
        <h2 className="text-lg font-semibold text-kumo-strong mb-4">Audit retention</h2>
        {retention.chosen < retention.min && (
          <p className="text-sm text-kumo-subtle mb-4">
            The retention set here is {NUMBER.format(retention.chosen)} days, so this
            deployment&rsquo;s minimum of {NUMBER.format(retention.min)} days is what holds it up. If
            a deploy lowers or removes ADMIN_AUDIT_RETENTION_MIN_DAYS, as a deploy tool that writes
            the backend&rsquo;s variables without it does, {NUMBER.format(retention.chosen)} days
            applies again. To keep a retention either way, type the number of days and save it, even
            the minimum.
          </p>
        )}
        <div className="max-w-md">
          <DurationSetting
            label={RETENTION_LABEL}
            help={
              'How long the admin audit log keeps a record. This deployment keeps at least ' +
              `${NUMBER.format(retention.min)} days, which its ADMIN_AUDIT_RETENTION_MIN_DAYS variable sets.`
            }
            unit="days"
            min={retention.min}
            max={MAX_ADMIN_AUDIT_RETENTION_DAYS}
            value={retention.effective}
            onSave={(days) =>
              change(`Couldn’t update “${RETENTION_LABEL}”`, () => admin.setAdminAuditRetentionDays(days))}
          />
        </div>
      </div>
    </div>
  )
}
