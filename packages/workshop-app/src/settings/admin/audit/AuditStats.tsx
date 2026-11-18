import type { ReactNode } from 'react'
import type { AdminAuditStats } from '@gadgets/workshop-shared/api'
import { SettingsCard } from '@/blocks/SettingsGroup'

const NUMBER = new Intl.NumberFormat('en')

// A UTC day (YYYY-MM-DD), named as a date. The statistics count UTC days, so it is read in UTC.
const DAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayName = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? day : DAY.format(date)
}

// A thing counted, with its count at the line's end.
const Line = ({ children, count }: { children: ReactNode; count: number }) => (
  <li className="flex items-baseline justify-between gap-4 border-t border-kumo-line py-3 first:border-t-0">
    <span className="min-w-0 wrap-anywhere">{children}</span>
    <span className="shrink-0 text-kumo-subtle tabular-nums">{NUMBER.format(count)}</span>
  </li>
)

export type AuditStatsProps = {
  stats: AdminAuditStats
  /** One of the most active admins was chosen, to see only what they did. */
  onFilterByAdmin: (admin: string) => void
}

/**
 * What the audit log holds for the last days, on two surfaces: how many actions there were, and on
 * each UTC day, then the admins who did the most, each of whom narrows the log to them when chosen.
 */
export const AuditStats = ({ stats, onFilterByAdmin }: AuditStatsProps) => (
  // Side by side where the part is wide enough for both.
  <div className="@container">
    <div className="grid items-start gap-3 @2xl:grid-cols-2">
      <SettingsCard>
        <p className="border-b border-kumo-line py-4 text-kumo-subtle">
          <span className="text-2xl font-medium text-kumo-default tabular-nums">{NUMBER.format(stats.totalEvents)}</span>
          {' '}{stats.totalEvents === 1 ? 'action' : 'actions'} in the last {stats.days} days, by UTC day
        </p>
        <ul aria-label="Actions by day" className="flex flex-col">
          {stats.byDay.map(({ day, count }) => (
            <Line key={day} count={count}><time dateTime={day}>{dayName(day)}</time></Line>
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard>
        <p className="border-b border-kumo-line py-4 font-medium text-kumo-default">Most active admins</p>
        {stats.topAdmins.length === 0
          ? <p className="py-4 text-kumo-subtle">No admin activity in this time.</p>
          : (
              <ul aria-label="Most active admins" className="flex flex-col">
                {stats.topAdmins.map(({ admin, count }) => (
                  <Line key={admin} count={count}>
                    <button
                      type="button"
                      aria-label={`Show only ${admin}’s activity`}
                      onClick={() => onFilterByAdmin(admin)}
                      className="cursor-pointer text-left wrap-anywhere text-kumo-default underline decoration-kumo-line underline-offset-2 hover:decoration-current"
                    >
                      {admin}
                    </button>
                  </Line>
                ))}
              </ul>
            )}
      </SettingsCard>
    </div>
  </div>
)
