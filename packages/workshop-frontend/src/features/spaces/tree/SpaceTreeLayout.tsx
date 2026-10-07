import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useMatch, useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  GadgetMetadata,
  GadgetMetadataWithTimestamps,
  Overseer,
  SpaceInfo,
  SpaceMemberRole,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { WorkshopButton } from '../../../components/WorkshopControls'
import { logRpcFailure } from '../../../rpcErrors'
import ShareModal from '../../../ShareModal'
import { MoveWorkspaceDialog } from '../preview/MoveWorkspaceDialog'
import { NewChildWorkspaceDialog } from '../preview/NewChildWorkspaceDialog'
import { WorkspacePreviewPane, type WorkspacePreviewActions } from '../preview/WorkspacePreviewPane'
import { SPACE_ACTION_CLASS_NAME } from '../SpaceEntryPoints'
import type { SpaceListing } from '../useSpaceListings'
import { WorkspaceAddressDialog } from '../WorkspaceAddressDialog'
import { SpaceTree, type SpaceTreeMember } from './SpaceTree'
import { applyMove, childrenOf, type WorkspaceMove } from './workspaceTree'

/**
 * Which of the user's own workspaces to show apart under the tree, as ones no listing the user
 * can see shows, and what the group says of them.
 */
export type UnlistedWorkspaces = {
  /**
   * Whether the user's own record of a workspace (`AuthenticatedApi.listGadgets`) is one to show
   * apart; false while the listings that would tell have not been read.
   */
  includes: (record: GadgetMetadataWithTimestamps) => boolean
  /** What the group's note says those workspaces are. */
  description: string
}

type UnlistedWorkspace = { id: string; title: string }

// The search parameter holding the previewed workspace's id, so that a preview can be linked to
// and Back returns to the one before.
const SELECTED_PARAM = 'selected'

const UNTITLED = 'Untitled Workspace'

// A new workspace registers with its space apart from the call that created it, so the listing
// is read again, this often and at most this many times, until it shows the new one.
const LISTING_RETRY_MS = 1000
const LISTING_RETRIES = 5

// One dialog at a time, each for the entry it was opened from.
type OpenDialog =
  | { kind: 'new-child'; parent: SpaceWorkspaceInfo }
  | { kind: 'move'; entry: SpaceWorkspaceInfo }
  | { kind: 'address'; entry: SpaceWorkspaceInfo }
  | { kind: 'share'; entry: SpaceWorkspaceInfo }

// The user's own records (`AuthenticatedApi.listGadgets`), read while `wanted` and again by
// `reread`, which resolves once the read has settled either way.
const useOwnRecords = (wanted: boolean): {
  records: readonly GadgetMetadataWithTimestamps[] | undefined
  reread: () => Promise<void>
} => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [read, setRead] = useState<{
    api: RpcStub<AuthenticatedApi>
    records: GadgetMetadataWithTimestamps[]
  } | null>(null)
  const latestRead = useRef(0)

  const reread = async () => {
    if (!wanted) return
    const request = ++latestRead.current
    try {
      const records = await authenticatedApi.listGadgets()
      if (request === latestRead.current) setRead({ api: authenticatedApi, records })
    } catch (err) {
      logRpcFailure('Failed to load workspaces:', err)
    }
  }

  useEffect(() => {
    if (!wanted) return
    void reread()
    // A read finishing after the effect is gone is set aside like a superseded one.
    return () => { latestRead.current++ }
  }, [authenticatedApi, wanted])

  return { records: read?.api === authenticatedApi ? read.records : undefined, reread }
}

// The previewed workspace's id, from the URL, and the way to preview another: a navigation of its
// own, so Back returns to the previous one. Every other search parameter is kept.
const useSelectedWorkspace = (): [string | undefined, (id: string) => void] => {
  const navigate = useNavigate()
  const { fullPath, params } = useMatch({ strict: false })
  const selected = useLocation({
    select: location => (location.search as Record<string, unknown>)[SELECTED_PARAM],
  })
  const select = (id: string) => void navigate({
    to: fullPath,
    params,
    search: (previous: Record<string, unknown>) => ({ ...previous, [SELECTED_PARAM]: id }),
  })
  return [typeof selected === 'string' && selected !== '' ? selected : undefined, select]
}

/**
 * A space's workspaces as its tree beside a live preview of the one selected, with what the user
 * may do to them: the tree's menu and the preview's header lead to the same dialogs, which are
 * held here (a new child workspace, a move, a change of address, the Share dialog). The selected
 * workspace is in the URL, so a preview can be linked and Back returns to the one before. Side by
 * side from the `md` breakpoint, stacked below it.
 *
 * A member of the space may rearrange the entries the space lets them move; a visitor's tree is
 * read-only and offers nothing a member does. Every move and creation is followed by a read of
 * the listing again (`onListingReload`). With `unlisted`, the user's own workspaces it picks out
 * are read and shown under the tree in a group of their own, and open their preview too.
 */
export const SpaceTreeLayout = ({ space, role, listing, onListingReload, unlisted }: {
  space: Pick<SpaceInfo, 'key' | 'kind'> & {
    /** What the space is called where it is shown (`spaceLabel`). */
    label: string
  }
  /** The user's role in the space; undefined for a visitor. */
  role: SpaceMemberRole | undefined
  /** What the space lists, as last read. */
  listing: SpaceListing
  /**
   * Reads what the space lists again, and whatever the caller shows beside it, resolving once the
   * read has settled either way.
   */
  onListingReload: () => Promise<void>
  unlisted?: UnlistedWorkspaces
}) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  const [selectedId, select] = useSelectedWorkspace()
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const [reloading, setReloading] = useState(false)
  const { records, reread } = useOwnRecords(unlisted !== undefined)
  // What a move made from the Move dialog says it did, and the entry the tree then focuses.
  const [dialogMove, setDialogMove] = useState<{ announcement: string; focus: { id: string } } | null>(null)
  // A workspace created here that the listing does not show yet, and how often it was read since.
  const [created, setCreated] = useState<{ id: string; reads: number } | null>(null)
  // The preview to take the focus when it shows: a new workspace's, whose creation removed the
  // button the focus was on.
  const focusPreviewOf = useRef<string | null>(null)
  const previewRef = useRef<HTMLElement>(null)

  const apart: readonly UnlistedWorkspace[] = unlisted && records
    ? records
      .filter(record => !record.owner && unlisted.includes(record))
      .map(({ id, title }) => ({ id, title }))
    : []

  // What the user's own records say of the workspaces apart can change with every change made
  // here, as what the space lists can.
  const reloadAll = async () => {
    await Promise.all([onListingReload(), reread()])
  }

  const entries = listing.status === 'ready' ? listing.workspaces : []
  const selectedEntry = entries.find(entry => entry.id === selectedId)
  const selectedUnlisted = apart.find(workspace => workspace.id === selectedId)
  const treeLabel = `Workspaces in ${space.label}`

  if (created && entries.some(entry => entry.id === created.id)) setCreated(null)
  const awaitingCreated = created !== null && listing.status === 'ready' && created.reads < LISTING_RETRIES

  const rereadForCreated = useEffectEvent(async () => {
    await reloadAll()
    setCreated(current => current && { ...current, reads: current.reads + 1 })
  })
  useEffect(() => {
    if (!awaitingCreated) return
    const timer = setTimeout(() => void rereadForCreated(), LISTING_RETRY_MS)
    return () => clearTimeout(timer)
  }, [awaitingCreated, created?.reads])

  const canMove = (entry: SpaceWorkspaceInfo) =>
    role === 'admin' || (role !== undefined && entry.owner.id === currentUser?.id)

  // The space checks who may move what.
  const moveWorkspace = async (id: string, parentId: string | null, beforeId: string | undefined) => {
    const opened = authenticatedApi.openSpace(space.key)
    try {
      await opened.moveWorkspace(id, parentId, ...(beforeId === undefined ? [] : [beforeId]))
    } finally {
      opened[Symbol.dispose]()
    }
  }

  // The listing is read again whether or not the space agreed, so the tree shows what it holds.
  const moveInTree = async (id: string, parentId: string | null, beforeId: string | undefined) => {
    try {
      await moveWorkspace(id, parentId, beforeId)
    } finally {
      void reloadAll()
    }
  }

  // A move made from the dialog is announced, and its entry focused, as one made in the tree is,
  // once the listing read again shows it: the entry's row is a new one when its parent changed.
  // A refused one stays in the dialog, which shows why.
  const moveFromDialog = async (entry: SpaceWorkspaceInfo, move: WorkspaceMove) => {
    try {
      await moveWorkspace(entry.id, move.parentId, move.beforeId)
    } catch (err) {
      void reloadAll()
      throw err
    }
    setDialog(null)
    const moved = applyMove(entries, entry.id, move)
    const position = childrenOf(moved, move.parentId).findIndex(sibling => sibling.id === entry.id) + 1
    const parent = moved.find(candidate => candidate.id === move.parentId)
    await reloadAll()
    setDialogMove({
      announcement: `${entry.title || UNTITLED} moved to position ${position} in ${
        parent ? parent.title || UNTITLED : treeLabel}.`,
      focus: { id: entry.id },
    })
  }

  const member: SpaceTreeMember | null = role !== undefined && currentUser
    ? {
        role,
        profileId: currentUser.id,
        onMove: moveInTree,
        actions: {
          onNewChild: parent => setDialog({ kind: 'new-child', parent }),
          onMove: entry => setDialog({ kind: 'move', entry }),
          onChangeAddress: entry => setDialog({ kind: 'address', entry }),
          onShare: entry => setDialog({ kind: 'share', entry }),
        },
      }
    : null

  const previewActions = (entry: SpaceWorkspaceInfo | undefined): WorkspacePreviewActions => {
    if (!entry || !member) return {}
    return {
      onNewChild: () => setDialog({ kind: 'new-child', parent: entry }),
      ...(canMove(entry) && {
        onMove: () => setDialog({ kind: 'move', entry }),
        onAddressChange: () => setDialog({ kind: 'address', entry }),
      }),
    }
  }

  const openEntry = (entry: SpaceWorkspaceInfo) => void (entry.slug === undefined
    ? navigate({ to: '/workspace/$id', params: { id: entry.id } })
    : navigate({ to: '/spaces/$spaceKey/$slug', params: { spaceKey: space.key, slug: entry.slug } }))

  const reloadListing = async () => {
    setReloading(true)
    try {
      await reloadAll()
    } finally {
      setReloading(false)
    }
  }

  const closeDialog = () => setDialog(null)
  const reloadAfter = () => {
    setDialog(null)
    void reloadAll()
  }

  const previewed = selectedEntry ?? selectedUnlisted ?? (selectedId ? { id: selectedId, title: '' } : undefined)

  useLayoutEffect(() => {
    if (previewed === undefined || focusPreviewOf.current !== previewed.id) return
    focusPreviewOf.current = null
    previewRef.current?.focus()
  })

  // Stacked below `md`, the layout grows with its content and the page scrolls; side by side, it
  // fills the page's height and each pane scrolls on its own.
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-kumo-line md:h-full md:min-h-0 md:flex-row">
      <aside
        aria-label="Browse workspaces"
        className="flex max-h-72 shrink-0 flex-col overflow-y-auto border-b border-kumo-line bg-kumo-elevated py-2 md:max-h-none md:w-72 md:border-b-0 md:border-r"
      >
        {listing.status === 'loading' && (
          <div role="status" aria-label="Loading this space’s workspaces" className="flex flex-col gap-1 px-3">
            {[0, 1, 2].map(row => <div key={row} className="h-7 animate-pulse rounded-md bg-kumo-fill" />)}
          </div>
        )}
        {listing.status === 'failed' && (
          <div role="alert" className="flex flex-col items-start gap-2 px-3 py-2">
            <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load this space’s workspaces.</p>
            <WorkshopButton className={SPACE_ACTION_CLASS_NAME} loading={reloading} onClick={() => void reloadListing()}>
              Try again
            </WorkshopButton>
          </div>
        )}
        {listing.status === 'refused' && (
          <p role="alert" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-default">
            You are no longer a member of this space.
          </p>
        )}
        {listing.status === 'ready' && entries.length === 0 && (
          <p className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">No workspaces in this space yet.</p>
        )}
        {listing.status === 'ready' && (
          <SpaceTree
            listing={entries}
            label={treeLabel}
            selectedId={selectedEntry?.id}
            onSelect={select}
            onOpen={openEntry}
            member={member}
            focusRequest={dialogMove?.focus}
          />
        )}
        {unlisted && apart.length > 0 && (
          <UnlistedGroup
            workspaces={apart}
            description={unlisted.description}
            selectedId={selectedUnlisted?.id}
            onSelect={select}
          />
        )}
      </aside>

      <div className="flex h-[70dvh] min-h-96 min-w-0 flex-col md:h-auto md:min-h-0 md:flex-1">
        {previewed ? (
          <WorkspacePreviewPane
            ref={previewRef}
            workspace={previewed}
            place={selectedEntry ? { space: { key: space.key, name: space.label }, listing: entries } : undefined}
            actions={previewActions(selectedEntry)}
            onPublicAccessChange={() => void reloadAll()}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-[13px] leading-[18px] text-kumo-subtle">Select a workspace to preview it here.</p>
          </div>
        )}
      </div>

      {dialog?.kind === 'new-child' && (
        <NewChildWorkspaceDialog
          spaceKey={space.kind === 'team' ? space.key : undefined}
          parent={dialog.parent}
          listing={entries}
          onClose={closeDialog}
          onCreated={(id) => {
            reloadAfter()
            setCreated({ id, reads: 0 })
            focusPreviewOf.current = id
            select(id)
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveWorkspaceDialog
          key={dialog.entry.id}
          workspace={dialog.entry}
          listing={entries}
          onClose={closeDialog}
          onMove={(parentId, beforeId) => moveFromDialog(dialog.entry, { parentId, beforeId })}
        />
      )}
      {dialog?.kind === 'address' && (
        <WorkspaceAddressDialog
          spaceKey={space.key}
          workspace={dialog.entry}
          onClose={closeDialog}
          onChanged={reloadAfter}
        />
      )}
      {dialog?.kind === 'share' && (
        <EntryShareModal
          workspaceId={dialog.entry.id}
          onClose={closeDialog}
          onPublicAccessChange={() => void reloadAll()}
        />
      )}
      <p role="status" className="sr-only">{dialogMove?.announcement}</p>
    </div>
  )
}

// The user's own workspaces no listing shows them, under a heading and a note on why they are apart.
const UnlistedGroup = ({ workspaces, description, selectedId, onSelect }: {
  workspaces: readonly UnlistedWorkspace[]
  description: string
  selectedId: string | undefined
  onSelect: (id: string) => void
}) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="mt-3 flex flex-col gap-0.5 border-t border-kumo-line px-2 pt-3">
      <h2 id={headingId} className="px-2 text-[12px] leading-4 font-semibold text-kumo-default">Unlisted</h2>
      <p className="px-2 pb-1 text-[12px] leading-4 text-kumo-subtle">{description}</p>
      <ul className="flex flex-col gap-0.5">
        {workspaces.map(workspace => (
          <li key={workspace.id}>
            <button
              type="button"
              aria-current={workspace.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(workspace.id)}
              className="w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left text-[13px] leading-[18px] text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:bg-kumo-tint aria-[current=true]:bg-kumo-tint aria-[current=true]:font-medium"
            >
              {workspace.title || UNTITLED}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// The Share dialog for an entry chosen from the tree's menu, which need not be the one previewed:
// the workspace is opened for as long as the dialog is up.
const EntryShareModal = ({ workspaceId, onClose, onPublicAccessChange }: {
  workspaceId: string
  onClose: () => void
  onPublicAccessChange: () => void
}) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  // The stub is held inside the state object, never as the state itself: React would call it.
  const [opened, setOpened] = useState<{ overseer: RpcStub<Overseer>; metadata: GadgetMetadata } | null>(null)

  const fail = useEffectEvent((err: unknown) => {
    logRpcFailure('Failed to open a workspace for sharing:', err)
    toasts.add({ title: 'Failed to open share settings', variant: 'error' })
    onClose()
  })

  useEffect(() => {
    let cancelled = false
    // Not awaited: the metadata read is pipelined on the open, and disposing the promise disposes
    // the workspace it resolves to.
    const overseer: RpcStub<Overseer> = authenticatedApi.openGadget(workspaceId)
    overseer.getMetadata().then(
      (metadata) => { if (!cancelled) setOpened({ overseer, metadata }) },
      (err: unknown) => { if (!cancelled) fail(err) },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [authenticatedApi, workspaceId])

  if (!opened) return null
  return (
    <ShareModal
      open
      onClose={onClose}
      overseer={opened.overseer}
      metadata={opened.metadata}
      currentUser={currentUser}
      authenticatedApi={authenticatedApi}
      onPublicAccessChange={onPublicAccessChange}
    />
  )
}
