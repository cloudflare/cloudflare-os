import { useState } from 'react'
import { Check, Plus, UserCircle } from '@phosphor-icons/react'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

/**
 * Account info as consumed by the chooser. Matches the shape used by GatekeeperModal and the
 * blueprint configure panel.
 */
export type AccountOption = {
  id: number
  description: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

/**
 * Renders a connected-account avatar with graceful fallback. Some vendors (notably Google) hand
 * us short-lived signed CDN URLs for the user's profile photo that can stop working without the
 * credentials themselves expiring; on load failure we fall back to the vendor logo, then a
 * generic user icon.
 */
export function AccountAvatar({ avatarUrl, logoUrl }: { avatarUrl: string | undefined, logoUrl: string | undefined }) {
  const [failed, setFailed] = useState(false)
  if (avatarUrl && !failed) {
    return <img src={avatarUrl} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
  }
  if (logoUrl) return <img src={logoUrl} alt="" className="h-4 w-4 object-contain" />
  return <UserCircle size={17} className="text-kumo-subtle" />
}

export function AccountChooser({
  accounts,
  selectedAccountId,
  vendorId,
  vendorName,
  resourceTitle,
  connecting,
  reconnectingAccountId,
  requiredResourceUrlPatterns,
  grantingAccountId = null,
  onSelect,
  onConnect,
  onReconnect,
  onGrantAccess,
}: {
  accounts: AccountOption[]
  selectedAccountId: number | null
  vendorId?: string
  vendorName: string
  resourceTitle?: string
  connecting: boolean
  reconnectingAccountId: number | null
  requiredResourceUrlPatterns?: string[]
  grantingAccountId?: number | null
  onSelect: (id: number) => void
  onConnect: () => void
  onReconnect: (id: number) => void
  onGrantAccess?: (id: number) => void
}) {
  const isEmailMailbox = vendorId === 'email' && resourceTitle === 'Email Mailbox'

  return (
    <section className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-line px-3 py-2.5">
        <p className="text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default">Account</p>
        <p className="mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          {isEmailMailbox
            ? 'Enable the Email receiver account, then choose the mailbox name below.'
            : `Pick which ${vendorName} identity this ${resourceTitle ?? 'connection'} should use.`}
        </p>
      </div>
      <div className="divide-y divide-kumo-line">
        {accounts.map(account => {
          const selected = selectedAccountId === account.id
          const name = account.description.uniqueName || account.description.displayName || 'Connected account'
          const expired = !account.credentialsValid
          const reconnecting = reconnectingAccountId === account.id
          const granted = account.description.grantedResourceUrlPatterns
          const accountMissing =
            requiredResourceUrlPatterns && granted !== undefined
              ? requiredResourceUrlPatterns.filter(p => !granted.includes(p))
              : []
          const needsAccess = !expired && accountMissing.length > 0
          const granting = grantingAccountId === account.id
          return (
            <div
              key={account.id}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${selected ? 'bg-kumo-tint' : ''}`}
            >
              <button
                type="button"
                disabled={expired}
                onClick={() => onSelect(account.id)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left transition-colors enabled:hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full"
                  style={{
                    backgroundColor:
                      account.vendorDescription.color ?? 'var(--color-kumo-tint)',
                  }}
                >
                  <AccountAvatar avatarUrl={account.description.avatar?.url} logoUrl={account.vendorDescription.logo?.url} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">{name}</p>
                  <p className={`truncate text-[12px] leading-4 font-normal tracking-[-0.2px] ${needsAccess ? 'text-kumo-brand' : 'text-kumo-subtle'}`}>
                    {expired
                      ? 'Expired credentials'
                      : needsAccess
                      ? 'Additional permission needed'
                      : resourceTitle ? `Connected ${vendorName} account` : 'Connected'}
                  </p>
                </div>
              </button>
              {expired ? (
                <button
                  type="button"
                  onClick={() => onReconnect(account.id)}
                  disabled={reconnecting}
                  className="shrink-0 cursor-pointer rounded-md border border-kumo-line px-2 py-1 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default transition-colors hover:bg-kumo-elevated disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reconnecting ? 'Opening...' : 'Reconnect'}
                </button>
              ) : needsAccess ? (
                <button
                  type="button"
                  onClick={() => onGrantAccess?.(account.id)}
                  disabled={granting}
                  className="shrink-0 cursor-pointer rounded-md border border-kumo-line px-2 py-1 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default transition-colors hover:bg-kumo-elevated disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {granting ? 'Opening...' : 'Grant access'}
                </button>
              ) : null}
              {selected && <Check size={15} weight="bold" className="shrink-0 text-kumo-brand" />}
            </div>
          )
        })}

        {(!isEmailMailbox || accounts.length === 0) && (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-elevated hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-60"
          >
            {connecting ? (
              <span className="h-3.5 w-3.5 rounded-full border-2 border-kumo-brand border-t-transparent animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            {isEmailMailbox
              ? 'Enable Email mailboxes'
              : accounts.length === 0 ? `Connect ${vendorName}` : `Use another ${vendorName} account`}
          </button>
        )}
      </div>
    </section>
  )
}
