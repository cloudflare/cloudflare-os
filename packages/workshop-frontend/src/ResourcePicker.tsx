import { logRpcFailure } from './rpcErrors'
import { useState, useEffect, useMemo, useCallback, type MutableRefObject } from 'react'
import { Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { Plus, CaretRight, Warning } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { extractHostname, extractBaseUrl, matchesResource, matchesResourceText, classifyMatch, getPlaceholderRanges } from './resourceMatching'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import {
  PICKER_CAPTION, PICKER_EMPTY, PICKER_ROW, PICKER_ROW_ACTIVE, TabHint,
} from './components/pickerRows'
import { AccountsSubscriberAdapter } from './accountsSubscriber'

export interface VendorOption {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

export type SelectableItem = {
  type: 'account'
  accountId: number
  vendorId: string
  resource: SupportedResource
  accountDescription: AccountDescription
  vendorDescription: VendorDescription
} | {
  type: 'connect'
  vendorId: string
  vendorDescription: VendorDescription
  // If the resource being connected is independently grantable, its `urlPattern`, so a new account
  // requests just that resource's authorization. Undefined means request everything.
  resourceUrlPatterns?: string[]
} | {
  type: 'refine'
  resource: SupportedResource
  vendorDescription: VendorDescription
  suffix: string
  replaceSearch?: boolean
}

export interface ResourcePickerProps {
  authenticatedApi: RpcStub<AuthenticatedApi>
  searchText: string
  onSelectAccount: (
    accountId: number,
    vendorId: string,
    resource: SupportedResource,
    accountDescription: AccountDescription,
    vendorDescription: VendorDescription,
  ) => void
  onRefine?: (newUrl: string, placeholderStart: number, placeholderEnd: number) => void
  // Fires once the vendors and the connected accounts are both known. Until then the list grows a
  // row at a time, so a floating caller should stay hidden rather than resize under the pointer.
  onReadyChange?: (ready: boolean) => void
  compact?: boolean
  // Room the caller has measured for the list. Applied on top of the built-in cap, never instead of
  // it: a caller with plenty of space should still get a modestly sized panel.
  maxHeight?: number
  style?: React.CSSProperties
  activeIndex?: number
  onItems?: (items: SelectableItem[]) => void
  activateRef?: MutableRefObject<((index: number) => void) | null>
}

type AccountEntry = {
  description: AccountDescription
  vendor: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

// The picker mounts and unmounts as a URL is typed, and loads the same vendors and accounts every
// time. The last snapshot lets a reopen render complete, with the fresh load correcting it in place.
const sessionSnapshots = new WeakMap<RpcStub<AuthenticatedApi>, {
  vendors: VendorOption[]
  accounts: Map<number, AccountEntry>
}>()

function missingResourceGrants(account: AccountDescription, resource: SupportedResource): string[] {
  if (!resource.grantable) return []
  const granted = account.grantedResourceUrlPatterns
  // Undefined means legacy/full grant.
  if (granted === undefined) return []
  return granted.includes(resource.urlPattern) ? [] : [resource.urlPattern]
}

export default function ResourcePicker({
  authenticatedApi, searchText, onSelectAccount, onRefine, onReadyChange, compact,
  maxHeight: maxHeightOverride, style, activeIndex, onItems, activateRef,
}: ResourcePickerProps) {
  const toasts = useKumoToastManager()

  const buildRefineUrl = useCallback((suffix: string, replaceSearch?: boolean) => {
    const newUrl = replaceSearch ? suffix : searchText.trim() + suffix
    return newUrl.replace(/\*$/, '')
  }, [searchText])

  const snapshot = sessionSnapshots.get(authenticatedApi)
  const [allAccounts, setAllAccounts] = useState<Map<number, AccountEntry>>(
    () => snapshot?.accounts ?? new Map())
  const [allVendors, setAllVendors] = useState<VendorOption[]>(() => snapshot?.vendors ?? [])
  const [vendorsLoading, setVendorsLoading] = useState(false)
  // The subscription reports the accounts it already has before calling `ready()`.
  const [accountsLoaded, setAccountsLoaded] = useState(snapshot !== undefined)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [reconnectingAccount, setReconnectingAccount] = useState<number | null>(null)
  const [grantingAccount, setGrantingAccount] = useState<number | null>(null)

  // Subscribe to connected accounts on mount.
  useEffect(() => {
    let cancelled = false

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid }) {
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { description, vendor, supportedResources, credentialsValid })
          return next
        })
        // Clear reconnecting state if this account was being reconnected and is now valid.
        if (credentialsValid) {
          setReconnectingAccount(prev => prev === id ? null : prev)
        }
      },
      remove(id) {
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      },
      ready() {
        setAccountsLoaded(true)
      },
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch(error => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', error)
      // Nothing more is coming, so show what we have rather than hiding forever.
      setAccountsLoaded(true)
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  // Load all vendors on mount.
  useEffect(() => {
    const loadVendors = async () => {
      setVendorsLoading(snapshot === undefined)
      try {
        const vendorList = await authenticatedApi.listGatekeeperVendors()
        const unavailable = vendorList.filter(v => v.unavailable)
        if (unavailable.length > 0) {
          toasts.add({
            title: `Some services are temporarily unavailable: ${unavailable.map(v => v.id).join(', ')}`,
            variant: 'warning',
          })
        }
        setAllVendors(vendorList.filter(v => !v.unavailable).map(v => ({
          id: v.id,
          description: v.description,
          supportedResources: v.supportedResources,
        })))
      } catch (error) {
        console.error('Failed to load vendors:', error)
        toasts.add({ title: 'Failed to load available services', variant: 'error' })
      } finally {
        setVendorsLoading(false)
      }
    }
    loadVendors()
  }, [authenticatedApi])

  // --- Filtering and classification logic ---

  const lowerSearch = searchText.toLowerCase().trim()

  const allResourceItems = allVendors.flatMap(v =>
    v.supportedResources.map(r => ({ resource: r, vendor: v }))
  )

  // Check if the search URL still contains placeholder tokens (:name or *).
  const searchHasPlaceholders = lowerSearch ? getPlaceholderRanges(searchText.trim()).length > 0 : false

  type MatchedResource = {
    resource: SupportedResource
    vendor: VendorOption
    classification: 'full' | 'prefix' | 'none'
    suffix?: string
    // When true, the suffix replaces the entire search text (text-only matches)
    // rather than being appended to it (URL prefix matches).
    replaceSearch?: boolean
    accountsOnly?: boolean
  }

  let matchedResources: MatchedResource[] = []

  if (lowerSearch) {
    for (const { resource, vendor } of allResourceItems) {
      if (!matchesResource(searchText, resource)) continue
      const cls = classifyMatch(searchText.trim(), resource.urlPattern)
      if (cls.type === 'none') {
        // Text-only match (name/description matched but URL didn't). In URL-input
        // mode (onRefine), show as a prefix suggestion so selecting it fills in the
        // resource's base URL. Without onRefine, show normally.
        if (onRefine) {
          // Only treat as prefix if it was actually a text match (not a false positive).
          if (!matchesResourceText(searchText, resource)) continue
          const baseUrl = extractBaseUrl(resource.urlPattern)
          const suffix = baseUrl
            ? baseUrl.replace(/^https?:\/\//, '')
            : resource.urlPattern.replace(/^https?:\/\//, '')
          matchedResources.push({
            resource, vendor,
            classification: 'prefix',
            suffix,
            replaceSearch: true,
          })
        } else {
          matchedResources.push({ resource, vendor, classification: 'none' })
        }
        continue
      }
      matchedResources.push({
        resource, vendor,
        classification: cls.type,
        suffix: cls.type === 'prefix' ? cls.suffix : undefined,
      })
    }
  } else {
    // No search text: show all resources. When onRefine is provided (URL input context),
    // show as prefix matches so the user sees completable suggestions rather than accounts.
    matchedResources = allResourceItems.map(({ resource, vendor }) => ({
      resource, vendor,
      classification: onRefine ? 'prefix' as const : 'full' as const,
      suffix: onRefine ? resource.urlPattern : undefined,
    }))
  }

  // Sort: full matches first, prefix second, text-only (none) third.
  // Within each group, sort by URL pattern so less-specific patterns (shorter paths)
  // appear before more-specific ones, grouping related patterns logically.
  const classOrder = { full: 0, prefix: 1, none: 2 }
  matchedResources.sort((a, b) =>
    classOrder[a.classification] - classOrder[b.classification]
    || a.resource.urlPattern.localeCompare(b.resource.urlPattern)
  )

  // HTTP wildcard (`https://*`) shouldn't match when specific resources also match.
  // But connected HTTP accounts whose details match the search should still show.
  const httpItem = matchedResources.find(({ resource }) => resource.urlPattern === 'https://*')
  const hasSpecificMatches = matchedResources.some(({ resource }) => resource.urlPattern !== 'https://*')

  if (lowerSearch && httpItem && hasSpecificMatches) {
    matchedResources = matchedResources.filter(({ resource }) => resource.urlPattern !== 'https://*')

    const httpVendorName = httpItem.vendor.description.displayName
    const httpAccounts = [...allAccounts.entries()]
      .filter(([_, { vendor: v }]) => v.displayName === httpVendorName)

    const hasMatchingAccounts = lowerSearch
      ? httpAccounts.some(([_, { description }]) => {
          const corpus = [description.displayName, description.uniqueName]
            .filter(Boolean).join(' ').toLowerCase()
          return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
        })
      : httpAccounts.length > 0

    if (hasMatchingAccounts) {
      matchedResources.push({ ...httpItem, accountsOnly: true })
    }
  }

  // --- Build flat list of selectable items for keyboard navigation ---

  const selectableItems = useMemo(() => {
    const items: SelectableItem[] = []
    for (const { resource, vendor, classification, suffix, replaceSearch, accountsOnly } of matchedResources) {
      // Prefix matches: show a single "refine" row (only when onRefine is provided).
      if (classification === 'prefix' && onRefine && suffix) {
        items.push({
          type: 'refine',
          resource,
          vendorDescription: vendor.description,
          suffix,
          replaceSearch,
        })
        continue
      }

      let vendorAccounts = [...allAccounts.entries()]
        .filter(([_, { vendor: v }]) => v.displayName === vendor.description.displayName)
        .map(([id, data]) => ({ id, ...data }))

      if (accountsOnly && lowerSearch) {
        vendorAccounts = vendorAccounts.filter(account => {
          const corpus = [account.description.displayName, account.description.uniqueName]
            .filter(Boolean).join(' ').toLowerCase()
          return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
        })
      }
      if (accountsOnly && vendorAccounts.length === 0) continue

      for (const account of vendorAccounts) {
        items.push({
          type: 'account',
          accountId: account.id,
          vendorId: vendor.id,
          resource,
          accountDescription: account.description,
          vendorDescription: vendor.description,
        })
      }

      // "Connect new account" row (not shown in accountsOnly mode).
      if (!accountsOnly) {
        items.push({
          type: 'connect',
          vendorId: vendor.id,
          vendorDescription: vendor.description,
          resourceUrlPatterns: resource.grantable ? [resource.urlPattern] : undefined,
        })
      }
    }
    return items
  }, [matchedResources, allAccounts, lowerSearch, onRefine])

  const ready = !vendorsLoading && accountsLoaded

  // Nothing is selectable until the panel is showing a list, or a caller hiding it while it loads
  // would still activate rows by keyboard.
  useEffect(() => {
    onItems?.(ready ? selectableItems : [])
  }, [onItems, ready, selectableItems])

  useEffect(() => {
    onReadyChange?.(ready)
  }, [onReadyChange, ready])

  useEffect(() => {
    if (ready) sessionSnapshots.set(authenticatedApi, {vendors: allVendors, accounts: allAccounts})
  }, [allAccounts, allVendors, authenticatedApi, ready])

  // Expose an activate function so the parent can trigger selection by index.
  useEffect(() => {
    if (activateRef) {
      activateRef.current = (index: number) => {
        const item = selectableItems[index]
        if (!item) return
        if (item.type === 'refine') {
          if (onRefine) {
            const newUrl = buildRefineUrl(item.suffix, item.replaceSearch)
            const placeholders = getPlaceholderRanges(newUrl)
            if (placeholders.length > 0) {
              onRefine(newUrl, placeholders[0].start, placeholders[0].end)
            } else {
              onRefine(newUrl, newUrl.length, newUrl.length)
            }
          }
        } else if (item.type === 'account') {
          // Don't allow account activation if the URL still has placeholders.
          if (searchHasPlaceholders) return
          const accountData = allAccounts.get(item.accountId)
          if (accountData && !accountData.credentialsValid) {
            handleReconnect(item.accountId)
          } else {
            const missingGrants = missingResourceGrants(item.accountDescription, item.resource)
            if (missingGrants.length > 0) {
              if (grantingAccount !== item.accountId) {
                void handleGrantResourceAccess(item.accountId, missingGrants)
              }
            } else {
              onSelectAccount(item.accountId, item.vendorId, item.resource, item.accountDescription, item.vendorDescription)
            }
          }
        } else {
          handleConnectNew(item.vendorId, item.resourceUrlPatterns)
        }
      }
      return () => { activateRef.current = null }
    }
  })

  // --- Connect new account handler ---

  const handleConnectNew = async (vendorId: string, resourceUrlPatterns?: string[]) => {
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId, resourceUrlPatterns)
      window.open(result.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setConnectingVendor(null)
    }
  }

  // --- Grant additional resource access handler ---

  const handleGrantResourceAccess = useCallback(async (accountId: number, resourceUrlPatterns: string[]) => {
    if (resourceUrlPatterns.length === 0) return
    setGrantingAccount(accountId)
    try {
      const result = await authenticatedApi.ensureAccountResources(accountId, resourceUrlPatterns)
      if (result.url) {
        window.open(result.url, '_blank', 'noopener,noreferrer')
        toasts.add({ title: 'Grant the additional access in the new tab.', variant: 'success' })
      }
    } catch (error) {
      console.error('Failed to request additional access:', error)
      toasts.add({ title: 'Failed to request additional access', variant: 'error' })
    } finally {
      setGrantingAccount(current => current === accountId ? null : current)
    }
  }, [authenticatedApi, toasts])

  // --- Reconnect expired account handler ---

  const handleReconnect = useCallback(async (accountId: number) => {
    setReconnectingAccount(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      // The subscription will fire add() with credentialsValid: true when reconnect completes.
      // The reconnectingAccount state is cleared at that point.
    } catch (error) {
      console.error('Failed to initiate reconnection:', error)
      toasts.add({ title: 'Failed to start re-authentication flow', variant: 'error' })
      setReconnectingAccount(null)
    }
  }, [authenticatedApi])

  // --- Render ---

  // Two independent bounds, and the panel obeys whichever is tighter. The constant keeps it a
  // reasonable size even with room to spare; the caller's measurement keeps it inside the window,
  // since a constant is only ever a guess about how much room is above the composer -- on Home the
  // composer sits mid-page, and the panel grows upward.
  const maxHeight = Math.min(maxHeightOverride ?? Infinity, compact ? 220 : 400)

  return (
    <div style={style}>
      <div className="overflow-y-auto" style={{ maxHeight }}>
        {!ready ? (
          <p className={PICKER_EMPTY}>Loading connections…</p>
        ) : matchedResources.length === 0 ? (
          <p className={PICKER_EMPTY}>No matching resources.</p>
        ) : (() => {
          let itemIdx = 0
          return matchedResources.map(({ resource, vendor, classification, suffix, replaceSearch, accountsOnly }, i) => {
            // --- Prefix match: render as a single compact "refine" row ---
            if (classification === 'prefix' && onRefine && suffix) {
              const isActive = itemIdx === activeIndex
              itemIdx++
              return (
                <div
                  key={`${vendor.id}-${resource.urlPattern}`}
                  onClick={() => {
                    const newUrl = buildRefineUrl(suffix, replaceSearch)
                    const placeholders = getPlaceholderRanges(newUrl)
                    if (placeholders.length > 0) {
                      onRefine(newUrl, placeholders[0].start, placeholders[0].end)
                    } else {
                      onRefine(newUrl, newUrl.length, newUrl.length)
                    }
                  }}
                  className={`${PICKER_ROW} ${i > 0 ? 'border-t border-kumo-line' : ''} ${isActive ? PICKER_ROW_ACTIVE : ''}`}
                >
                  {/* The name is what the row is for, so it gets the space it needs first, up to
                    * 70% of the row; the pattern is a hint and yields. Reversing this (a pattern
                    * that never shrinks) left names as "Slac…" and "Google Ca…". Both can now
                    * truncate, so both carry their full text as a tooltip. */}
                  <span
                    title={resource.title}
                    className="max-w-[70%] flex-none truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default"
                  >
                    {resource.title}
                  </span>
                  <span
                    title={resource.urlPattern}
                    className="min-w-0 flex-1 truncate text-right font-mono text-[11.5px] leading-4 text-kumo-inactive"
                  >
                    {resource.urlPattern.replace(/^https?:\/\//, '')}
                  </span>
                  {isActive && <TabHint />}
                </div>
              )
            }

            // --- Full match or no-refine prefix: render with accounts ---
            let vendorAccounts = [...allAccounts.entries()]
              .filter(([_, { vendor: v }]) => v.displayName === vendor.description.displayName)
              .map(([id, data]) => ({ id, ...data }))

            // In accounts-only mode (HTTP alongside specific matches), only show
            // accounts whose details match the search.
            if (accountsOnly && lowerSearch) {
              vendorAccounts = vendorAccounts.filter(account => {
                const corpus = [account.description.displayName, account.description.uniqueName]
                  .filter(Boolean).join(' ').toLowerCase()
                return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
              })
            }

            if (accountsOnly && vendorAccounts.length === 0) return null

            const hostname = extractHostname(resource.urlPattern)

            return (
              <div key={`${vendor.id}-${resource.urlPattern}`} className={i > 0 ? 'border-t border-kumo-line' : ''}>
                <div className="flex items-baseline gap-2 px-3.5 pb-1 pt-2.5">
                  <span className={`flex-shrink-0 ${PICKER_CAPTION}`}>{resource.title}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-subtle">
                    {resource.description}
                  </span>
                </div>

                {/* Existing account rows */}
                {vendorAccounts.map(account => {
                  const isActive = itemIdx === activeIndex
                  itemIdx++
                  const isExpired = !account.credentialsValid
                  const isReconnecting = reconnectingAccount === account.id
                  const missingGrants = missingResourceGrants(account.description, resource)
                  const needsAccess = !isExpired && missingGrants.length > 0
                  const isGranting = grantingAccount === account.id
                  const accountRow = (
                    <div
                      onClick={() => {
                        if (searchHasPlaceholders) return
                        if (needsAccess) {
                          if (!isGranting) void handleGrantResourceAccess(account.id, missingGrants)
                        } else if (isExpired || isReconnecting) {
                          if (!isReconnecting) handleReconnect(account.id)
                        } else {
                          onSelectAccount(account.id, vendor.id, resource, account.description, vendor.description)
                        }
                      }}
                      className={`${PICKER_ROW} ${isActive ? PICKER_ROW_ACTIVE : ''} ${
                        ((isExpired && !isReconnecting) || needsAccess || searchHasPlaceholders) ? 'opacity-70' : ''
                      }`}
                      style={{
                        cursor: searchHasPlaceholders ? 'default' : (isReconnecting || isGranting) ? 'wait' : 'pointer',
                      }}
                    >
                      <GatekeeperIcon
                        vendorId={vendor.id}
                        logoUrl={vendor.description.logo?.url}
                        fallbackText={vendor.description.displayName}
                        size={14}
                        className="h-6 w-6 rounded-md"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
                          {account.description.uniqueName || account.description.displayName}
                        </span>
                        {hostname && hostname !== '*' && (
                          <span className="block truncate text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                            {hostname}
                          </span>
                        )}
                      </span>
                      {isReconnecting || isGranting ? (
                        <div className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
                      ) : isExpired ? (
                        <span className="flex flex-shrink-0 items-center gap-1">
                          <Warning size={12} className="text-kumo-warning" />
                          <span className="text-[11.5px] leading-4 text-kumo-warning">Expired — click to re-authenticate</span>
                        </span>
                      ) : needsAccess ? (
                        <span className="flex flex-shrink-0 items-center gap-1">
                          <Warning size={12} className="text-kumo-warning" />
                          <span className="text-[11.5px] leading-4 text-kumo-warning">Grant access</span>
                        </span>
                      ) : isActive && !searchHasPlaceholders ? (
                        <TabHint />
                      ) : (
                        <CaretRight size={12} className="flex-shrink-0 text-kumo-inactive" />
                      )}
                    </div>
                  )

                  if (searchHasPlaceholders) {
                    return (
                      <Tooltip key={account.id} content="Replace all placeholders in the URL before selecting an account" asChild>
                        {accountRow}
                      </Tooltip>
                    )
                  }
                  return <div key={account.id}>{accountRow}</div>
                })}

                {/* Connect new account */}
                {(() => {
                  if (accountsOnly) return null
                  const isActive = itemIdx === activeIndex
                  itemIdx++
                  return (
                  <div
                    onClick={() => !connectingVendor && handleConnectNew(vendor.id, resource.grantable ? [resource.urlPattern] : undefined)}
                    className={`${PICKER_ROW} ${isActive ? PICKER_ROW_ACTIVE : ''}`}
                    style={{
                      cursor: connectingVendor === vendor.id ? 'wait' : 'pointer',
                    }}
                  >
                    <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border border-dashed border-kumo-line text-kumo-inactive">
                      {connectingVendor === vendor.id ? (
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
                      ) : (
                        <Plus size={11} />
                      )}
                    </span>
                    <span className="flex-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
                      {connectingVendor === vendor.id ? 'Opening…' : 'Connect new account'}
                    </span>
                    {isActive && <TabHint />}
                  </div>
                  )
                })()}
              </div>
            )
          })
        })()}
      </div>
    </div>
  )
}
