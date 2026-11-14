import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACK_FOR, ConnectionNotice, LONG_AFTER, SHOW_AFTER } from './ConnectionNotice'

const status = (notice: ConnectionNotice) => notice.getSnapshot().status

const alarms = (notice: ConnectionNotice) => {
  const snapshot = notice.getSnapshot()
  return snapshot.status === 'reconnecting' ? snapshot.alarms : undefined
}

describe('ConnectionNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says nothing of a drop that is soon over', () => {
    const notice = new ConnectionNotice()
    notice.lost()
    vi.advanceTimersByTime(SHOW_AFTER - 1)
    notice.restored()
    vi.advanceTimersByTime(BACK_FOR)
    expect(status(notice)).toBe('hidden')
    expect(notice.down).toBe(false)
  })

  it('says it is reconnecting after a moment, then that it is back, then goes', () => {
    const notice = new ConnectionNotice()
    notice.lost()
    expect(notice.down).toBe(true)
    vi.advanceTimersByTime(SHOW_AFTER)
    expect(notice.getSnapshot()).toEqual({ status: 'reconnecting', alarms: 0, long: false, offline: false })

    notice.restored()
    expect(status(notice)).toBe('reconnected')
    vi.advanceTimersByTime(BACK_FOR)
    expect(status(notice)).toBe('hidden')
  })

  it('stays away once put away, and comes back with a fresh alarm when something cannot be done', () => {
    const notice = new ConnectionNotice()
    notice.lost()
    vi.advanceTimersByTime(SHOW_AFTER)
    notice.dismiss()
    vi.advanceTimersByTime(LONG_AFTER)
    expect(status(notice)).toBe('hidden')

    expect(notice.blocked()).toBe(true)
    expect(alarms(notice)).toBe(1)
    expect(notice.blocked()).toBe(true)
    expect(alarms(notice)).toBe(2)
  })

  it('comes up at once when something cannot be done, before it would have on its own, and only once', () => {
    const notice = new ConnectionNotice()
    notice.lost()
    expect(notice.blocked()).toBe(true)
    expect(alarms(notice)).toBe(1)
    vi.advanceTimersByTime(SHOW_AFTER)
    expect(alarms(notice)).toBe(1)
  })

  it('says it is back only to whoever saw it go or was kept waiting', () => {
    const unnoticed = new ConnectionNotice()
    unnoticed.lost()
    vi.advanceTimersByTime(SHOW_AFTER)
    unnoticed.dismiss()
    unnoticed.restored()
    expect(status(unnoticed)).toBe('hidden')

    const waiting = new ConnectionNotice()
    waiting.lost()
    waiting.blocked()
    waiting.dismiss()
    waiting.restored()
    expect(status(waiting)).toBe('reconnected')
  })

  it('lets everything be done while the connection is up', () => {
    const notice = new ConnectionNotice()
    expect(notice.blocked()).toBe(false)
    notice.lost()
    notice.restored()
    expect(notice.blocked()).toBe(false)
    expect(status(notice)).toBe('hidden')
  })

  it('says when it has been a while, and whether the device is offline', () => {
    const notice = new ConnectionNotice()
    notice.lost()
    notice.setOffline(true)
    vi.advanceTimersByTime(SHOW_AFTER)
    expect(notice.getSnapshot()).toMatchObject({ long: false, offline: true })

    vi.advanceTimersByTime(LONG_AFTER)
    notice.setOffline(false)
    expect(notice.getSnapshot()).toMatchObject({ long: true, offline: false, alarms: 0 })
  })

  it('carries straight on when lost again while saying it was back', () => {
    const notice = new ConnectionNotice()
    notice.lost()
    vi.advanceTimersByTime(SHOW_AFTER)
    notice.restored()
    notice.lost()
    expect(notice.getSnapshot()).toMatchObject({ status: 'reconnecting', alarms: 0 })
    vi.advanceTimersByTime(BACK_FOR)
    expect(status(notice)).toBe('reconnecting')
  })
})
