import { describe, expect, it, vi } from 'vitest'
import { CapturedLogs, type CapturedLog } from './capturedLogs'

const log = (level: CapturedLog['level'], ...message: unknown[]): CapturedLog => ({ timestamp: new Date(0), level, message, source: 'page' })

describe('CapturedLogs', () => {
  it('counts a chat’s logs, says the worst, and gives them formatted once', () => {
    const logs = new CapturedLogs()
    const key = CapturedLogs.key('w', 4)
    logs.add(key, [log('log', 'loaded'), log('warn', 'slow')])
    expect(logs.summary(key)).toEqual({ count: 2, severity: 'warning' })
    logs.add(key, [{ ...log('error', 'boom', { code: 3 }), source: 'server' }])
    expect(logs.summary(key)).toEqual({ count: 3, severity: 'error' })

    expect(logs.take(key)).toBe('Console logs:\n[page log] loaded\n[page warn] slow\n[server error] boom {"code":3}')
    expect(logs.summary(key)).toEqual({ count: 0, severity: 'log' })
    expect(logs.take(key)).toBe('')
  })

  it('keeps each chat’s apart, tells only its listeners, and keeps the latest 200', () => {
    const logs = new CapturedLogs()
    const listener = vi.fn<() => void>()
    logs.subscribe('w/1', listener)
    logs.add('w/2', [log('log', 'other')])
    expect(listener).not.toHaveBeenCalled()

    logs.add('w/1', Array.from({ length: 250 }, (_, index) => log('log', String(index))))
    expect(listener).toHaveBeenCalledOnce()
    expect(logs.summary('w/1').count).toBe(200)
    expect(logs.peek('w/1').split('\n')[1]).toBe('[page log] 50')

    logs.discard('w/1')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(logs.summary('w/2').count).toBe(1)
  })
})
