import type { useKumoToastManager } from '@cloudflare/kumo'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { openConnectWindow } from './connectHandoff'

/**
 * Asks for grants covering `resourceUrlPatterns` on a connected account, opening the provider's
 * consent pop-up when the account lacks them. Resolves true when the account already holds them,
 * otherwise false once the pop-up is open (or, in a native app, redeemed); the grant itself arrives
 * through `subscribeConnectedAccounts()`. Rejects as `openConnectWindow` does, cancellation
 * included.
 */
export async function requestAccountResources(
  api: Pick<AuthenticatedApi, 'ensureAccountResources' | 'completeConnectHandoff'>,
  toasts: Pick<ReturnType<typeof useKumoToastManager>, 'add'>,
  accountId: number,
  resourceUrlPatterns: string[],
): Promise<boolean> {
  const flow = await api.ensureAccountResources(accountId, resourceUrlPatterns)
  if (!flow) return true
  const outcome = await openConnectWindow(flow, api)
  toasts.add({ title: outcome === 'connected' ? 'Access granted.' : 'Grant the additional access in the pop-up window.', variant: 'success' })
  return false
}
