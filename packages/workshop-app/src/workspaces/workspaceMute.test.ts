import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWorkspaceMuted, muteFor } from './workspaceMute'

describe('isWorkspaceMuted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('is not muted with no mute', () => {
    expect(isWorkspaceMuted({})).toBe(false)
  })

  it('is muted until unmuted when the mute is indefinite', () => {
    expect(isWorkspaceMuted({ notificationMute: { indefinite: true } })).toBe(true)
  })

  it('is muted until a time, and no longer once it has passed', () => {
    expect(isWorkspaceMuted({ notificationMute: { until: new Date('2026-01-01T13:00:00Z') } })).toBe(true)
    expect(isWorkspaceMuted({ notificationMute: { until: new Date('2026-01-01T11:00:00Z') } })).toBe(false)
  })
})

describe('muteFor', () => {
  const now = new Date(2026, 10, 20, 22, 30)

  it('mutes for an hour, until tomorrow morning, or until unmuted', () => {
    expect(muteFor('hour', now)).toEqual({ until: new Date(2026, 10, 20, 23, 30) })
    expect(muteFor('tomorrow', now)).toEqual({ until: new Date(2026, 10, 21, 8) })
    expect(muteFor('always', now)).toEqual({ indefinite: true })
  })
})
