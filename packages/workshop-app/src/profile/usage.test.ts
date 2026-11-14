import { describe, expect, it } from 'vitest'
import type { CloudflareUsageInfo, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { allowanceOf, formatCost, spendDetail, spendSummary } from './usage'

const workspace = (title: string, totalCost: number | undefined, role: 'build' | 'use' = 'build') =>
  ({ id: title, title, totalCost, role, lastActive: new Date() }) as unknown as WorkspaceMetadataWithTimestamps

describe('spendSummary', () => {
  it('adds up what the user’s workspaces cost, naming the one that cost most', () => {
    const summary = spendSummary([workspace('Acme', 1.25), workspace('Home', 0.5), workspace('Empty', undefined), workspace('Given', 9, 'use')])
    expect(summary).toEqual({ total: 1.75, workspaces: 2, most: { title: 'Acme', cost: 1.25 } })
    expect(spendDetail(summary)).toBe('Across 2 workspaces, most in Acme ($1.25).')
  })

  it('says so when nothing has cost anything, or all of it was in one', () => {
    expect(spendDetail(spendSummary([]))).toMatch(/^Nothing yet/)
    expect(spendDetail(spendSummary([workspace('Acme', 0.004)]))).toBe('All in Acme.')
  })
})

describe('formatCost', () => {
  it('writes dollars as a price, and less than a cent as such', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(1234.5)).toBe('$1,234.50')
  })
})

describe('allowanceOf', () => {
  const usage: CloudflareUsageInfo = { cloudflareLimitsEnabled: true, unlimited: false, dailyUsed: 12, dailyLimit: 50, remaining: 38, connected: false, balance: null }

  it('says nothing where use is not limited', () => {
    expect(allowanceOf({ ...usage, cloudflareLimitsEnabled: false })).toBeUndefined()
    expect(allowanceOf({ ...usage, unlimited: true })).toBeUndefined()
  })

  it('says how much of today’s is used, and what pays for more', () => {
    expect(allowanceOf(usage)).toMatchObject({ used: 12, limit: 50, detail: '12 of 50 free today.', account: undefined })
    expect(allowanceOf({ ...usage, connected: true, accountName: 'Acme', balance: 4.5 })?.account).toBe('Acme pays for more, with $4.50 left.')
  })
})
