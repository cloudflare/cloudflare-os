import { logRpcFailure } from './rpcErrors'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, useKumoToastManager, type PortalContainer } from '@cloudflare/kumo'
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Database,
  MagnifyingGlass,
  Robot,
  Sparkle,
  X,
} from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  AgentSpawnerConfig,
  AiChatAuthorInfo,
  GatekeeperClient,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { SupportedResource, VendorDescription, matchesResourceUrlPattern } from '@gadgets/workshop-shared/gatekeeper'
import { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import ResourceConfiguratorHost from './ResourceConfiguratorHost'
import {
  AgentSpawnerConfigForm,
  SpawnerEnvRow,
  spawnerEnvFromRows,
  validateSpawnerEnv,
} from './gatekeeper-modal/AgentSpawnerConfigForm'
import { AiModelConnectionConfig } from './gatekeeper-modal/AiModelConnectionConfig'
import { AccountChooser, AccountOption } from './gatekeeper-modal/AccountChooser'
import { matchesResourceUrl } from './resourceMatching'
import { reportIssue } from './errorReporting'
import { useSiteName } from './ServerConfigContext'
import { AccountsSubscriberAdapter } from './accountsSubscriber'

export interface GatekeeperModalProps {
  open: boolean
  onClose: () => void
  // Returns an overseer stub. Called only when actually creating a gatekeeper. This allows
  // the Home page to lazily provision a gadget on first use.
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>
  // Called after the gatekeeper is successfully created. The caller decides what to do with
  // the stub (e.g. assign a binding name, or insert a capsule). The modal awaits this callback
  // and shows a loading state while it runs.
  onCreated: (gk: RpcStub<GatekeeperClient<any>>) => Promise<void>
  // Workpieces offered as env entries when creating an agent spawner (see AgentSpawnerConfig.env),
  // normally the gadget the spawner is being created for plus that gadget's own bindings. All are
  // enabled by default, reproducing the pre-multi-gadget "spawned agents inherit everything"
  // behavior; the user may deselect or rename them. Empty (the default) means the spawner starts
  // with an empty env, which is all a context with no gadget can offer.
  spawnerEnvCandidates?: Omit<SpawnerEnvRow, 'enabled'>[]
  // Optional pre-seed: when the modal opens, auto-select the resource connection for this vendor.
  // Used by the agent's requestConnection accept flow so the user lands on the right connection with
  // minimal clicks. `initialResourceUrlPattern` is the exact SupportedResource.urlPattern the
  // backend resolved the request to (authoritative); `initialResourceUrl` is the raw URL the agent
  // supplied (used only as a fallback if the resolved pattern isn't present in the current list).
  initialVendorId?: string
  initialResourceUrl?: string
  initialResourceUrlPattern?: string
}

type ConnectionTypeId =
  | 'ai-model'
  | 'agent-spawner'
  | `resource:${string}:${string}`

type ConnectionType = {
  id: ConnectionTypeId
  vendorId?: string
  // Stable grouping key used by the picker to bucket connection types. For
  // resource connections this is the vendor's stable ID (so all of Google's
  // resources land in one group). Platform types use their own `id` so that
  // each is its own single-item group instead of merging by displayName.
  groupKey: string
  // Display name shown for the group; safe to localize/change without
  // affecting grouping behavior.
  groupLabel: string
  title: string
  vendor: string
  description: string
  icon?: typeof Database
  iconUrl?: string
  logoUrl?: string
  accent?: string
  // Fixed glyph color for icon-on-accent tiles. The `accent` background is a
  // hard-coded light color that doesn't flip with the theme, so a theme-aware
  // token like `text-kumo-strong` (near-white in dark mode) would vanish on it.
  // Pin the glyph to a dark color that reads on the light tile in both themes.
  iconColor?: string
  resourceUrlPattern?: string
  // Whether this resource type is independently grantable.
  grantable?: boolean
}

type VendorOption = {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

type ConfiguratorFrameState = {
  key: number
  frame: ResourceConfiguratorFrame
  accountId: number
  resourceUrlPattern: string
}

function platformConnectionTypes(siteName: string): ConnectionType[] {
  return [
  {
    id: 'ai-model',
    groupKey: 'platform:ai-model',
    groupLabel: 'AI Model',
    title: 'AI Model',
    vendor: siteName,
    description: 'Expose a selected model through this connection.',
    icon: Sparkle,
    accent: '#f6edff',
    iconColor: '#7c3aed',
  },
  {
    id: 'agent-spawner',
    groupKey: 'platform:agent-spawner',
    groupLabel: 'Agent',
    title: 'Agent',
    vendor: siteName,
    description: 'Allow this connection to start new AI agent conversations with selected tools.',
    icon: Robot,
    accent: '#f2f0ff',
    iconColor: '#7c3aed',
  },
  ]
}

function connectionForResource(vendor: VendorOption, resource: SupportedResource): ConnectionType {
  return {
    id: `resource:${vendor.id}:${resource.urlPattern}`,
    vendorId: vendor.id,
    // Group by stable vendor ID, not displayName, so two distinct vendors that
    // happen to share a display name don't get merged into the same group.
    groupKey: `vendor:${vendor.id}`,
    groupLabel: vendor.description.displayName,
    title: resource.title,
    vendor: vendor.description.displayName,
    description: resource.description,
    icon: Database,
    iconUrl: resource.icon?.url,
    logoUrl: vendor.description.logo?.url,
    accent: vendor.description.color,
    resourceUrlPattern: resource.urlPattern,
    grantable: Boolean(resource.grantable),
  }
}

// The grantable resource `urlPattern`s a connection requires before its configurator can load.
function requiredResourceUrlPatterns(connection: ConnectionType): string[] {
  return connection.grantable && connection.resourceUrlPattern
    ? [connection.resourceUrlPattern]
    : []
}

function accountSupportsConnection(account: AccountOption, connection: ConnectionType): boolean {
  return account.vendorId === connection.vendorId &&
    (!connection.resourceUrlPattern ||
      connection.resourceUrlPattern === 'https://*' ||
      account.supportedResources.some(resource => resource.urlPattern === connection.resourceUrlPattern))
}

function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null) {
  const uiDisposable = frame?.ui as any
  uiDisposable?.[Symbol.dispose]?.()
}

export default function GatekeeperModal({
  open, onClose, getOverseer, onCreated, spawnerEnvCandidates,
  initialVendorId, initialResourceUrl, initialResourceUrlPattern,
}: GatekeeperModalProps) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  const [selectedConnectionId, setSelectedConnectionId] = useState<ConnectionTypeId | null>(null)
  const [searchText, setSearchText] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [grantingAccountId, setGrantingAccountId] = useState<number | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [vendors, setVendors] = useState<VendorOption[]>([])

  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>()

  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [configuratorFrameState, setConfiguratorFrameState] = useState<ConfiguratorFrameState | null>(null)
  const [configuratorLoading, setConfiguratorLoading] = useState(false)
  const [configuratorError, setConfiguratorError] = useState<string | null>(null)
  const [configuratorSelectionReady, setConfiguratorSelectionReady] = useState<boolean | null>(null)
  const [dialogMinHeight, setDialogMinHeight] = useState(0)
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const [selectPortalContainer, setSelectPortalContainer] = useState<PortalContainer>(null)

  const [spawnerDisplayName, setSpawnerDisplayName] = useState('')
  const [spawnerModelId, setSpawnerModelId] = useState<string | null>(null)
  const [spawnerEnv, setSpawnerEnv] = useState<SpawnerEnvRow[]>([])
  const spawnerEnvError = validateSpawnerEnv(spawnerEnv)

  // Read only when the modal opens, so a caller that rebuilds the candidate array on every render
  // doesn't clobber the user's edits.
  const spawnerEnvCandidatesRef = useRef(spawnerEnvCandidates)
  spawnerEnvCandidatesRef.current = spawnerEnvCandidates

  const accountSubscriptionRef = useRef<{ [Symbol.dispose](): void } | null>(null)
  const configuratorFrameRef = useRef<ConfiguratorFrameState | null>(null)
  const configuratorCollectResourceUrlRef = useRef<(() => Promise<string>) | null>(null)
  const nextConfiguratorFrameKeyRef = useRef(0)

  useEffect(() => {
    const el = document.createElement('div')
    el.style.position = 'relative'
    el.style.zIndex = '1100'
    document.body.appendChild(el)
    setSelectPortalContainer(el)
    return () => {
      setSelectPortalContainer(null)
      el.remove()
    }
  }, [])

  const updateConfiguratorFrameState = (next: ConfiguratorFrameState | null) => {
    const previous = configuratorFrameRef.current
    if (previous?.frame !== next?.frame) disposeConfiguratorFrame(previous?.frame ?? null)
    configuratorFrameRef.current = next
    if (!next) {
      configuratorCollectResourceUrlRef.current = null
      setConfiguratorSelectionReady(null)
    }
    setConfiguratorFrameState(next)
  }

  const handleConfiguratorCollectResourceUrlChange = useCallback((collect: (() => Promise<string>) | null) => {
    configuratorCollectResourceUrlRef.current = collect
  }, [])

  const siteName = useSiteName()
  const allConnections = useMemo(() => [
    ...platformConnectionTypes(siteName),
    ...vendors.flatMap(vendor => vendor.supportedResources
      .map(resource => connectionForResource(vendor, resource))),
  ], [siteName, vendors])

  const selectedConnection = useMemo(
    () => allConnections.find(connection => connection.id === selectedConnectionId) ?? null,
    [allConnections, selectedConnectionId],
  )

  // Pre-seed the selection for the agent requestConnection accept flow. Runs once per open after
  // vendors load and nothing is selected yet.
  //
  // The backend authoritatively resolved the request to a specific resource and passes its
  // urlPattern as initialResourceUrlPattern, so we select that exact resource — this can't diverge
  // from the backend's validation, which guarantees the request resolved to something. The
  // initialResourceUrl / catch-all / sole-resource branches are defensive fallbacks (e.g. an older
  // message without a resolved pattern, or the resource list having shifted since the request).
  useEffect(() => {
    if (!open || !initialVendorId || selectedConnectionId !== null) return
    const vendorConnections = allConnections.filter(c => c.vendorId === initialVendorId)
    if (vendorConnections.length === 0) return  // vendors may not be loaded yet

    let match: ConnectionType | undefined
    if (initialResourceUrlPattern) {
      // Authoritative: select the exact resource the backend resolved to.
      match = vendorConnections.find(c => c.resourceUrlPattern === initialResourceUrlPattern)
    }
    if (!match && initialResourceUrl) {
      // Fallback: match the raw URL. Skip the catch-all here so a specific resource type wins
      // (mirrors the backend); matchesResourceUrlPattern tolerates trailing-slash differences.
      match = vendorConnections.find(c =>
        !!c.resourceUrlPattern &&
        c.resourceUrlPattern !== 'https://*' &&
        matchesResourceUrlPattern(c.resourceUrlPattern, initialResourceUrl))
    }
    // Still nothing: prefer the whole-instance catch-all ("https://*") if offered (e.g. Home
    // Assistant), else the sole resource type if there's just one.
    match = match
      ?? vendorConnections.find(c => c.resourceUrlPattern === 'https://*')
      ?? (vendorConnections.length === 1 ? vendorConnections[0] : undefined)
    if (match) setSelectedConnectionId(match.id)
  }, [open, initialVendorId, initialResourceUrl, initialResourceUrlPattern, allConnections, selectedConnectionId])

  useEffect(() => {
    return () => {
      disposeConfiguratorFrame(configuratorFrameRef.current?.frame ?? null)
      configuratorFrameRef.current = null
    }
  }, [])

  // Keep the resource configurator visible while still allowing the modal to scroll in short viewports.
  useEffect(() => {
    if (!open || !selectedConnection?.resourceUrlPattern) {
      setDialogMinHeight(0)
      return
    }
    let frame = 0
    const recompute = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const header = headerRef.current?.getBoundingClientRect().height ?? 0
        const footer = footerRef.current?.getBoundingClientRect().height ?? 0
        const scroll = scrollRef.current
        const scrollContent = scrollContentRef.current
        if (!scroll || !scrollContent) return setDialogMinHeight(0)
        const scrollStyle = getComputedStyle(scroll)
        const scrollPadding = parseFloat(scrollStyle.paddingTop) + parseFloat(scrollStyle.paddingBottom)
        const requested = header + footer + scrollContent.getBoundingClientRect().height + scrollPadding
        // Cap at the viewport-derived max-height so we don't push the dialog off-screen.
        const top = Math.max(28, Math.min(96, window.innerHeight * 0.1))
        const maxAvailable = (window.innerHeight - top - 28) * 0.9
        setDialogMinHeight(Math.ceil(Math.min(requested, maxAvailable)))
      })
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    if (scrollContentRef.current) ro.observe(scrollContentRef.current)
    const onWindowResize = () => recompute()
    window.addEventListener('resize', onWindowResize)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [open, selectedConnectionId])

  useEffect(() => {
    if (!open) {
      // Reset the selection on close so reopening (e.g. for a different connection request) starts
      // clean and the pre-seed effect below can run again.
      setSelectedConnectionId(null)
      updateConfiguratorFrameState(null)
      setConfiguratorLoading(false)
      setConfiguratorError(null)
      setConfiguratorSelectionReady(null)
      return
    }

    let cancelled = false

    setSelectedConnectionId(null)
    setSearchText('')
    setExpandedGroups(new Set())
    setCreating(false)
    setConnectingVendor(null)
    setReconnectingAccountId(null)
    setVendors([])
    setSelectedAccountId(null)
    updateConfiguratorFrameState(null)
    setConfiguratorLoading(false)
    setConfiguratorError(null)
    setConfiguratorSelectionReady(null)
    setSelectedModelId(undefined)
    setSpawnerDisplayName('')
    setSpawnerModelId(null)
    setSpawnerEnv(
      (spawnerEnvCandidatesRef.current ?? []).map(entry => ({ ...entry, enabled: true })))

    authenticatedApi.listModels().then(models => {
      if (cancelled) return
      setAvailableModels(models)
      if (models.length > 0) {
        setSelectedModelId(models[0].id)
        const lastSelected = localStorage.getItem('lastSelectedModel')
        if (lastSelected && models.some(m => m.id === lastSelected)) {
          setSpawnerModelId(lastSelected)
        } else {
          setSpawnerModelId(models[0].id)
        }
      }
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load models:', err)
      reportIssue('gatekeeper.models-load', err)
      toasts.add({ title: "Couldn't load AI models", variant: 'error' })
    })

    authenticatedApi.listGatekeeperVendors().then(vendors => {
      if (cancelled) return
      setVendors(vendors)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load connection vendors:', err)
      reportIssue('gatekeeper.vendors-load', err)
      toasts.add({ title: "Couldn't load connection options", variant: 'error' })
    })

    return () => {
      cancelled = true
    }
  }, [open, authenticatedApi])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const accountMap = new Map<number, AccountOption>()

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        accountMap.set(id, { id, description, vendorId, vendorDescription: vendor, supportedResources, credentialsValid })
        setAccounts(Array.from(accountMap.values()))
      },
      remove(id) {
        if (cancelled) return
        accountMap.delete(id)
        setAccounts(Array.from(accountMap.values()))
      },
    })
    authenticatedApi.subscribeConnectedAccounts(subscriber)
      .then(stub => {
        if (cancelled) {
          stub[Symbol.dispose]()
        } else {
          accountSubscriptionRef.current = stub
        }
      })
      .catch(error => {
        logRpcFailure('Failed to subscribe to connected accounts:', error)
      })

    return () => {
      cancelled = true
      accountSubscriptionRef.current?.[Symbol.dispose]()
      accountSubscriptionRef.current = null
    }
  }, [open, authenticatedApi])

  useEffect(() => {
    setSelectedAccountId(null)
    updateConfiguratorFrameState(null)
    setConfiguratorLoading(false)
    setConfiguratorError(null)
    setConfiguratorSelectionReady(null)
  }, [selectedConnectionId])

  const filteredConnections = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return allConnections
    return allConnections.filter(connection => {
      const haystack = [
        connection.title,
        connection.vendor,
        connection.description,
      ].join(' ').toLowerCase()
      const matchesText = query.split(/\s+/).every(token => haystack.includes(token))
      const matchesUrl = query.length >= 3 &&
        connection.resourceUrlPattern !== undefined &&
        connection.resourceUrlPattern !== 'https://*' &&
        matchesResourceUrl(query, connection.resourceUrlPattern)
      return matchesText || matchesUrl
    })
  }, [allConnections, searchText])

  // Group connections by stable vendor key (e.g. all Google resources together).
  // Preserves the order in which a vendor's first item appears in the flat list.
  // Used to render a collapsible, grouped picker when the search box is empty.
  // Platform types (AI Model, Agent) each have their own unique groupKey so
  // they remain single-item leaves rather than collapsing into one bucket
  // named after the site.
  const groupedConnections = useMemo(() => {
    const groups = new Map<string, { label: string; items: ConnectionType[] }>()
    for (const connection of allConnections) {
      const key = connection.groupKey
      const existing = groups.get(key)
      if (existing) existing.items.push(connection)
      else groups.set(key, { label: connection.groupLabel, items: [connection] })
    }
    return Array.from(groups.entries()).map(([key, { label, items }]) => ({ key, label, items }))
  }, [allConnections])

  const isSearching = searchText.trim().length > 0

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const matchingAccounts = useMemo(() => {
    if (!selectedConnection?.vendorId) return []
    return accounts.filter(account => accountSupportsConnection(account, selectedConnection))
  }, [accounts, selectedConnection])

  const selectedAccount = matchingAccounts.find(
    account => account.id === selectedAccountId && account.credentialsValid,
  ) ?? null
  const needsAccount = Boolean(selectedConnection?.vendorId)

  // When the agent's request supplied a concrete resource URL that matches the selected resource
  // type's pattern, pass it to the configurator so its form opens pre-filled (and editable). This
  // is general across gatekeepers: the iframe runtime seeds the form from the URL (via the
  // configurator's initialValuesFromResourceUrl hook, or a URLPattern-group fallback). Excludes the
  // whole-instance catch-all, which has no per-resource inputs.
  const prefilledResourceUrl = useMemo(() => {
    const pattern = selectedConnection?.resourceUrlPattern
    if (!pattern || pattern === 'https://*' || !initialResourceUrl) return null
    return matchesResourceUrlPattern(pattern, initialResourceUrl) ? initialResourceUrl : null
  }, [selectedConnection?.resourceUrlPattern, initialResourceUrl])

  // Grantable resources the chosen connection needs that the selected account hasn't granted yet.
  // Until these are granted, the resource configurator can't load and the binding can't be created
  // -- so we surface a focused "grant access" step instead. (An undefined granted set means a
  // legacy account predating grant tracking; treat it as fully granted.)
  const missingResourceUrlPatterns = useMemo(() => {
    const required = selectedConnection ? requiredResourceUrlPatterns(selectedConnection) : []
    if (!required.length || !selectedAccount) return []
    const granted = selectedAccount.description.grantedResourceUrlPatterns
    if (granted === undefined) return []
    return required.filter(p => !granted.includes(p))
  }, [selectedConnection, selectedAccount])
  const hasMissingResourceGrants = missingResourceUrlPatterns.length > 0

  useEffect(() => {
    if (!selectedConnection?.vendorId) return
    const currentIsValid = selectedAccountId !== null
      && matchingAccounts.some(account => account.id === selectedAccountId && account.credentialsValid)
    if (currentIsValid) return
    const firstValidAccount = matchingAccounts.find(account => account.credentialsValid)
    setSelectedAccountId(firstValidAccount?.id ?? null)
  }, [selectedConnection, matchingAccounts, selectedAccountId])

  useEffect(() => {
    const resourceUrlPattern = selectedConnection?.resourceUrlPattern ?? null
    if (!open || !resourceUrlPattern || !selectedAccount || hasMissingResourceGrants) {
      updateConfiguratorFrameState(null)
      setConfiguratorError(null)
      setConfiguratorLoading(false)
      setConfiguratorSelectionReady(null)
      return
    }

    let cancelled = false
    setConfiguratorLoading(true)
    updateConfiguratorFrameState(null)
    setConfiguratorError(null)
    setConfiguratorSelectionReady(null)

    authenticatedApi.startResourceConfigurator(selectedAccount.id, resourceUrlPattern)
      .then(frame => {
        if (cancelled) {
          disposeConfiguratorFrame(frame)
          return
        }
        updateConfiguratorFrameState({
          key: ++nextConfiguratorFrameKeyRef.current,
          frame,
          accountId: selectedAccount.id,
          resourceUrlPattern,
        })
      })
      .catch(error => {
        console.error('Failed to start resource configurator:', error)
        if (!cancelled) {
          reportIssue('gatekeeper.configurator-start', error, {
            gatekeeperVendorId: selectedConnection?.vendorId,
          })
          setConfiguratorError(error?.message || 'Could not start configurator.')
        }
      })
      .finally(() => {
        if (!cancelled) setConfiguratorLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, authenticatedApi, selectedConnection?.id, selectedConnection?.resourceUrlPattern, selectedAccount?.id, hasMissingResourceGrants])

  const handleSelectConnection = (connection: ConnectionType) => {
    setSelectedConnectionId(connection.id)
    if (!connection.vendorId) return
    const firstValidAccount = accounts.find(account => account.credentialsValid && accountSupportsConnection(account, connection))
    if (firstValidAccount) setSelectedAccountId(firstValidAccount.id)
    else setSelectedAccountId(null)
  }

  const handleConnectAccount = async (vendorId: string, resourceUrlPatterns?: string[]) => {
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId, resourceUrlPatterns)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account connection in the new tab.', variant: 'success' })
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      reportIssue('gatekeeper.connect-start', error, { gatekeeperVendorId: vendorId })
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setConnectingVendor(null)
    }
  }

  const handleGrantResourceAccess = async (accountId: number) => {
    const required = selectedConnection ? requiredResourceUrlPatterns(selectedConnection) : []
    if (!required.length) return
    const account = matchingAccounts.find(a => a.id === accountId)
    const granted = account?.description.grantedResourceUrlPatterns
    const missing = granted === undefined ? [] : required.filter(p => !granted.includes(p))
    if (missing.length === 0) return
    setGrantingAccountId(accountId)
    try {
      const result = await authenticatedApi.ensureAccountResources(accountId, missing)
      if (result.url) {
        window.open(result.url, '_blank', 'noopener,noreferrer')
        toasts.add({ title: 'Grant the additional access in the new tab.', variant: 'success' })
      }
      // The new grant arrives via subscribeConnectedAccounts(); the account's flag then clears and
      // the configurator loads automatically.
    } catch (error) {
      console.error('Failed to request additional access:', error)
      reportIssue('gatekeeper.resource-grant', error, {
        gatekeeperVendorId: selectedConnection?.vendorId,
      })
      toasts.add({ title: 'Failed to request additional access', variant: 'error' })
    } finally {
      setGrantingAccountId(null)
    }
  }

  const handleReconnectAccount = async (accountId: number) => {
    setReconnectingAccountId(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account reconnect in the new tab.', variant: 'success' })
    } catch (error) {
      console.error('Failed to initiate reconnect:', error)
      reportIssue('gatekeeper.reconnect-start', error, {
        gatekeeperVendorId: selectedConnection?.vendorId,
      })
      toasts.add({ title: 'Failed to start reconnect flow', variant: 'error' })
    } finally {
      setReconnectingAccountId(null)
    }
  }

  const handleCreateAiModel = async () => {
    if (!selectedModelId) {
      toasts.add({ title: 'Please select an AI model', variant: 'warning' })
      return
    }
    setCreating(true)
    let gatekeeper: RpcStub<GatekeeperClient<any>> | null = null
    let transferred = false
    try {
      const overseer = await getOverseer()
      gatekeeper = await overseer.newAiModelGatekeeper(selectedModelId)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        transferred = true
        onClose()
      } else {
        toasts.add({ title: 'Failed to create AI model connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create AI model gatekeeper:', err)
      toasts.add({ title: 'Failed to create AI model connection', variant: 'error' })
    } finally {
      if (gatekeeper && !transferred) gatekeeper[Symbol.dispose]()
      setCreating(false)
    }
  }

  const handleCreateAgentSpawner = async () => {
    if (!spawnerDisplayName.trim()) {
      toasts.add({ title: 'Please enter a display name', variant: 'warning' })
      return
    }
    if (spawnerEnvError) {
      toasts.add({ title: spawnerEnvError, variant: 'warning' })
      return
    }
    const config: AgentSpawnerConfig = {
      displayName: spawnerDisplayName.trim(),
      modelId: spawnerModelId,
      env: spawnerEnvFromRows(spawnerEnv),
    }

    setCreating(true)
    let gatekeeper: RpcStub<GatekeeperClient<any>> | null = null
    let transferred = false
    try {
      const overseer = await getOverseer()
      gatekeeper = await overseer.newAgentSpawnerGatekeeper(config)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        transferred = true
        onClose()
      } else {
        toasts.add({ title: 'Failed to create agent spawner connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create agent spawner gatekeeper:', err)
      toasts.add({ title: 'Failed to create agent spawner connection', variant: 'error' })
    } finally {
      if (gatekeeper && !transferred) gatekeeper[Symbol.dispose]()
      setCreating(false)
    }
  }

  const handleCreateResourceConnection = async () => {
    if (creating) return
    if (!selectedConnection || selectedAccountId === null) return
    const resourceUrlPattern = selectedConnection.resourceUrlPattern
    if (!resourceUrlPattern) return

    setCreating(true)
    let gatekeeper: RpcStub<GatekeeperClient<any>> | null = null
    let transferred = false
    try {
      if (!configuratorFrameState?.frame || configuratorFrameState.accountId !== selectedAccountId || configuratorFrameState.resourceUrlPattern !== resourceUrlPattern) {
        throw new Error('Configurator is not ready.')
      }
      const resourceUrl = await configuratorCollectResourceUrlRef.current?.()
      if (!resourceUrl) throw new Error('Configurator did not provide a resource URL.')
      const overseer = await getOverseer()
      gatekeeper = await overseer.newGatekeeper(selectedAccountId, resourceUrl)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        transferred = true
        onClose()
      } else {
        toasts.add({ title: 'Failed to create connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create resource gatekeeper:', err)
      toasts.add({ title: err instanceof Error && err.message ? err.message : 'Failed to create connection', variant: 'error' })
    } finally {
      if (gatekeeper && !transferred) gatekeeper[Symbol.dispose]()
      setCreating(false)
    }
  }

  const canCreate = (() => {
    if (!selectedConnection) return false
    if (selectedConnection.id === 'ai-model') return Boolean(selectedModelId)
    if (selectedConnection.id === 'agent-spawner') {
      return Boolean(spawnerDisplayName.trim()) && !spawnerEnvError
    }
    if (selectedConnection.resourceUrlPattern) {
      const resourceUrlPattern = selectedConnection.resourceUrlPattern
      return Boolean(
        selectedAccountId !== null &&
        resourceUrlPattern &&
        configuratorFrameState?.frame &&
        configuratorFrameState.accountId === selectedAccountId &&
        configuratorFrameState.resourceUrlPattern === resourceUrlPattern &&
        configuratorSelectionReady !== false &&
        !hasMissingResourceGrants,
      )
    }
    return false
  })()

  const handleCreate = () => {
    if (!selectedConnection) return
    if (selectedConnection.id === 'ai-model') {
      handleCreateAiModel()
    } else if (selectedConnection.id === 'agent-spawner') {
      handleCreateAgentSpawner()
    } else if (selectedConnection.resourceUrlPattern) {
      handleCreateResourceConnection()
    }
  }

  const createLabel = selectedConnection?.resourceUrlPattern
    ? 'Add connection'
    : 'Create connection'

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="!z-[1000] !top-[clamp(28px,10vh,96px)] !flex !max-h-[calc((100vh_-_clamp(28px,10vh,96px)_-_28px)_*_0.9)] !w-[min(760px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0"
        style={dialogMinHeight > 0 ? { minHeight: `${dialogMinHeight}px` } : undefined}
        size="lg"
      >
        <div ref={headerRef} className="shrink-0 flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
              {selectedConnection ? selectedConnection.title : 'Create New Connection'}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              {selectedConnection
                ? selectedConnection.description
                : 'Choose what this gadget should be able to use.'}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        {selectedConnection ? (
          <div ref={scrollRef} className="new-gatekeeper-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div ref={scrollContentRef}>
              <button
                type="button"
                onClick={() => setSelectedConnectionId(null)}
                className="mb-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:text-kumo-default"
              >
                <CaretLeft size={13} />
                All connection types
              </button>

              <div className="space-y-4">
                {needsAccount && (
                  <AccountChooser
                    accounts={matchingAccounts}
                    selectedAccountId={selectedAccountId}
                    vendorId={selectedConnection.vendorId}
                    vendorName={selectedConnection.vendor}
                    resourceTitle={selectedConnection.resourceUrlPattern ? selectedConnection.title : undefined}
                    connecting={connectingVendor === selectedConnection.vendorId}
                    reconnectingAccountId={reconnectingAccountId}
                    requiredResourceUrlPatterns={requiredResourceUrlPatterns(selectedConnection)}
                    grantingAccountId={grantingAccountId}
                    onSelect={setSelectedAccountId}
                    onConnect={() => {
                      if (!selectedConnection.vendorId) return
                      const required = requiredResourceUrlPatterns(selectedConnection)
                      // No grantable requirement -> request authorization for everything
                      handleConnectAccount(selectedConnection.vendorId, required.length ? required : undefined)
                    }}
                    onReconnect={handleReconnectAccount}
                    onGrantAccess={handleGrantResourceAccess}
                  />
                )}

                {selectedConnection.resourceUrlPattern && !hasMissingResourceGrants && (
                  <ResourceConfiguratorHost
                    frame={configuratorFrameState?.frame ?? null}
                    frameKey={configuratorFrameState?.key ?? null}
                    loading={configuratorLoading}
                    error={configuratorError}
                    disabled={needsAccount && !selectedAccount}
                    onCollectResourceUrlChange={handleConfiguratorCollectResourceUrlChange}
                    onSelectionReadyChange={setConfiguratorSelectionReady}
                    initialResourceUrl={prefilledResourceUrl ?? undefined}
                    resourceUrlPattern={selectedConnection.resourceUrlPattern}
                  />
                )}

                {selectedConnection.id === 'ai-model' && (
                  <AiModelConnectionConfig
                    availableModels={availableModels}
                    selectedModelId={selectedModelId}
                    onSelectedModelIdChange={setSelectedModelId}
                    selectContainer={selectPortalContainer}
                  />
                )}

                {selectedConnection.id === 'agent-spawner' && (
                  <AgentSpawnerConfigForm
                    availableModels={availableModels}
                    displayName={spawnerDisplayName}
                    modelId={spawnerModelId}
                    env={spawnerEnv}
                    envError={spawnerEnvError}
                    onDisplayNameChange={setSpawnerDisplayName}
                    onModelIdChange={setSpawnerModelId}
                    onEnvChange={setSpawnerEnv}
                    selectContainer={selectPortalContainer}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-kumo-line bg-kumo-base px-5 py-4">
              <div className="relative">
                <MagnifyingGlass size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
                <input
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="Search services, apps, data sources..."
                  autoFocus
                  className="h-10 w-full rounded-xl border border-kumo-line bg-kumo-base pl-9 pr-3 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none outline-none transition-[border-color,box-shadow] focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/10"
                />
              </div>
            </div>

            <div className="new-gatekeeper-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                {isSearching ? (
                  filteredConnections.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                      No matching connection types.
                    </div>
                  ) : filteredConnections.map((connection, index) => (
                    <ConnectionTypeRow
                      key={connection.id}
                      connection={connection}
                      first={index === 0}
                      onClick={() => handleSelectConnection(connection)}
                    />
                  ))
                ) : (
                  groupedConnections.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                      No connection types available.
                    </div>
                  ) : groupedConnections.map((group, index) => (
                    <ConnectionGroupRow
                      key={group.key}
                      groupKey={group.key}
                      label={group.label}
                      items={group.items}
                      first={index === 0}
                      expanded={expandedGroups.has(group.key)}
                      onToggle={toggleGroup}
                      onSelectItem={handleSelectConnection}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {selectedConnection && (
          <div ref={footerRef} className="shrink-0 flex items-center justify-between gap-3 border-t border-kumo-line px-5 py-3">
            <div />
            <div className="flex shrink-0 items-center gap-2">
              <WorkshopButton onClick={() => setSelectedConnectionId(null)} disabled={creating} className="!h-9">
                Back
              </WorkshopButton>
              <WorkshopButton
                tone="primary"
                onClick={handleCreate}
                disabled={!canCreate || creating}
              >
                {creating ? 'Creating...' : createLabel}
              </WorkshopButton>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}

function ConnectionTypeRow({
  connection,
  first,
  onClick,
}: {
  connection: ConnectionType
  first: boolean
  onClick: () => void
}) {
  const Icon = connection.icon
  const iconUrl = connection.iconUrl ?? connection.logoUrl

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-kumo-elevated ${first ? '' : 'border-t border-kumo-line'}`}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-kumo-elevated"
        style={connection.accent ? { backgroundColor: connection.accent } : undefined}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-6 w-6 object-contain" />
        ) : Icon ? (
          <Icon
            size={19}
            weight="duotone"
            className={connection.iconColor ? undefined : 'text-kumo-strong'}
            style={connection.iconColor ? { color: connection.iconColor } : undefined}
          />
        ) : (
          <Database size={19} weight="duotone" className="text-kumo-strong" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
          {connection.title}
        </p>
        <p className="mt-0.5 line-clamp-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          {connection.vendor} · {connection.description}
        </p>
      </div>
      <CaretRight size={14} className="shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5 group-hover:text-kumo-default" />
    </button>
  )
}

function ConnectionGroupRow({
  groupKey,
  label,
  items,
  first,
  expanded,
  onToggle,
  onSelectItem,
}: {
  groupKey: string
  label: string
  items: ConnectionType[]
  first: boolean
  expanded: boolean
  onToggle: (key: string) => void
  onSelectItem: (connection: ConnectionType) => void
}) {
  // Defensive: the grouping memo guarantees every group has >= 1 item, but the
  // prop type can't express that. Bail out if the invariant is ever violated.
  if (items.length === 0) return null

  // Every group renders as a collapsible accordion, even when it has a single
  // child — this gives the picker a consistent visual rhythm and makes the
  // structure (vendor → services) explicit at every level.
  const handleClick = () => onToggle(groupKey)
  const panelId = `connection-group-panel-${groupKey}`

  // Use the first item as a representative for the group's icon/logo. Within a
  // group every item shares the same vendorId so the logo is consistent.
  const representative = items[0]
  const Icon = representative.icon
  const iconUrl = representative.logoUrl

  // For single-item groups the joined-titles string would just repeat the
  // group label (e.g. "AI Model"), so fall back to the richer vendor +
  // description subtitle used in the flat search results.
  const subtitle = items.length === 1
    ? `${representative.vendor} · ${representative.description}`
    : items.map(item => item.title).join(', ')

  return (
    <div className={first ? '' : 'border-t border-kumo-line'}>
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="group flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-kumo-elevated"
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-kumo-elevated"
          style={representative.accent ? { backgroundColor: representative.accent } : undefined}
        >
          {iconUrl ? (
            <img src={iconUrl} alt="" className="h-6 w-6 object-contain" />
          ) : Icon ? (
            <Icon
              size={19}
              weight="duotone"
              className={representative.iconColor ? undefined : 'text-kumo-strong'}
              style={representative.iconColor ? { color: representative.iconColor } : undefined}
            />
          ) : (
            <Database size={19} weight="duotone" className="text-kumo-strong" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </p>
          <p className="mt-0.5 line-clamp-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {subtitle}
          </p>
        </div>
        <CaretDown
          size={14}
          className={`shrink-0 text-kumo-inactive transition-transform group-hover:text-kumo-default ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div id={panelId} className="border-t border-kumo-line bg-kumo-elevated/30">
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectItem(item)}
              className="group flex w-full cursor-pointer items-center gap-3 border-t border-kumo-line/60 pl-10 pr-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-kumo-elevated"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-kumo-base">
                {item.iconUrl ? (
                  <img src={item.iconUrl} alt="" className="h-full w-full object-cover" />
                ) : item.icon ? (
                  <item.icon size={14} weight="duotone" className="text-kumo-strong" />
                ) : (
                  <Database size={14} weight="duotone" className="text-kumo-strong" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                  {item.title}
                </p>
                <p className="mt-0.5 line-clamp-1 text-[11.5px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                  {item.description}
                </p>
              </div>
              <CaretRight size={13} className="shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5 group-hover:text-kumo-default" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
