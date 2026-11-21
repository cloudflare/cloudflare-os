import { useState } from 'react'
import { Button, Select, SettingRow, SettingsGroup } from '@gadgets/ui'
import { openConnectWindow } from '@/connections/connectHandoff'
import { useApi } from '@/rpc/ApiContext'
import { creditsUrl } from './credits'
import { useAttempt } from './useAttempt'
import { useUsage } from './useUsage'

const RESETS = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

/** What the user has used, and what pays for more. */
export const UsageSettings = () => {
  const { api } = useApi()
  const { state, refresh } = useUsage()
  const { problem, attempt } = useAttempt()
  const [busy, setBusy] = useState(false)

  if (state.status === 'loading') return <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading usage…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center gap-3 px-5 text-base text-kumo-subtle">
        Couldn’t load usage: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }

  const { usage, accounts } = state
  if (!usage.cloudflareLimitsEnabled || usage.unlimited) {
    return (
      <SettingsGroup title="Free requests">
        <SettingRow title="Unlimited" description="This deployment doesn’t limit usage, so there’s nothing to pay for." />
      </SettingsGroup>
    )
  }

  const during = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true)
    await attempt(what, action)
    setBusy(false)
  }

  return (
    <>
      {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
      <SettingsGroup title="Free requests">
        <SettingRow
          title="Remaining today"
          description={usage.resetAt ? `Resets at ${RESETS.format(new Date(usage.resetAt))}.` : 'Resets daily.'}
        >
          <span className="text-kumo-default tabular-nums">{usage.remaining} of {usage.dailyLimit} left</span>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Billing">
        {!usage.connected && (
          <SettingRow title="Cloudflare account" description="Connect your Cloudflare account to keep working after your free requests run out. Extra usage is billed to its AI Gateway credits.">
            <Button
              variant="primary"
              disabled={busy}
              // Signed in to in a window of its own; coming back to this one reads the usage again.
              onClick={() => void during('connect Cloudflare', async () => openConnectWindow(await api.connectAccount('cloudflare', [])))}
            >
              Connect Cloudflare
            </Button>
          </SettingRow>
        )}
        {usage.connected && usage.needsAccountSelection && (
          <SettingRow title="Billing account" description="Your connection has access to more than one Cloudflare account. Choose the one to bill for usage beyond your free requests.">
            <Select
              aria-label="Billing account"
              value=""
              placeholder={accounts?.length === 0 ? 'No accounts' : 'Select account'}
              searchable
              options={(accounts ?? []).map(({ accountId, accountName }) => ({ id: accountId, label: accountName }))}
              onValueChange={(accountId) => void during('set the billing account', async () => {
                await api.selectCloudflareAccount(accountId)
                refresh()
              })}
            />
          </SettingRow>
        )}
        {usage.connected && !usage.needsAccountSelection && (
          <>
            <SettingRow title="Billing account" description={`${usage.accountName ?? 'Your Cloudflare account'} is billed for usage beyond your free requests.`} />
            <SettingRow title="AI Gateway credits" description="Add credits in the Cloudflare dashboard, which opens in a new tab.">
              <span className="text-kumo-default tabular-nums">{usage.balance === null ? 'Unknown' : `$${usage.balance.toFixed(2)}`}</span>
              <Button onClick={() => window.open(creditsUrl(usage.accountId), '_blank', 'noopener')}>Add credits</Button>
            </SettingRow>
          </>
        )}
      </SettingsGroup>
    </>
  )
}
