import { logRpcFailure } from './rpcErrors'
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi, AdminApi, BlueprintPublicInfo, BlueprintBinding, BlueprintBindingAssignment, BlueprintUserSummary, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { SupportedResource, VendorDescription, ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { Button, Dialog, DropdownMenu, Select, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowsOutSimple, ArrowLeft, ArrowSquareOut, DotsThree, DownloadSimple, Lightning, Plus, Robot, Sparkle, Star, Trash, X } from '@phosphor-icons/react'

import { useAuth } from './useAuth'
import LoginPage from './LoginPage'
import { normalizeResourceUrl } from './resourceMatching'
import {
  BLUEPRINT_ARCHIVE_EXTENSION,
  makeBlueprintFilename,
  saveStreamToFile,
} from './fileTransfers'
import { AccountChooser, AccountOption } from './gatekeeper-modal/AccountChooser'
import ResourceConfiguratorHost from './ResourceConfiguratorHost'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER } from './components/menuStyles'
import { useDocumentTitle } from './useDocumentTitle'
import { AccountsSubscriberAdapter } from './accountsSubscriber'

interface Props {
  rpcStub: RpcStub<PublicApi>
}

// Using `any` for form state to avoid complex discriminated union issues with spread.
type BindingFormState = Record<string, any>
const NO_AGENT_MODEL_ID = 'gadgets:sentinel:no-agent-model'

export default function BlueprintLandingPage({ rpcStub }: Props) {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id ?? ''
  const navigate = useNavigate()
  const router = useRouter()
  const { isAuthenticated, authenticatedApi, isLoading: authLoading, login } = useAuth(rpcStub)
  const toasts = useKumoToastManager()

  const [blueprint, setBlueprint] = useState<BlueprintPublicInfo | null>(null)
  useDocumentTitle(blueprint?.metadata.title)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [activeBindingName, setActiveBindingName] = useState<string | null>(null)
  const [bindingForm, setBindingForm] = useState<BindingFormState>({})
  const [draftAssignments, setDraftAssignments] = useState<Record<string, BlueprintBindingAssignment>>({})
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [showLogin, setShowLogin] = useState(false)

  // Vendor catalog + connected accounts, shared by all gatekeeper bindings during configure.
  const [vendors, setVendors] = useState<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]>([])
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)

  // Per-binding readiness flags reported by configurator iframes. A gatekeeper binding can be
  // submitted only when the iframe reports `setSelectionReady(true)` and an account is chosen.
  const [gatekeeperReady, setGatekeeperReady] = useState<Record<string, boolean>>({})

  // Per-binding URL collector functions exposed by each gatekeeper configurator iframe. We call
  // these at submit time to capture the chosen resource URL.
  const collectorsRef = useRef<Map<string, () => Promise<string>>>(new Map())
  const selectPortalRef = useRef<HTMLDivElement>(null)
  const [canManageFeatured, setCanManageFeatured] = useState(false)
  const [isFeatured, setIsFeatured] = useState(false)
  const [updatingFeatured, setUpdatingFeatured] = useState(false)
  // Admin capability (null for non-admins), minted once and reused for the feature toggle. Wrapped
  // in an object so the stub isn't mistaken for a state updater function. Disposed on cleanup.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [isInLibrary, setIsInLibrary] = useState(false)
  const [isUploadedBlueprint, setIsUploadedBlueprint] = useState(false)
  const [loadingLibraryState, setLoadingLibraryState] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [updatingPinned, setUpdatingPinned] = useState(false)
  const [isOwnBlueprint, setIsOwnBlueprint] = useState(false)
  const [ownBlueprintSummary, setOwnBlueprintSummary] = useState<BlueprintUserSummary | null>(null)
  const [loadingOwnBlueprintState, setLoadingOwnBlueprintState] = useState(false)
  const [addingToLibrary, setAddingToLibrary] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [removingFromLibrary, setRemovingFromLibrary] = useState(false)
  const vendorById = useMemo(
    () => new Map(vendors.map(v => [v.id.toLowerCase(), v])),
    [vendors],
  )
  // Fetch blueprint metadata.
  useEffect(() => {
    if (!id) {
      setLoading(false)
      setNotFound(true)
      return
    }
    setLoading(true)
    setNotFound(false)
    setError(null)

    rpcStub.getBlueprint(id).then(result => {
      if (result) {
        setBlueprint(result)
      } else {
        setNotFound(true)
      }
    }).catch(err => {
      setError(err.message || 'Failed to load blueprint.')
    }).finally(() => {
      setLoading(false)
    })
  }, [id, rpcStub])

  useEffect(() => {
    setActiveBindingName(null)
    setBindingForm({})
    setDraftAssignments({})
    setGatekeeperReady({})
    collectorsRef.current.clear()
  }, [id])

  // When authenticated, fetch models for binding assignment.
  useEffect(() => {
    if (isAuthenticated && authenticatedApi) {
      authenticatedApi.listModels()
        .then(setModels)
        .catch(err => logRpcFailure('Failed to load models:', err))
    } else {
      setModels([])
    }
  }, [isAuthenticated, authenticatedApi])

  // Load vendors (gatekeeper catalog) for both the summary cards and configure panel.
  useEffect(() => {
    if (!(isAuthenticated && authenticatedApi)) {
      setVendors([])
      return
    }
    let cancelled = false
    authenticatedApi.listGatekeeperVendors().then(list => {
      if (cancelled) return
      setVendors(list)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load gatekeeper vendors:', err)
    })
    return () => { cancelled = true }
  }, [isAuthenticated, authenticatedApi])

  // Subscribe to connected accounts while authenticated. The same subscription serves all
  // gatekeeper bindings; each binding filters down to the vendor + resource it requires.
  useEffect(() => {
    if (!(isAuthenticated && authenticatedApi)) {
      setAccounts([])
      return
    }
    let cancelled = false
    const accountMap = new Map<number, AccountOption>()
    let subStub: { [Symbol.dispose](): void } | null = null

    const subscriber = new AccountsSubscriberAdapter({
      add({ id: accountId, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        accountMap.set(accountId, {
          id: accountId, description, vendorId, vendorDescription: vendor,
          supportedResources, credentialsValid,
        })
        setAccounts(Array.from(accountMap.values()))
        if (credentialsValid) {
          setReconnectingAccountId(prev => prev === accountId ? null : prev)
        }
      },
      remove(accountId) {
        if (cancelled) return
        accountMap.delete(accountId)
        setAccounts(Array.from(accountMap.values()))
      },
    })

    authenticatedApi.subscribeConnectedAccounts(subscriber)
      .then(stub => {
        if (cancelled) {
          stub[Symbol.dispose]()
        } else {
          subStub = stub
        }
      })
      .catch(err => {
        logRpcFailure('Failed to subscribe to connected accounts:', err)
      })

    return () => {
      cancelled = true
      subStub?.[Symbol.dispose]()
    }
  }, [isAuthenticated, authenticatedApi])

  const handleConnectAccount = useCallback(async (vendorId: string) => {
    if (!authenticatedApi) return
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account connection in the new tab.', variant: 'success' })
    } catch (err) {
      console.error('Failed to initiate connection:', err)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setConnectingVendor(null)
    }
  }, [authenticatedApi, toasts])

  const handleReconnectAccount = useCallback(async (accountId: number) => {
    if (!authenticatedApi) return
    setReconnectingAccountId(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account reconnect in the new tab.', variant: 'success' })
    } catch (err) {
      console.error('Failed to initiate reconnect:', err)
      toasts.add({ title: 'Failed to start reconnect flow', variant: 'error' })
      setReconnectingAccountId(null)
    }
  }, [authenticatedApi, toasts])

  const handleGatekeeperReadyChange = useCallback((bindingName: string, ready: boolean) => {
    setGatekeeperReady(prev => {
      if (prev[bindingName] === ready) return prev
      return { ...prev, [bindingName]: ready }
    })
  }, [])

  const handleCollectorChange = useCallback((bindingName: string, collect: (() => Promise<string>) | null) => {
    if (collect) {
      collectorsRef.current.set(bindingName, collect)
    } else {
      collectorsRef.current.delete(bindingName)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null

    if (!id || !authenticatedApi) {
      setAdmin(null)
      setCanManageFeatured(false)
      setIsFeatured(false)
      return () => {
        cancelled = true
      }
    }

    ;(async () => {
      try {
        // Mint the admin capability once (the access check happens server-side); null = not admin.
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setCanManageFeatured(false)
          setIsFeatured(false)
          return
        }
        stub = api
        setAdmin({ api })

        const result = await api.isBlueprintFeatured(id)
        if (cancelled) return
        // null means the blueprint can't be featured; a boolean means it can.
        if (result === null) {
          setCanManageFeatured(false)
          setIsFeatured(false)
        } else {
          setCanManageFeatured(true)
          setIsFeatured(result)
        }
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load admin featured state:', err)
        setCanManageFeatured(false)
        setIsFeatured(false)
      }
    })()

    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
      setAdmin(null)
    }
  }, [id, authenticatedApi])

  useEffect(() => {
    let cancelled = false

    if (!id || !authenticatedApi) {
      setIsInLibrary(false)
      setLoadingLibraryState(false)
      return () => {
        cancelled = true
      }
    }

    setLoadingLibraryState(true)
    authenticatedApi.isBlueprintInLibrary(id).then(result => {
      if (cancelled) return
      setIsInLibrary(result !== null)
      setIsUploadedBlueprint(result?.uploaded ?? false)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load library state:', err)
      setIsInLibrary(false)
      setIsUploadedBlueprint(false)
    }).finally(() => {
      if (!cancelled) {
        setLoadingLibraryState(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [id, authenticatedApi])

  useEffect(() => {
    let cancelled = false

    if (!id || !authenticatedApi) {
      setIsPinned(false)
      setIsOwnBlueprint(false)
      setOwnBlueprintSummary(null)
      setLoadingOwnBlueprintState(false)
      return () => {
        cancelled = true
      }
    }

    setLoadingOwnBlueprintState(true)
    Promise.all([
      authenticatedApi.isBlueprintPinned(id),
      authenticatedApi.getOwnBlueprint(id),
    ]).then(([pinned, ownBlueprint]) => {
      if (cancelled) return
      setIsPinned(pinned)
      setOwnBlueprintSummary(ownBlueprint)
      setIsOwnBlueprint(ownBlueprint !== null)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load blueprint user state:', err)
      setIsPinned(false)
      setOwnBlueprintSummary(null)
      setIsOwnBlueprint(false)
    }).finally(() => {
      if (!cancelled) {
        setLoadingOwnBlueprintState(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [id, authenticatedApi])

  const findMatchingAccounts = useCallback((binding: Extract<BlueprintBinding, { type: 'gatekeeper' }>) => {
    return accounts.filter(account =>
      account.vendorId.toLowerCase() === binding.gatekeeperName.toLowerCase() &&
      account.credentialsValid &&
      account.supportedResources.some(resource => resource.urlPattern === binding.typeUrlPattern)
    )
  }, [accounts])

  const findSuggestedModelId = useCallback((suggested: {provider: string, modelName: string}) => {
    const provider = suggested.provider.trim().toLowerCase()
    const modelName = suggested.modelName.trim().toLowerCase()
    const exactMatches = models.filter(model =>
      model.id.toLowerCase() === modelName ||
      model.name.toLowerCase() === modelName ||
      model.id.toLowerCase() === `${provider}/${modelName}` ||
      model.id.toLowerCase() === `${provider}:${modelName}`
    )
    if (exactMatches.length === 1) return exactMatches[0].id

    const providerScopedMatches = models.filter(model => {
      const text = `${model.id} ${model.name}`.toLowerCase()
      return text.includes(provider) && text.includes(modelName)
    })
    return providerScopedMatches.length === 1 ? providerScopedMatches[0].id : null
  }, [models])

  const getFirstUnresolvedBindingName = useCallback((assignments = draftAssignments) => {
    if (!blueprint) return null
    for (let name of Object.keys(blueprint.metadata.bindings)) {
      if (!assignments[name]) return name
    }
    return null
  }, [blueprint, draftAssignments])

  const openBindingConfigurator = useCallback((name: string) => {
    if (!blueprint) return
    const binding = blueprint.metadata.bindings[name]
    if (!binding) return

    setGatekeeperReady(prev => ({ ...prev, [name]: false }))
    collectorsRef.current.delete(name)
    const existing = draftAssignments[name]
    let initial: any = existing ? { ...existing } : { type: binding.type }
    if (binding.type === 'gatekeeper') {
      initial = {
        type: 'gatekeeper',
        accountId: existing?.type === 'gatekeeper' ? existing.accountId : undefined,
        resourceUrl: existing?.type === 'gatekeeper' ? existing.resourceUrl : binding.resourceUrl || '',
      }
    } else if (binding.type === 'aiModel') {
      initial = {
        type: 'aiModel',
        modelId: existing?.type === 'aiModel' ? existing.modelId : undefined,
      }
    } else if (binding.type === 'agentSpawner') {
      initial = {
        type: 'agentSpawner',
        modelId: existing?.type === 'agentSpawner' ? existing.modelId : undefined,
      }
    }
    setBindingForm(prev => ({ ...prev, [name]: initial }))
    setActiveBindingName(name)
  }, [blueprint, draftAssignments])

  useEffect(() => {
    if (!blueprint || !isAuthenticated) return

    // Re-run when account/model data changes: findMatchingAccounts depends on accounts,
    // and findSuggestedModelId depends on models.
    setDraftAssignments(prev => {
      let next = { ...prev }
      let changed = false

      for (let [name, binding] of Object.entries(blueprint.metadata.bindings)) {
        if (next[name]) continue

        if (binding.type === 'gatekeeper') {
          if (!binding.resourceUrl) continue
          const matches = findMatchingAccounts(binding)
          if (matches.length === 1) {
            next[name] = {
              type: 'gatekeeper',
              accountId: matches[0].id,
              resourceUrl: normalizeResourceUrl(binding.resourceUrl),
            }
            changed = true
          }
        } else if (binding.type === 'aiModel') {
          if (!binding.suggestedModel) continue
          const modelId = findSuggestedModelId(binding.suggestedModel)
          if (modelId) {
            next[name] = { type: 'aiModel', modelId }
            changed = true
          }
        } else if (binding.type === 'agentSpawner') {
          if (binding.suggestedModel === null) {
            next[name] = { type: 'agentSpawner', modelId: null }
            changed = true
          } else if (binding.suggestedModel) {
            const modelId = findSuggestedModelId(binding.suggestedModel)
            if (modelId) {
              next[name] = { type: 'agentSpawner', modelId }
              changed = true
            }
          }
        }
      }

      return changed ? next : prev
    })
  }, [blueprint, isAuthenticated, findMatchingAccounts, findSuggestedModelId])

  const handleStartConfigure = () => {
    if (!isAuthenticated) {
      setShowLogin(true)
      return
    }

    let firstUnresolved = getFirstUnresolvedBindingName()
    if (firstUnresolved) {
      openBindingConfigurator(firstUnresolved)
      return
    }

    handleCreate()
  }

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
      setShowLogin(false)
    }
  }

  const updateBinding = useCallback((name: string, updates: Partial<BlueprintBindingAssignment>) => {
    setBindingForm(prev => ({
      ...prev,
      [name]: { ...prev[name], ...updates },
    }))
  }, [])

  const canSaveActiveBinding = useCallback(() => {
    if (!activeBindingName || !blueprint) return false
    const binding = blueprint.metadata.bindings[activeBindingName]
    const assignment = bindingForm[activeBindingName]
    if (!binding || !assignment) return false
    if (binding.type === 'gatekeeper') {
      let a = assignment as any
      return a.accountId !== undefined && gatekeeperReady[activeBindingName] === true
    } else if (binding.type === 'aiModel') {
      return Boolean((assignment as any).modelId)
    } else if (binding.type === 'agentSpawner') {
      return (assignment as any).modelId !== undefined
    }
    return false
  }, [activeBindingName, blueprint, bindingForm, gatekeeperReady])

  const handleSaveActiveBinding = async () => {
    if (!activeBindingName || !blueprint) return
    const binding = blueprint.metadata.bindings[activeBindingName]
    const form = bindingForm[activeBindingName]
    if (!binding || !form) return

    try {
      let assignment: BlueprintBindingAssignment
      if (binding.type === 'gatekeeper') {
        const collect = collectorsRef.current.get(activeBindingName)
        if (!collect) {
          throw new Error(`Binding "${activeBindingName}" is not configured.`)
        }
        const resourceUrl = await collect()
        assignment = {
          type: 'gatekeeper',
          accountId: (form as any).accountId,
          resourceUrl: normalizeResourceUrl(resourceUrl),
        }
      } else if (binding.type === 'aiModel') {
        assignment = {
          type: 'aiModel',
          modelId: (form as any).modelId,
        }
      } else {
        assignment = {
          type: 'agentSpawner',
          modelId: (form as any).modelId ?? null,
        }
      }
      setDraftAssignments(prev => ({ ...prev, [activeBindingName]: assignment }))
      setActiveBindingName(null)
      collectorsRef.current.delete(activeBindingName)
    } catch (err: any) {
      setError(err.message || 'Failed to save connection.')
    }
  }

  const handleCreate = async () => {
    if (!authenticatedApi || !blueprint || !id) return

    let firstUnresolved = getFirstUnresolvedBindingName()
    if (firstUnresolved) {
      openBindingConfigurator(firstUnresolved)
      return
    }

    setCreating(true)
    setError(null)
    const overseer = authenticatedApi.newGadgetFromBlueprint(id, draftAssignments)
    try {
      let metadata = await overseer.getMetadata()
      window.location.href = `/workspace/${metadata.id}`
    } catch (err: any) {
      setError(err.message || 'Failed to create gadget from blueprint.')
    } finally {
      overseer.then(stub => stub[Symbol.dispose]()).catch(() => {})
      setCreating(false)
    }
  }

  const handleDownload = async () => {
    if (!id || !blueprint) return
    setDownloading(true)
    setError(null)

    try {
      await saveStreamToFile(
        () => rpcStub.downloadBlueprint(id),
        makeBlueprintFilename(blueprint.metadata.title, blueprint.metadata.version),
        {
          description: 'Gadget Blueprint',
          contentType: 'application/octet-stream',
          extension: BLUEPRINT_ARCHIVE_EXTENSION,
        },
      )
    } catch (err: any) {
      setError(err.message || 'Failed to download blueprint.')
    } finally {
      setDownloading(false)
    }
  }

  const handleToggleFeatured = async () => {
    if (!admin || !id || !canManageFeatured) return

    const nextFeatured = !isFeatured
    setUpdatingFeatured(true)

    try {
      await admin.api.setBlueprintFeatured(id, nextFeatured)
      setIsFeatured(nextFeatured)
    } catch (err: any) {
      console.error('Failed to update featured status:', err)
      toasts.add({
        title: nextFeatured ? 'Failed to feature blueprint' : 'Failed to unfeature blueprint',
        variant: 'error',
      })
    } finally {
      setUpdatingFeatured(false)
    }
  }

  const handleTogglePinned = async () => {
    if (!id) return

    if (!isAuthenticated || !authenticatedApi) {
      setShowLogin(true)
      return
    }

    const nextPinned = !isPinned
    setUpdatingPinned(true)
    try {
      await authenticatedApi.setBlueprintPinned(id, nextPinned)
      setIsPinned(nextPinned)
      if (nextPinned && !isOwnBlueprint) {
        setIsInLibrary(true)
        setIsUploadedBlueprint(false)
      }
      toasts.add({ title: nextPinned ? 'Blueprint favorited' : 'Blueprint unfavorited', variant: 'success' })
    } catch (err) {
      console.error('Failed to update blueprint pin:', err)
      toasts.add({ title: 'Failed to update favorite status', variant: 'error' })
    } finally {
      setUpdatingPinned(false)
    }
  }

  const handleAddToLibrary = async () => {
    if (!id) return

    if (!isAuthenticated || !authenticatedApi) {
      setShowLogin(true)
      return
    }

    if (isInLibrary) {
      return
    }

    setAddingToLibrary(true)
    try {
      await authenticatedApi.addBlueprintToLibrary(id)
      setIsInLibrary(true)
      toasts.add({ title: 'Blueprint added to library', variant: 'success' })
    } catch (err) {
      console.error('Failed to add blueprint to library:', err)
      toasts.add({ title: 'Failed to add blueprint to library', variant: 'error' })
    } finally {
      setAddingToLibrary(false)
    }
  }

  const handleRemoveFromLibrary = async () => {
    if (!id || !authenticatedApi) return

    setRemovingFromLibrary(true)
    try {
      await authenticatedApi.removeBlueprintFromLibrary(id)
      if (isUploadedBlueprint) {
        setShowDeleteConfirm(false)
        toasts.add({ title: 'Blueprint deleted', variant: 'success' })
        navigate({ to: '/' })
      } else {
        setIsInLibrary(false)
        setIsPinned(false)
        toasts.add({ title: 'Blueprint removed from library', variant: 'success' })
      }
    } catch (err) {
      console.error('Failed to remove blueprint from library:', err)
      toasts.add({
        title: isUploadedBlueprint ? 'Failed to delete blueprint' : 'Failed to remove blueprint from library',
        variant: 'error',
      })
    } finally {
      setRemovingFromLibrary(false)
    }
  }

  const handleDeleteOwnedBlueprint = async () => {
    if (!id || !authenticatedApi) return

    setRemovingFromLibrary(true)
    let overseer: ReturnType<typeof authenticatedApi.openGadget> | null = null
    try {
      // The source workspace owns its blueprints, so it must do the deleting. Once it is gone (or
      // the blueprint was never published from one), the user record is all there is to clean up.
      if (ownBlueprintSummary?.source.type === 'workspace') {
        overseer = authenticatedApi.openGadget(ownBlueprintSummary.source.workspaceId)
        await overseer.deleteBlueprint(id)
      } else {
        await authenticatedApi.deleteOrphanedBlueprint(id)
      }
      setShowDeleteConfirm(false)
      toasts.add({ title: 'Blueprint deleted', variant: 'success' })
      navigate({ to: '/' })
    } catch (err) {
      console.error('Failed to delete blueprint:', err)
      toasts.add({ title: 'Failed to delete blueprint', variant: 'error' })
    } finally {
      overseer?.then(stub => stub[Symbol.dispose]()).catch(() => {})
      setRemovingFromLibrary(false)
    }
  }

  if (showLogin && !isAuthenticated) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  if (loading || authLoading) {
    return <BlueprintStatePage title="Loading blueprint..." loading />
  }

  if (notFound) {
    return (
      <BlueprintStatePage
        title="Blueprint not found"
        message="This blueprint may have been removed or the link may be incorrect."
        actionLabel="Back to Explore"
        onAction={() => navigate({ to: '/explore' })}
      />
    )
  }

  if (!blueprint) {
    return (
      <BlueprintStatePage
        title="Couldn’t load blueprint"
        message={error || 'Failed to load blueprint.'}
        actionLabel="Back to Explore"
        onAction={() => navigate({ to: '/explore' })}
      />
    )
  }

  let meta = blueprint.metadata
  let bindingEntries = Object.entries(meta.bindings)
  let activeBinding = activeBindingName ? meta.bindings[activeBindingName] : undefined
  let readyCount = bindingEntries.filter(([name]) => draftAssignments[name]).length
  let unresolvedBindingName = getFirstUnresolvedBindingName()
  let remainingCount = bindingEntries.length - readyCount
  let primaryActionLabel: string
  if (!isAuthenticated) {
    primaryActionLabel = 'Log in to create a gadget'
  } else if (unresolvedBindingName !== null) {
    primaryActionLabel = remainingCount > 0
      ? `Configure ${remainingCount} remaining ${remainingCount === 1 ? 'connection' : 'connections'}`
      : 'Configure connections'
  } else {
    primaryActionLabel = 'Create Gadget'
  }
  let createDisabled = creating
  let canDeleteOwnedBlueprint = isOwnBlueprint && !loadingOwnBlueprintState
  // Only set when the workspace this blueprint was published from is still around to open.
  let sourceWorkspace =
    ownBlueprintSummary?.source.type === 'workspace' ? ownBlueprintSummary.source : null

  return (
    <div className="min-h-full bg-kumo-base">
      <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-10 sm:px-10">
        <button
          type="button"
          onClick={() => {
            if (router.history.canGoBack()) {
              router.history.back()
            } else {
              navigate({ to: '/explore' })
            }
          }}
          className="mb-8 inline-flex cursor-pointer items-center gap-2 px-1 py-1 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-subtle transition-[color,transform] duration-150 ease-out hover:text-kumo-default active:scale-[0.98]"
        >
          <ArrowLeft size={14} weight="bold" />
          Back
        </button>

        <header className="mb-10 grid gap-7 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div className="min-w-0">
            {isFeatured && (
              <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-[rgba(255,72,1,0.10)] px-2 py-1 text-[11px] leading-4 font-semibold tracking-[-0.1px] text-kumo-brand">
                <Star size={12} weight="fill" />
                Featured
              </span>
            )}
            <h1 className="m-0 text-3xl font-semibold leading-tight tracking-tight text-kumo-default">
              {meta.title}
            </h1>
            {meta.description && (
              <p className="mt-3 max-w-[640px] text-[15px] leading-[22px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {meta.description}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              <span>By {meta.author.name}</span>
              <span className="text-kumo-inactive">•</span>
              <span>v{meta.version}</span>
              <span className="text-kumo-inactive">•</span>
              <span>Updated {new Date(meta.lastUpdated).toLocaleDateString()}</span>
            </div>
          </div>

          <aside className="space-y-3 lg:w-[360px] lg:justify-self-end lg:pt-1">
            {blueprint.screenshotUrl && (
              <BlueprintScreenshotHero
                title={meta.title}
                screenshotUrl={blueprint.screenshotUrl}
              />
            )}
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={handleStartConfigure}
                  disabled={createDisabled}
                  className="press inline-flex h-10 w-full cursor-pointer items-center justify-center rounded-lg bg-kumo-brand px-4 text-[14px] leading-5 font-semibold tracking-[-0.25px] text-white transition-colors duration-150 ease-out hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {creating ? 'Creating...' : primaryActionLabel}
                </button>
              </span>

            {!isOwnBlueprint && !loadingOwnBlueprintState && !isInLibrary && (
              <Tooltip content={isAuthenticated ? 'Add to library' : 'Log in to add to library'} asChild>
                <button
                  type="button"
                  aria-label={isAuthenticated ? 'Add blueprint to library' : 'Log in to add blueprint to library'}
                  onClick={handleAddToLibrary}
                  disabled={addingToLibrary || loadingLibraryState}
                  className="press inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-kumo-line bg-kumo-base p-0 text-kumo-subtle transition-colors duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Plus size={17} weight="bold" />
                </button>
              </Tooltip>
            )}

            <DropdownMenu>
              <DropdownMenu.Trigger
                render={(
                  <WorkshopIconButton
                    aria-label="More blueprint actions"
                    className="!h-10 !w-10 shrink-0 rounded-lg border border-kumo-line bg-kumo-base text-kumo-subtle hover:border-kumo-fill hover:bg-kumo-tint hover:text-kumo-default data-[popup-open]:border-kumo-fill data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
                  >
                    <DotsThree size={18} weight="bold" />
                  </WorkshopIconButton>
                )}
              />
              <DropdownMenu.Content className={MENU_CONTENT}>
                <DropdownMenu.Item
                  icon={<DownloadSimple size={13} className="mr-2" />}
                  onClick={handleDownload}
                  disabled={downloading}
                  className={MENU_ITEM}
                >
                  {downloading ? 'Downloading...' : 'Download archive'}
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  icon={<Star size={13} className="mr-2" weight={isPinned ? 'fill' : 'regular'} />}
                  onClick={handleTogglePinned}
                  disabled={updatingPinned}
                  className={MENU_ITEM}
                >
                  {updatingPinned ? 'Updating...' : (isPinned ? 'Unfavorite' : 'Favorite')}
                </DropdownMenu.Item>

                {sourceWorkspace && (
                  <DropdownMenu.Item
                    icon={<ArrowSquareOut size={13} className="mr-2" />}
                    onClick={() => window.open(`/workspace/${sourceWorkspace.workspaceId}`, '_blank', 'noopener,noreferrer')}
                    className={MENU_ITEM}
                  >
                    Go to workspace
                  </DropdownMenu.Item>
                )}

                {canDeleteOwnedBlueprint && (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      icon={<Trash size={13} className="mr-2" />}
                      variant="danger"
                      onClick={() => setShowDeleteConfirm(true)}
                      className={MENU_ITEM_DANGER}
                    >
                      Delete blueprint
                    </DropdownMenu.Item>
                  </>
                )}

                {!isOwnBlueprint && !loadingOwnBlueprintState && isInLibrary && (
                  <>
                    <DropdownMenu.Separator />
                    {isUploadedBlueprint ? (
                      <DropdownMenu.Item
                        icon={<Trash size={13} className="mr-2" />}
                        variant="danger"
                        onClick={() => setShowDeleteConfirm(true)}
                        className={MENU_ITEM_DANGER}
                      >
                        Delete blueprint
                      </DropdownMenu.Item>
                    ) : (
                      <DropdownMenu.Item
                        icon={<Trash size={13} className="mr-2" />}
                        variant="danger"
                        onClick={handleRemoveFromLibrary}
                        disabled={removingFromLibrary}
                        className={MENU_ITEM_DANGER}
                      >
                        {removingFromLibrary ? 'Removing...' : 'Remove from library'}
                      </DropdownMenu.Item>
                    )}
                  </>
                )}

                {canManageFeatured && (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      icon={<Sparkle size={13} className="mr-2" weight={isFeatured ? 'fill' : 'regular'} />}
                      onClick={handleToggleFeatured}
                      disabled={updatingFeatured}
                      className={MENU_ITEM}
                    >
                      {updatingFeatured ? 'Updating...' : (isFeatured ? 'Unfeature blueprint' : 'Feature blueprint')}
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
              </DropdownMenu>
            </div>
          </aside>
        </header>

        <main className="space-y-6">
          {bindingEntries.length > 0 ? (
            <section>
              <div className="mb-2 flex items-center gap-2 px-1">
                <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
                  Required connections
                </h2>
                <span className="text-[12px] font-medium tracking-[-0.1px] text-kumo-inactive">
                  {bindingEntries.length}
                </span>
              </div>
              <div className="mb-3 px-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {readyCount === bindingEntries.length
                  ? 'Everything is ready. You can change any connection before creating the Gadget.'
                  : `${readyCount} of ${bindingEntries.length} ready. Suggestions are used automatically when they match one of your connected accounts.`}
              </div>
              <div className="overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base">
                {bindingEntries.map(([name, binding]) => (
                  <BlueprintBindingSummaryCard
                    key={name}
                    name={name}
                    binding={binding}
                    assignment={draftAssignments[name]}
                    vendor={binding.type === 'gatekeeper' ? vendorById.get(binding.gatekeeperName.toLowerCase()) : undefined}
                    models={models}
                    onConfigure={() => isAuthenticated ? openBindingConfigurator(name) : setShowLogin(true)}
                  />
                ))}
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-kumo-line bg-kumo-base px-5 py-5">
              <p className="m-0 text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
                No connections required
              </p>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                This blueprint can create a Gadget without configuring external resources.
              </p>
            </section>
          )}

          {error && (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-kumo-danger/30 bg-kumo-danger-tint px-4 py-3 text-[13px] leading-[18px] text-kumo-danger">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="cursor-pointer text-kumo-danger hover:text-kumo-default">&times;</button>
            </div>
          )}
        </main>
      </div>

      <Dialog.Root
        open={activeBindingName !== null}
        onOpenChange={(open) => { if (!open) setActiveBindingName(null) }}
      >
        <Dialog
          // The configurator iframe measures getBoundingClientRect(), which includes transforms.
          className="!z-[1000] !top-[clamp(28px,10vh,96px)] !flex !max-h-[calc((100vh_-_clamp(28px,10vh,96px)_-_28px)_*_0.9)] !w-[min(760px,calc(100vw-32px))] !-translate-y-0 data-ending-style:!scale-100 data-starting-style:!scale-100 flex-col overflow-hidden bg-kumo-base p-0"
          size="lg"
        >
          {activeBinding && activeBindingName && authenticatedApi && (
            <>
              <div className="shrink-0 flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
                <div className="min-w-0">
                  <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                    Configure {activeBinding.title || activeBindingName}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                    {activeBinding.type === 'gatekeeper' && activeBinding.description
                      ? activeBinding.description
                      : 'Choose the resource or model this new Gadget should use.'}
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

              <div className="new-gatekeeper-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <BindingField
                  name={activeBindingName}
                  binding={activeBinding}
                  value={bindingForm[activeBindingName] || {}}
                  models={models}
                  authenticatedApi={authenticatedApi}
                  vendors={vendors}
                  accounts={accounts}
                  connectingVendor={connectingVendor}
                  reconnectingAccountId={reconnectingAccountId}
                  onChange={(updates) => updateBinding(activeBindingName, updates)}
                  onConnectAccount={handleConnectAccount}
                  onReconnectAccount={handleReconnectAccount}
                  onReadyChange={(ready) => handleGatekeeperReadyChange(activeBindingName, ready)}
                  onCollectorChange={(collect) => handleCollectorChange(activeBindingName, collect)}
                  selectPortalContainer={selectPortalRef}
                />
              </div>

              <div className="shrink-0 flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
                <WorkshopButton onClick={() => setActiveBindingName(null)}>
                  Cancel
                </WorkshopButton>
                <WorkshopButton
                  tone="primary"
                  onClick={handleSaveActiveBinding}
                  disabled={!canSaveActiveBinding()}
                >
                  Save connection
                </WorkshopButton>
              </div>
            </>
          )}
        </Dialog>
        <div
          ref={selectPortalRef}
          className="pointer-events-none fixed inset-0 z-[1100] [&>*]:pointer-events-auto"
        />
      </Dialog.Root>

      {/* Delete blueprint confirmation dialog */}
      <Dialog.Root
        role="alertdialog"
        open={showDeleteConfirm}
        onOpenChange={(open) => { if (!open) setShowDeleteConfirm(false) }}
      >
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            Delete blueprint
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            Delete "{blueprint?.metadata.title}"? {canDeleteOwnedBlueprint
              ? 'This blueprint link will stop working, but gadgets already created from it won’t be affected.'
              : 'This blueprint was uploaded manually and cannot be recovered.'}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props} disabled={removingFromLibrary}>
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              onClick={canDeleteOwnedBlueprint ? handleDeleteOwnedBlueprint : handleRemoveFromLibrary}
              loading={removingFromLibrary}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  )
}

function BlueprintScreenshotHero({
  title,
  screenshotUrl,
}: {
  title: string
  screenshotUrl: string
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        render={(
          <button
            type="button"
            className="themed-compact-shadow themed-card-hover-shadow group relative block w-full cursor-zoom-in overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base text-left transition-[border-color,box-shadow,transform] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill active:scale-[0.995]"
            aria-label={`Open larger screenshot of ${title}`}
          >
            <img
              src={screenshotUrl}
              alt={`Screenshot of ${title}`}
              className="aspect-[16/9] w-full object-cover"
            />
            <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full border border-kumo-line bg-kumo-base/90 text-kumo-subtle opacity-0 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[opacity,color,background-color] duration-150 ease-out group-hover:opacity-100 group-hover:text-kumo-default">
              <ArrowsOutSimple size={14} weight="bold" />
            </span>
          </button>
        )}
      />
      <Dialog
        className="!z-[1200] !w-[min(1120px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0"
        size="lg"
      >
        <Dialog.Title className="sr-only">Screenshot of {title}</Dialog.Title>
        <Dialog.Close
          render={(props) => (
            <WorkshopIconButton
              {...props}
              aria-label="Close screenshot"
              className="!absolute !right-3 !top-3 !z-10 !h-8 !w-8 rounded-full border border-kumo-line bg-kumo-base/90 text-kumo-subtle shadow-[0_1px_2px_rgba(0,0,0,0.05)] backdrop-blur-sm hover:bg-kumo-base hover:text-kumo-default"
            >
              <X size={18} />
            </WorkshopIconButton>
          )}
        />
        <div className="p-3 sm:p-4">
          <img
            src={screenshotUrl}
            alt={`Screenshot of ${title}`}
            className="max-h-[calc(100vh-96px)] w-full rounded-xl object-contain"
          />
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function BlueprintStatePage({
  title,
  message,
  loading = false,
  actionLabel,
  onAction,
}: {
  title: string
  message?: string
  loading?: boolean
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="min-h-full bg-kumo-base">
      <div className="mx-auto flex min-h-[60vh] w-full max-w-[1040px] items-center justify-center px-4 py-12 sm:px-8">
        <div className="themed-compact-shadow w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-base px-6 py-8 text-center">
          {loading && (
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          )}
          <h1 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.35px] text-kumo-default">
            {title}
          </h1>
          {message && (
            <p className="mt-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              {message}
            </p>
          )}
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className="mt-5 inline-flex h-9 cursor-pointer items-center justify-center rounded-full border border-kumo-line bg-kumo-base px-4 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default transition-[background-color,border-color,transform] duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint active:scale-[0.98]"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function BindingIconTile({
  binding,
  vendor,
}: {
  binding: BlueprintBinding
  vendor?: { id: string, description: VendorDescription, supportedResources: SupportedResource[] }
}) {
  let icon: ReactNode
  let fallback = binding.type[0]?.toUpperCase() ?? '?'

  if (binding.type === 'gatekeeper') {
    fallback = vendor?.description.displayName[0]?.toUpperCase() ?? binding.gatekeeperName[0]?.toUpperCase() ?? '?'
    icon = vendor?.description.logo?.url ? (
      <img src={vendor.description.logo.url} alt="" className="h-5 w-5 object-contain" />
    ) : (
      <span className="text-[13px] font-semibold text-kumo-subtle">{fallback}</span>
    )
  } else if (binding.type === 'aiModel') {
    icon = <Robot size={16} className="text-kumo-subtle" />
  } else {
    icon = <Lightning size={16} className="text-kumo-subtle" />
  }

  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
      {icon}
    </div>
  )
}

function BlueprintBindingSummaryCard({
  name,
  binding,
  assignment,
  vendor,
  models,
  onConfigure,
}: {
  name: string
  binding: BlueprintBinding
  assignment?: BlueprintBindingAssignment
  vendor?: { id: string, description: VendorDescription, supportedResources: SupportedResource[] }
  models: AiChatAuthorInfo[]
  onConfigure: () => void
}) {
  const title = binding.title || name
  const typeLabel = binding.type === 'gatekeeper'
    ? (vendor?.description.displayName ?? binding.gatekeeperName)
    : binding.type === 'aiModel'
      ? 'AI Model'
      : 'Agent'
  const resource = binding.type === 'gatekeeper'
    ? vendor?.supportedResources.find(r => r.urlPattern === binding.typeUrlPattern)
    : null
  const suggestion = binding.type === 'gatekeeper'
    ? binding.resourceUrl
    : binding.type === 'aiModel' && binding.suggestedModel
      ? `${binding.suggestedModel.provider} / ${binding.suggestedModel.modelName}`
      : binding.type === 'agentSpawner'
        ? binding.suggestedModel === null
          ? 'No agent'
          : binding.suggestedModel
            ? `${binding.suggestedModel.provider} / ${binding.suggestedModel.modelName}`
            : undefined
        : undefined
  // A spawnerOnly binding is connected like any other, but the resulting connection is fed only
  // to the agent spawner that referenced it -- the gadget's own code never sees it.
  const detail = [
    typeLabel,
    resource?.title,
    binding.spawnerOnly ? 'For spawned agents only' : null,
  ].filter(Boolean).join(' · ')
  const usingLabel = (() => {
    if (!assignment) return null
    if (assignment.type === 'gatekeeper') return assignment.resourceUrl
    if (assignment.type === 'aiModel') {
      return modelsByIdLabel(assignment.modelId)
    }
    if (assignment.modelId === null) return 'No agent'
    return modelsByIdLabel(assignment.modelId)
  })()
  const status = assignment ? 'Ready' : suggestion ? 'Suggested' : 'Needs setup'
  const actionLabel = assignment ? 'Change' : 'Configure'

  function modelsByIdLabel(modelId: string) {
    return models.find(model => model.id === modelId)?.name ?? modelId
  }

  return (
    <div className="grid min-h-[72px] min-w-0 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 border-b border-kumo-line px-4 py-3 text-left last:border-b-0">
      <BindingIconTile binding={binding} vendor={vendor} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="m-0 truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            {title}
          </h3>
          <span className={`rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.1px] ${
            assignment
              ? 'bg-kumo-success-tint text-kumo-success'
              : suggestion
                ? 'bg-kumo-tint text-kumo-subtle'
                : 'bg-[rgba(255,72,1,0.10)] text-kumo-brand'
          }`}>
            {status}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          {usingLabel
            ? <>Using: <span>{usingLabel}</span></>
            : suggestion
              ? `Suggested: ${suggestion}`
              : detail}
        </p>
      </div>
      <button
        type="button"
        onClick={onConfigure}
        className="press inline-flex h-8 cursor-pointer items-center justify-center rounded-lg border border-kumo-line bg-kumo-base px-3 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default transition-colors duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint"
      >
        {actionLabel}
      </button>
    </div>
  )
}

// Sub-component for rendering a single binding field.
function BindingField({
  name,
  binding,
  value,
  models,
  authenticatedApi,
  vendors,
  accounts,
  connectingVendor,
  reconnectingAccountId,
  onChange,
  onConnectAccount,
  onReconnectAccount,
  onReadyChange,
  onCollectorChange,
  selectPortalContainer,
}: {
  name: string
  binding: BlueprintBinding
  value: Partial<BlueprintBindingAssignment>
  models: AiChatAuthorInfo[]
  authenticatedApi: RpcStub<AuthenticatedApi>
  vendors: {id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]
  accounts: AccountOption[]
  connectingVendor: string | null
  reconnectingAccountId: number | null
  onChange: (updates: Partial<BlueprintBindingAssignment>) => void
  onConnectAccount: (vendorId: string) => void
  onReconnectAccount: (accountId: number) => void
  onReadyChange: (ready: boolean) => void
  onCollectorChange: (collect: (() => Promise<string>) | null) => void
  selectPortalContainer?: { current: HTMLElement | null }
}) {
  const title = binding.title || name

  if (binding.type === 'gatekeeper') {
    return (
      <BlueprintGatekeeperBindingField
        title={title}
        binding={binding}
        value={value}
        authenticatedApi={authenticatedApi}
        vendors={vendors}
        accounts={accounts}
        connectingVendor={connectingVendor}
        reconnectingAccountId={reconnectingAccountId}
        onChange={onChange}
        onConnectAccount={onConnectAccount}
        onReconnectAccount={onReconnectAccount}
        onReadyChange={onReadyChange}
        onCollectorChange={onCollectorChange}
      />
    )
  }

  if (binding.type === 'aiModel') {
    return (
      <div>
        <label className="block text-sm font-medium text-kumo-default mb-1">
          {title}
        </label>
        {binding.description && (
          <p className="text-xs text-kumo-subtle mb-1">{binding.description}</p>
        )}
        <Select
          aria-label="Choose an AI model"
          className="w-full text-sm"
          placeholder="Choose an AI model"
          value={(value as any).modelId || undefined}
          onValueChange={(modelId) => onChange({ modelId } as any)}
          renderValue={(id) => models.find(m => m.id === id)?.name ?? String(id)}
          container={selectPortalContainer}
          disabled={models.length === 0}
        >
          {models.map(m => (
            <Select.Option key={m.id} value={m.id}>
              {m.name}
            </Select.Option>
          ))}
        </Select>
        {models.length === 0 && (
          <p className="text-xs text-kumo-subtle mt-1">
            No AI models are available yet. Add a model from AI Providers first.
          </p>
        )}
      </div>
    )
  }

  if (binding.type === 'agentSpawner') {
    const selectedModelId = (value as any).modelId === null
      ? NO_AGENT_MODEL_ID
      : (value as any).modelId ?? undefined

    return (
      <div>
        <label className="block text-sm font-medium text-kumo-default mb-1">
          {title}
        </label>
        {binding.description && (
          <p className="text-xs text-kumo-subtle mb-1">{binding.description}</p>
        )}
        <Select
          aria-label="Choose a model for the agent spawner"
          className="w-full text-sm"
          placeholder="Choose a model for the agent spawner"
          value={selectedModelId}
          onValueChange={(modelId) => onChange({ modelId: modelId === NO_AGENT_MODEL_ID ? null : modelId } as any)}
          renderValue={(id) => {
            if (id === NO_AGENT_MODEL_ID) return '(No agent)'
            return models.find(m => m.id === id)?.name ?? String(id)
          }}
          container={selectPortalContainer}
        >
          <Select.Option value={NO_AGENT_MODEL_ID}>(No agent)</Select.Option>
          {models.map(m => (
            <Select.Option key={m.id} value={m.id}>
              {m.name}
            </Select.Option>
          ))}
        </Select>
      </div>
    )
  }

  return null
}

// Dispose the host-side capability bundle returned with a configurator frame, releasing the
// gatekeeper-side resources backing the iframe.
function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null) {
  const uiDisposable = frame?.ui as any
  uiDisposable?.[Symbol.dispose]?.()
}

function formatSuggestedResource(resourceUrl: string): string {
  try {
    const path = new URL(resourceUrl).pathname.replace(/^\/+|\/+$/g, '')
    return path || resourceUrl
  } catch {
    return resourceUrl
  }
}

// Renders the connection-wizard-style UI for a single gatekeeper binding: an account chooser
// scoped to the binding's required resource type, plus the vendor-supplied resource configurator
// iframe. The URL is collected from the iframe at submit time via `collectResourceUrl()`.
function BlueprintGatekeeperBindingField({
  title,
  binding,
  value,
  authenticatedApi,
  vendors,
  accounts,
  connectingVendor,
  reconnectingAccountId,
  onChange,
  onConnectAccount,
  onReconnectAccount,
  onReadyChange,
  onCollectorChange,
}: {
  title: string
  binding: Extract<BlueprintBinding, { type: 'gatekeeper' }>
  value: Partial<BlueprintBindingAssignment>
  authenticatedApi: RpcStub<AuthenticatedApi>
  vendors: {id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]
  accounts: AccountOption[]
  connectingVendor: string | null
  reconnectingAccountId: number | null
  onChange: (updates: Partial<BlueprintBindingAssignment>) => void
  onConnectAccount: (vendorId: string) => void
  onReconnectAccount: (accountId: number) => void
  onReadyChange: (ready: boolean) => void
  onCollectorChange: (collect: (() => Promise<string>) | null) => void
}) {
  const vendor = useMemo(
    () => vendors.find(v => v.id === binding.gatekeeperName) ?? null,
    [vendors, binding.gatekeeperName],
  )
  const resource = useMemo(
    () => vendor?.supportedResources.find(r => r.urlPattern === binding.typeUrlPattern) ?? null,
    [vendor, binding.typeUrlPattern],
  )

  const matchingAccounts = useMemo(() => accounts.filter(account =>
    account.vendorId === binding.gatekeeperName &&
    account.supportedResources.some(r => r.urlPattern === binding.typeUrlPattern)
  ), [accounts, binding.gatekeeperName, binding.typeUrlPattern])

  const selectedAccountId = (value as any).accountId ?? null
  const selectedAccount = matchingAccounts.find(a => a.id === selectedAccountId && a.credentialsValid) ?? null

  // The parent component re-renders frequently and passes us fresh inline callbacks each time.
  // Stash them in refs so effects below can call the latest versions without re-running every
  // render (which would otherwise re-spin the iframe in an infinite loop).
  const onChangeRef = useRef(onChange)
  const onReadyChangeRef = useRef(onReadyChange)
  const onCollectorChangeRef = useRef(onCollectorChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onReadyChangeRef.current = onReadyChange }, [onReadyChange])
  useEffect(() => { onCollectorChangeRef.current = onCollectorChange }, [onCollectorChange])

  // Auto-select the first valid account once accounts arrive.
  useEffect(() => {
    if (selectedAccountId !== null
        && matchingAccounts.some(a => a.id === selectedAccountId && a.credentialsValid)) {
      return
    }
    const first = matchingAccounts.find(a => a.credentialsValid)
    if (first) {
      onChangeRef.current({ accountId: first.id } as any)
    } else if (selectedAccountId !== null) {
      onChangeRef.current({ accountId: undefined } as any)
    }
  }, [matchingAccounts, selectedAccountId])

  // Configurator iframe state. We re-spin the iframe whenever the (account, resource) pair
  // changes; each frame is disposed when replaced or when the component unmounts.
  const [frameState, setFrameState] = useState<{ key: number, frame: ResourceConfiguratorFrame } | null>(null)
  const [frameLoading, setFrameLoading] = useState(false)
  const [frameError, setFrameError] = useState<string | null>(null)
  const frameRef = useRef<{ key: number, frame: ResourceConfiguratorFrame } | null>(null)
  const frameKeyRef = useRef(0)

  const replaceFrameState = useCallback((next: { key: number, frame: ResourceConfiguratorFrame } | null) => {
    const prev = frameRef.current
    if (prev?.frame !== next?.frame) disposeConfiguratorFrame(prev?.frame ?? null)
    frameRef.current = next
    setFrameState(next)
  }, [])

  // Stable callbacks for the configurator host. SandboxedResourceConfigurator's effect uses
  // `onCollectResourceUrlChange` as a dependency, so re-creating these inline each render would
  // cause the collector to briefly be unregistered (cleanup → re-register) on every parent
  // render, leaving a window where handleCreate could see an undefined collector.
  const stableOnCollectorChange = useCallback(
    (collect: (() => Promise<string>) | null) => onCollectorChangeRef.current(collect),
    [],
  )
  const stableOnReadyChange = useCallback(
    (ready: boolean | null) => onReadyChangeRef.current(ready === true),
    [],
  )

  useEffect(() => {
    return () => {
      disposeConfiguratorFrame(frameRef.current?.frame ?? null)
      frameRef.current = null
      onCollectorChangeRef.current(null)
      onReadyChangeRef.current(false)
    }
  }, [])

  useEffect(() => {
    if (!resource || !selectedAccount) {
      replaceFrameState(null)
      setFrameError(null)
      setFrameLoading(false)
      onReadyChangeRef.current(false)
      return
    }

    let cancelled = false
    setFrameLoading(true)
    setFrameError(null)
    onReadyChangeRef.current(false)
    replaceFrameState(null)

    authenticatedApi.startResourceConfigurator(selectedAccount.id, resource.urlPattern)
      .then(frame => {
        if (cancelled) {
          disposeConfiguratorFrame(frame)
          return
        }
        replaceFrameState({ key: ++frameKeyRef.current, frame })
      })
      .catch(err => {
        console.error('Failed to start resource configurator:', err)
        if (!cancelled) setFrameError(err?.message || 'Could not start configurator.')
      })
      .finally(() => {
        if (!cancelled) setFrameLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [authenticatedApi, selectedAccount?.id, resource?.urlPattern, replaceFrameState])

  // Bail out if the gatekeeper isn't installed locally or the required resource type isn't
  // offered by the vendor. The binding can't be satisfied in either case.
  if (!vendor) {
    return (
      <div className="rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger">
        <p className="font-semibold mb-0.5">{title}</p>
        <p>The "{binding.gatekeeperName}" gatekeeper is not available on this workshop, so this connection can't be configured.</p>
      </div>
    )
  }
  if (!resource) {
    return (
      <div className="rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger">
        <p className="font-semibold mb-0.5">{title}</p>
        <p>The required resource type for this binding isn't offered by {vendor.description.displayName}.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <AccountChooser
        accounts={matchingAccounts}
        selectedAccountId={selectedAccountId}
        vendorId={binding.gatekeeperName}
        vendorName={vendor.description.displayName}
        resourceTitle={resource.title}
        connecting={connectingVendor === binding.gatekeeperName}
        reconnectingAccountId={reconnectingAccountId}
        onSelect={(id) => onChange({ accountId: id } as any)}
        onConnect={() => onConnectAccount(binding.gatekeeperName)}
        onReconnect={onReconnectAccount}
      />

      {selectedAccount && (
        <div className="space-y-2.5">
          {binding.resourceUrl && (
            <p className="m-0 pl-[2px] text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Blueprint recommends: <span className="break-all text-kumo-default">{formatSuggestedResource(binding.resourceUrl)}</span>
            </p>
          )}

          <ResourceConfiguratorHost
            frame={frameState?.frame ?? null}
            frameKey={frameState?.key ?? null}
            loading={frameLoading}
            error={frameError}
            disabled={false}
            topOffset={10}
            onCollectResourceUrlChange={stableOnCollectorChange}
            onSelectionReadyChange={stableOnReadyChange}
          />
        </div>
      )}
    </div>
  )
}
