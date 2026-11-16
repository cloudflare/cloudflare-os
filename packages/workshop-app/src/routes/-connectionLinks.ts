import { useNavigate, useRouter } from '@tanstack/react-router'
import { itemPageId } from '@/aside/asideItems'
import type { ConnectionLinks } from '@/connections/ConnectionDetails'
import { useConnectedAccounts } from '@/connections/ConnectedAccountsContext'

/**
 * Where a connection's dialog goes: a gadget that uses it, to its own connections; a chat that
 * used it; the user's account on its service, that account's page while they have only one, else
 * the Gatekeepers page to choose from; and the workspace's Connections tab, with it open there.
 */
export const useConnectionLinks = (): ConnectionLinks => {
  const navigate = useNavigate()
  const router = useRouter()
  const accounts = useConnectedAccounts()
  return {
    use: (workspaceId, use) => {
      if (use.type === 'gadget') {
        const to = { to: '/app/$itemId/settings', params: { itemId: itemPageId(workspaceId, { kind: 'output', workpieceId: use.gadgetId }) }, search: { tab: 'connections' } } as const
        return { href: router.buildLocation(to).href, onOpen: () => void navigate(to) }
      }
      const to = { to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId: use.chatId } } as const
      return { href: router.buildLocation(to).href, onOpen: () => void navigate({ ...to, state: { chatTitle: use.title } }) }
    },
    account: (vendorId) => {
      const mine = accounts.status === 'ready' ? accounts.accounts.filter((account) => account.vendorId.toLowerCase() === vendorId) : []
      const to = mine.length === 1
        ? ({ to: '/gatekeepers/$accountId', params: { accountId: String(mine[0]!.id) } } as const)
        : ({ to: '/gatekeepers' } as const)
      return { href: router.buildLocation(to).href, onOpen: () => void navigate(to) }
    },
    workspace: (workspaceId, gatekeeperId) => {
      const to = { to: '/workspace/$workspaceId', params: { workspaceId }, search: { tab: 'connections', connection: gatekeeperId } } as const
      return { href: router.buildLocation(to).href, onOpen: () => void navigate(to) }
    },
  }
}
