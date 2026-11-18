import type { CloudflareUsageInfo } from '@gadgets/workshop-shared/api'
import type { OutOfCreditsStep } from '@/blocks/OutOfCreditsDialog'

/** Where an account's AI Gateway credits are added, as the old app's `creditsUrl.ts` has it: the dashboard asks which account where it is not known. */
export const creditsUrl = (accountId: string | undefined) => `https://dash.cloudflare.com/?to=/${accountId || ':account'}/ai/ai-gateway/credits`

/**
 * What is in the way of carrying on once the free requests have run out: an account to connect
 * until there is one, then one of its accounts to choose where it has several, then credits.
 */
export const outOfCreditsStep = (usage: Pick<CloudflareUsageInfo, 'connected' | 'needsAccountSelection'>): OutOfCreditsStep =>
  !usage.connected ? 'connect' : usage.needsAccountSelection ? 'choose' : 'topUp'
