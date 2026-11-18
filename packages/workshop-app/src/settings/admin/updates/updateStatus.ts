import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'

const WORKER_LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/** The Workers an update status names, in words: the backend, the router, or a gatekeeper by its install slug. */
export const workerList = (workers: string[]): string =>
  WORKER_LIST.format(workers.map((worker) => (worker === 'backend' || worker === 'router' ? `the ${worker}` : `the “${worker}” gatekeeper`)))

/** Whether there is a newer release, as far as the last check that succeeded knows. */
export const updateAvailability = (status: DeploymentUpdateStatus): string => {
  if (status.updateAvailable) return 'Yes'
  return status.checkedAt === undefined ? 'Not known until a check succeeds' : 'No'
}

/** What a check found, in a sentence, said once it is done. */
export const checkOutcome = (status: DeploymentUpdateStatus): string =>
  status.updateAvailable && status.latestReleaseId !== undefined
    ? `Update available: release ${status.latestReleaseId}.`
    : 'No update available: this deployment runs the newest release.'

/**
 * A whole number typed into a field, from `min` to `max`, or why it is not one. Thousands may be
 * set apart, as a number is shown.
 */
export const wholeNumberIn = (typed: string, min: number, max: number, unit: string): { value: number } | { problem: string } => {
  const digits = typed.replace(/[\s,_]/g, '')
  const value = Number(digits)
  if (!/^\d+$/.test(digits) || value < min || value > max) return { problem: `Enter a whole number of ${unit} from ${min} to ${max.toLocaleString('en')}.` }
  return { value }
}
