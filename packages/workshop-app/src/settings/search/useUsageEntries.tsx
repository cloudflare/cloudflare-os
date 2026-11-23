import { CloudIcon, Coins01Icon, CreditCardIcon } from '@/components/icons'
import type { SearchEntry } from '@/blocks/SearchDialog'
import { openConnectWindow } from '@/connections/connectHandoff'
import { useApi } from '@/rpc/ApiContext'
import { creditsUrl } from '../credits'
import { useUsage } from '../useUsage'
import { useRequireConnection } from './useRequireConnection'

const GROUP = 'Usage & billing'

/**
 * The Usage & billing settings that are there, where the deployment limits usage: connecting the
 * Cloudflare account that pays for more, choosing which of its accounts does where there are
 * several, and the way to add credits. Read while `enabled`.
 */
export const useUsageEntries = (enabled: boolean): SearchEntry[] => {
  const { api } = useApi()
  const { state, refresh } = useUsage(enabled)
  const requireConnection = useRequireConnection()
  if (state.status !== 'ready') return []

  const { usage, accounts } = state
  if (!usage.cloudflareLimitsEnabled || usage.unlimited) return []

  if (!usage.connected) {
    return [{
      key: 'setting:connect-cloudflare',
      group: GROUP,
      title: 'Connect Cloudflare account',
      keywords: ['billing', 'pay', 'credits', 'free requests'],
      icon: <CloudIcon />,
      // Signed in to in a window of its own; coming back to this one reads the usage again.
      onSelect: async () => {
        requireConnection()
        openConnectWindow(await api.connectAccount('cloudflare', []))
      },
    }]
  }

  if (usage.needsAccountSelection) {
    return [{
      key: 'setting:billing-account',
      group: GROUP,
      title: 'Billing account',
      keywords: ['cloudflare', 'pay', 'credits'],
      icon: <CreditCardIcon />,
      onSelect: () => ({
        kind: 'list',
        title: 'Billing account',
        placeholder: 'Choose the account to bill',
        entries: (accounts ?? []).map(({ accountId, accountName }) => ({
          key: `setting:billing-account:${accountId}`,
          group: 'Cloudflare accounts',
          title: accountName,
          icon: <CloudIcon />,
          onSelect: async () => {
            requireConnection()
            await api.selectCloudflareAccount(accountId)
            refresh()
          },
        })),
      }),
    }]
  }

  return [{
    key: 'setting:add-credits',
    group: GROUP,
    title: 'Add AI Gateway credits',
    keywords: ['billing', 'pay', 'cloudflare', 'balance'],
    detail: usage.balance === null ? undefined : `$${usage.balance.toFixed(2)}`,
    icon: <Coins01Icon />,
    onSelect: () => void window.open(creditsUrl(usage.accountId), '_blank', 'noopener'),
  }]
}
