import type { IssueReportGrant } from '@gadgets/workshop-shared/api'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** What the grant given with a report covers, as the admins read it. */
export const GRANT_SCOPE_NAMES: Record<IssueReportGrant['scope'], string> = {
  workspace: 'Content: this workspace',
  account: 'Content: all the reporter’s workspaces',
}

/**
 * Where a report's copy of its grant stands at `now`: the time it has left, in whole hours, or
 * in minutes within its last hour, or how it came to an end.
 */
export const grantStanding = (grant: IssueReportGrant, now: number): string => {
  if (grant.endedAt !== undefined) return 'ended'
  const left = grant.expiresAt.getTime() - now
  if (left <= 0) return 'expired'
  const hours = Math.floor(left / HOUR)
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`
  const minutes = Math.max(1, Math.floor(left / MINUTE))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`
}
