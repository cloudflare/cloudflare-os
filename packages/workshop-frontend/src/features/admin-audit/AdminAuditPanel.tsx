import { useEffect, useId, useState } from 'react'
import { Button, Loader, Table, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowsClockwise } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import { MAX_ADMIN_AUDIT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type { AdminApi, AdminAuditStats } from '@gadgets/workshop-shared/api'
import { DurationSetting } from '../../components/DurationSetting'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import type { AuditFilter } from './auditFilter'
import { AuditLog } from './AuditLog'
import type { AuditSettings } from './auditSettings'

type AdminAuditPanelProps = {
  admin: RpcStub<AdminApi>
  /** What the server last reported. */
  settings: AuditSettings
  /**
   * Re-reads the settings after a change, so that the panel shows what the server holds. Rejects
   * when the re-read failed.
   */
  onSettingsChanged: () => Promise<void>
  /** The log's filters, which the admin page keeps in its URL. */
  filter: AuditFilter
  onFilterChange: (filter: AuditFilter) => void
}

const CARD = 'bg-kumo-elevated border border-kumo-line rounded-xl p-6'
const RETENTION_LABEL = 'Keep audit records for (days)'
const STATS_DAYS = 7

const NUMBER = new Intl.NumberFormat('en')

// A UTC day (YYYY-MM-DD), named as a date. The stats count UTC days, so it is read in UTC.
const DAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayName = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? day : DAY.format(date)
}

// The answer to one load of the statistics, for the value of `loads` it answered.
type StatsAnswer = { loads: number } & ({ stats: AdminAuditStats } | { failed: true })

const StatsCards = ({ stats, onAdminSelect }: {
  stats: AdminAuditStats
  onAdminSelect: (admin: string) => void
}) => (
  <div className="grid items-start gap-6 md:grid-cols-2">
    <div className={CARD}>
      <h3 className="text-lg font-semibold text-kumo-strong mb-1">Admin actions, last {stats.days} days</h3>
      <p className="text-sm text-kumo-subtle mb-4">
        <span className="text-2xl font-semibold text-kumo-default tabular-nums">{NUMBER.format(stats.totalEvents)}</span>
        {' '}{stats.totalEvents === 1 ? 'action' : 'actions'}, by UTC day
      </p>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Day</Table.Head>
            <Table.Head className="text-right">Actions</Table.Head>
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
      <p className="text-sm text-kumo-subtle mb-4">
        By actions in the last {stats.days} days. Choose an admin to see only their activity.
      </p>
      {stats.topAdmins.length === 0
        ? <p className="text-sm text-kumo-subtle">No admin activity in this window.</p>
        : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Admin</Table.Head>
                <Table.Head className="text-right">Actions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {stats.topAdmins.map(({ admin, count }) => (
                <Table.Row key={admin}>
                  <Table.Cell className="max-w-0 w-full">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-ml-2 max-w-full text-base"
                      aria-label={`Show only ${admin}’s activity`}
                      onClick={() => onAdminSelect(admin)}
                    >
                      <span className="truncate">{admin}</span>
                    </Button>
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{NUMBER.format(count)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
    </div>
  </div>
)

/**
 * The admin Audit tab: what the deployment-wide admin audit log holds for the last week, the log
 * itself, filtered and a page at a time, and the log's retention.
 */
export const AdminAuditPanel = ({ admin, settings, onSettingsChanged, filter, onFilterChange }: AdminAuditPanelProps) => {
  const toasts = useKumoToastManager()
  // Each load is one value of this; a new one supersedes those before it.
  const [loads, setLoads] = useState(0)
  const [statsAnswer, setStatsAnswer] = useState<StatsAnswer | null>(null)
  const activityHeading = useId()
  const logHeading = useId()
  const retention = settings.adminAuditRetentionDays

  useEffect(() => {
    let current = true
    admin.getAdminAuditStats({ days: STATS_DAYS }).then(
      (stats) => { if (current) setStatsAnswer({ loads, stats }) },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the admin audit statistics:', err)
        setStatsAnswer({ loads, failed: true })
      },
    )
    return () => { current = false }
  }, [admin, loads])

  // Shown statistics stay until the load that replaces them answers.
  const stats = statsAnswer !== null && 'stats' in statsAnswer ? statsAnswer.stats : null
  const refreshing = statsAnswer?.loads !== loads
  const statsFailed = statsAnswer !== null && 'failed' in statsAnswer && !refreshing
  const reload = () => setLoads((n) => n + 1)

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

  const selectAdmin = (selected: string) => onFilterChange({ ...filter, admin: selected })

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
            loading={refreshing && stats !== null}
            disabled={refreshing}
            onClick={reload}
          >
            Refresh
          </Button>
        </div>

        {stats === null && !statsFailed && (
          <div className="flex justify-center py-16">
            <Loader size="lg" />
          </div>
        )}
        {statsFailed && (
          <div className={`${CARD} text-center`}>
            <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the admin audit statistics.</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>Retry</Button>
          </div>
        )}
        {stats !== null && !statsFailed && <StatsCards stats={stats} onAdminSelect={selectAdmin} />}

        <section className={CARD} aria-labelledby={logHeading}>
          <h3 id={logHeading} className="text-lg font-semibold text-kumo-strong mb-4">Activity log</h3>
          <AuditLog
            admin={admin}
            filter={filter}
            onFilterChange={onFilterChange}
            adminSuggestions={stats?.topAdmins.map(({ admin: name }) => name) ?? []}
            reloads={loads}
          />
        </section>
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
