import { OutOfCreditsDialog, type OutOfCreditsState } from '@/blocks/OutOfCreditsDialog'
import { openConnectWindow } from '@/connections/connectHandoff'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { creditsUrl, outOfCreditsStep } from './credits'
import { useUsage } from './useUsage'

export type OutOfCreditsProps = {
  onClose: () => void
}

/**
 * The way on once the free requests have run out (`OutOfCreditsDialog`), over what the account's
 * usage says. Mount it only while it is open: the usage is read as it opens, and again each time
 * the window is come back to, as connecting and adding credits are done in another.
 */
export const OutOfCredits = ({ onClose }: OutOfCreditsProps) => {
  const { api } = useApi()
  const { state: usage, refresh } = useUsage()
  const connection = useConnectionNotice()

  const state: OutOfCreditsState =
    usage.status === 'loading' ? usage
    : usage.status === 'failed' ? { status: 'failed', message: usage.message, onRetry: usage.retry }
    : {
        status: 'ready',
        step: outOfCreditsStep(usage.usage),
        dailyLimit: usage.usage.dailyLimit,
        resetAt: usage.usage.resetAt,
        balance: usage.usage.balance,
        accounts: usage.accounts?.map(({ accountId, accountName }) => ({ id: accountId, name: accountName })),
      }
  const accountId = usage.status === 'ready' ? usage.usage.accountId : undefined

  return (
    <OutOfCreditsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      state={state}
      // Signed in to in a window of its own; coming back to this one reads the usage again.
      onConnect={async () => {
        if (connection?.blocked()) return
        openConnectWindow(await api.connectAccount('cloudflare', []))
      }}
      onChooseAccount={async (id) => {
        if (connection?.blocked()) return
        await api.selectCloudflareAccount(id)
        refresh()
      }}
      onAddCredits={() => window.open(creditsUrl(accountId), '_blank', 'noopener')}
      onReset={refresh}
    />
  )
}
