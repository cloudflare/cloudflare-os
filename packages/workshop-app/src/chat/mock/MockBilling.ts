import type { CloudflareAccountOption, CloudflareUsageInfo, ConnectFlowStart } from '@gadgets/workshop-shared/api'

const DAILY_LIMIT = 20

const ACCOUNTS: CloudflareAccountOption[] = [
  { accountId: 'a1b2c3', accountName: 'Ada’s account' },
  { accountId: 'd4e5f6', accountName: 'Analytical Engines Ltd' },
]

// The next midnight in UTC, when the free requests are had again.
const nextReset = (now: number) => {
  const reset = new Date(now)
  reset.setUTCHours(24, 0, 0, 0)
  return reset.toISOString()
}

/**
 * The account's usage as the fake backend has it: the day's free requests used up, and no
 * Cloudflare account to bill. Connecting one, which is done at once (the window opened for it
 * stays empty), gives a connection with two accounts to choose from, and choosing one bills it,
 * with too little on it: each step of the way on can be seen in turn.
 */
export class MockBilling {
  private connected = false
  private chosen: CloudflareAccountOption | undefined

  constructor(private readonly now = () => Date.now()) {}

  usage(): CloudflareUsageInfo {
    return {
      cloudflareLimitsEnabled: true,
      unlimited: false,
      dailyUsed: DAILY_LIMIT,
      dailyLimit: DAILY_LIMIT,
      remaining: 0,
      resetAt: nextReset(this.now()),
      connected: this.connected,
      balance: this.chosen ? 0.12 : null,
      accountId: this.chosen?.accountId,
      accountName: this.chosen?.accountName,
      needsAccountSelection: this.connected && !this.chosen,
    }
  }

  accounts(): CloudflareAccountOption[] {
    return this.connected ? ACCOUNTS : []
  }

  connect(): ConnectFlowStart {
    this.connected = true
    return { url: 'about:blank', nonce: '0'.repeat(64) }
  }

  select(accountId: string) {
    const account = ACCOUNTS.find((each) => each.accountId === accountId)
    if (!this.connected || !account) throw new Error('That account isn’t on this connection.')
    this.chosen = account
  }
}
