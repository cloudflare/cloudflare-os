import { describe, expect, it } from 'vitest'
import { outOfCreditsStep } from '@/settings/credits'
import { MockBilling } from './MockBilling'

describe('MockBilling', () => {
  it('goes through each step of the way on in turn', () => {
    const billing = new MockBilling(() => Date.UTC(2026, 10, 17, 15, 30))
    expect(billing.usage()).toMatchObject({ remaining: 0, resetAt: '2026-11-18T00:00:00.000Z' })
    expect(outOfCreditsStep(billing.usage())).toBe('connect')
    expect(billing.accounts()).toEqual([])

    billing.connect()
    expect(outOfCreditsStep(billing.usage())).toBe('choose')
    const [account] = billing.accounts()

    billing.select(account.accountId)
    expect(outOfCreditsStep(billing.usage())).toBe('topUp')
    expect(billing.usage()).toMatchObject({ accountId: account.accountId, balance: 0.12 })
  })

  it('refuses an account the connection does not have', () => {
    const billing = new MockBilling()
    billing.connect()
    expect(() => billing.select('elsewhere')).toThrow('That account isn’t on this connection.')
  })
})
