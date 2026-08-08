import { Plus } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../AuthContext'
import { useState, useEffect } from 'react'
import { logoComponents } from './ConnectionLogos'
import { getVendorIconBackground } from './vendorColors'
import { useTheme } from '../ThemeContext'
import { AccountsSubscriberAdapter } from '../accountsSubscriber'

interface ConnectedAccount {
  id: number
  name: string
  logo: string
}

export default function ConnectionChips() {
  const { authenticatedApi } = useAuthenticatedApi()
  const { resolvedThemeMode } = useTheme()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])

  useEffect(() => {
    let cancelled = false
    let subscriptionStub: { [Symbol.dispose](): void } | null = null

    const accountMap = new Map<number, ConnectedAccount>()

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, vendorId }) {
        if (cancelled) return
        accountMap.set(id, {
          id,
          name: description.displayName ?? description.uniqueName ?? vendor.displayName,
          logo: vendorId,
        })
        setAccounts(Array.from(accountMap.values()))
      },
      remove(id) {
        accountMap.delete(id)
        if (!cancelled) setAccounts(Array.from(accountMap.values()))
      },
    })
    const subPromise = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subPromise.then((stub) => {
      if (cancelled) {
        stub[Symbol.dispose]()
      } else {
        subscriptionStub = stub
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      subscriptionStub?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap max-w-2xl mx-auto">
      {accounts.slice(0, 5).map((account) => {
        const LogoComponent = logoComponents[account.logo]
        return (
          <button
            key={account.id}
            className="connection-chip flex items-center gap-1.5 pl-1.5 pr-3 py-1 rounded-full border text-left"
          >
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: getVendorIconBackground(account.logo, resolvedThemeMode) }}
            >
              {LogoComponent ? (
                <LogoComponent size={12} />
              ) : (
                <span className="text-[9px] font-bold text-kumo-strong">
                  {account.name[0]}
                </span>
              )}
            </div>
            <span className="text-sm text-kumo-default">
              {account.name}
            </span>
          </button>
        )
      })}
      <Link
        to="/gatekeepers"
        className="flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full border border-kumo-line text-sm text-kumo-subtle hover:text-kumo-brand hover:border-kumo-brand transition-colors"
      >
        <Plus size={14} />
      </Link>
    </div>
  )
}
