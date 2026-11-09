// Loading and instantiating the deployment's standard output formats. Shared by every surface that
// offers them, so "what happens when you pick a format" is decided once.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer, OutputFormatOffer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'

type AuthenticatedApiStub = ReturnType<typeof useAuthenticatedApi>['authenticatedApi']
type Navigate = ReturnType<typeof useNavigate>
type Toasts = ReturnType<typeof useKumoToastManager>

export type OutputFormats = {
  /** Empty until loaded, and on failure; callers render nothing rather than a spinner. */
  formats: OutputFormatOffer[]

  /** The blueprint id currently being instantiated, for a busy affordance. */
  creating: string | null

  create: (format: OutputFormatOffer) => Promise<void>
}

// Several surfaces ask for the list on the same screen, and it changes only when an admin edits
// the deployment's curation, so it is shared rather than fetched per component. Same TTL the
// command palette uses: an admin who just promoted a format sees it without reloading.
const FORMATS_CACHE_TTL_MS = 30_000
let formatsCache: { api: object; loaded: Promise<OutputFormatOffer[]>; fetchedAt: number } | null =
    null

function loadOutputFormats(api: AuthenticatedApiStub): Promise<OutputFormatOffer[]> {
  // Keyed on the stub as well as the clock, so a reconnect refetches rather than serving a list
  // fetched over a connection that no longer exists.
  if (formatsCache && formatsCache.api === api
      && Date.now() - formatsCache.fetchedAt < FORMATS_CACHE_TTL_MS) {
    return formatsCache.loaded
  }
  let loaded = api.listOutputFormats().then((list) => [...list])
  let entry = { api, loaded, fetchedAt: Date.now() }
  // A failed load must not be cached, or the shortcut stays missing for the whole TTL.
  loaded.catch(() => { if (formatsCache === entry) formatsCache = null })
  formatsCache = entry
  return loaded
}

/**
 * Instantiate a format, or route to its blueprint's landing page when it needs bindings wired up
 * first. Not a hook: the command palette calls this from its own command list, where a hook can't
 * go.
 */
export async function createFromFormat(
  api: AuthenticatedApiStub,
  navigate: Navigate,
  toasts: Toasts,
  format: OutputFormatOffer,
): Promise<void> {
  if (format.requiresSetup) {
    navigate({ to: '/blueprint/$id', params: { id: format.blueprintId } })
    return
  }

  // Disposed by hand rather than with `using`: Safari doesn't support explicit resource
  // management, and neither Vite's dev transform nor our ES2022 target lowers it, so one `using`
  // anywhere in the bundle is a parse error that fails the whole chunk.
  let overseer: RpcStub<Overseer> | undefined
  try {
    overseer = await api.newWorkspaceFromBlueprint(format.blueprintId, {})
    const { id } = await overseer.getMetadata()
    navigate({ to: '/workspace/$id', params: { id } })
  } catch (err) {
    console.error('Failed to create from format:', err)
    toasts.add({ title: `Couldn't create a new ${format.output.noun}`, variant: 'error' })
    throw err
  } finally {
    overseer?.[Symbol.dispose]()
  }
}

/** A gadget a format was made as. */
export type CreatedGadget = { id: WorkpieceId; title: string }

/**
 * Add a format's gadget to an existing workspace. Only for a format that
 * needs no setup: one that does has its accounts chosen on its blueprint's page, which makes a
 * workspace of its own.
 */
async function createInWorkspace(
  api: AuthenticatedApiStub,
  toasts: Toasts,
  workspaceId: string,
  format: OutputFormatOffer,
): Promise<CreatedGadget> {
  const overseer = api.openWorkspace(workspaceId)
  const gadget = overseer.createGadgetFromBlueprint(format.blueprintId)
  try {
    const [id, title] = await Promise.all([gadget.getId(), gadget.getTitle()])
    return { id, title }
  } catch (err) {
    console.error('Failed to add a format to the workspace:', err)
    toasts.add({ title: `Couldn't create a new ${format.output.noun}`, variant: 'error' })
    throw err
  } finally {
    gadget[Symbol.dispose]()
    overseer[Symbol.dispose]()
  }
}

/** A workspace to make formats in, rather than each in a workspace of its own. */
export type OutputFormatTarget = {
  workspaceId: string
  /** Shows the new gadget, which `create` has added to the workspace. */
  onCreated: (gadget: CreatedGadget, format: OutputFormatOffer) => void
}

/**
 * `enabled` defers the fetch until a surface is about to show the list, such as a menu opening.
 * With a `target`, the list is the formats that can be made in its workspace, and `create` adds
 * the new gadget there; without one, each is made in a workspace of its own and opened.
 */
export function useOutputFormats(enabled = true, target?: OutputFormatTarget): OutputFormats {
  const workspaceId = target?.workspaceId
  // Read through a ref: callers pass a new callback each render.
  const onCreatedRef = useRef(target?.onCreated)
  onCreatedRef.current = target?.onCreated
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const [formats, setFormats] = useState<OutputFormatOffer[]>([])
  const [creating, setCreating] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadOutputFormats(authenticatedApi)
      .then((list) => {
        if (!cancelled) setFormats(workspaceId === undefined ? list : list.filter(format => !format.requiresSetup))
      })
      .catch((err) => {
        // Nothing else depends on this, so a failure is a missing shortcut, not an error.
        console.error('Failed to load output formats:', err)
      })
    return () => {
      cancelled = true
    }
  }, [authenticatedApi, enabled, workspaceId])

  const create = useCallback(async (format: OutputFormatOffer) => {
    setCreating(format.blueprintId)
    try {
      if (workspaceId === undefined) await createFromFormat(authenticatedApi, navigate, toasts, format)
      else {
        const gadget = await createInWorkspace(authenticatedApi, toasts, workspaceId, format)
        // Staying on the page, so the row is free again once its gadget is shown.
        setCreating(null)
        onCreatedRef.current?.(gadget, format)
      }
    } catch {
      // Already reported; clear the busy state so the row can be retried. On success the component
      // is navigating away, so it stays busy.
      setCreating(null)
    }
  }, [authenticatedApi, navigate, toasts, workspaceId])

  return { formats, creating, create }
}
