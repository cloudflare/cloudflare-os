import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'

/**
 * Test-only: a complete DeploymentUpdateStatus for a deployment with a notifiable update, with
 * `overrides` applied. Tests build statuses here so a new status field changes one place.
 */
export const testUpdateStatus = (
  overrides: Partial<DeploymentUpdateStatus> = {},
): DeploymentUpdateStatus => ({
  currentReleaseId: 'r100-aaaaaaa',
  latestReleaseId: 'r101-bbbbbbb',
  updateAvailable: true,
  availableSince: new Date('2026-10-01T09:00:00Z'),
  notify: true,
  checksEnabled: true,
  minimumAgeHours: 24,
  noticeSnoozeHours: 24,
  modified: false,
  modifiedWorkers: [],
  unfinishedWorkers: [],
  updateUrl: 'https://deploy.example.com/#flow=upgrade&account=acct&installation=0123abcd&name=os',
  checkedAt: new Date('2026-10-03T12:30:00Z'),
  ...overrides,
})
