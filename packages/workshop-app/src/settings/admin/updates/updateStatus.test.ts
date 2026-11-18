import { describe, expect, it } from 'vitest'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { checkOutcome, updateAvailability, wholeNumberIn, workerList } from './updateStatus'

const STATUS: DeploymentUpdateStatus = {
  currentReleaseId: '2026.11.1',
  updateAvailable: false,
  notify: false,
  checksEnabled: true,
  checkIntervalMinutes: 60,
  minimumAgeHours: 24,
  noticeSnoozeHours: 24,
  modified: false,
  modifiedWorkers: [],
  unfinishedWorkers: [],
  updateUrl: 'https://deploy.example.com/upgrade',
}

describe('update status', () => {
  it('names the backend and router, and a gatekeeper by its slug', () => {
    expect(workerList(['backend', 'router', 'google'])).toBe('the backend, the router, and the “google” gatekeeper')
  })

  it('says an update is not known of until a check has succeeded', () => {
    expect(updateAvailability(STATUS)).toBe('Not known until a check succeeds')
    expect(updateAvailability({ ...STATUS, checkedAt: new Date() })).toBe('No')
    expect(updateAvailability({ ...STATUS, updateAvailable: true })).toBe('Yes')
  })

  it('says what a check found', () => {
    expect(checkOutcome({ ...STATUS, updateAvailable: true, latestReleaseId: '2026.11.2' })).toBe('Update available: release 2026.11.2.')
    expect(checkOutcome(STATUS)).toBe('No update available: this deployment runs the newest release.')
  })

  it('takes a whole number in range, with its thousands set apart or not', () => {
    expect(wholeNumberIn('1,440', 1, 43_200, 'minutes')).toEqual({ value: 1440 })
    expect(wholeNumberIn('0', 0, 720, 'hours')).toEqual({ value: 0 })
  })

  it('refuses a number out of range, a fraction and words', () => {
    for (const typed of ['0', '43201', '1.5', 'soon', '']) {
      expect(wholeNumberIn(typed, 1, 43_200, 'minutes')).toEqual({ problem: 'Enter a whole number of minutes from 1 to 43,200.' })
    }
  })
})
