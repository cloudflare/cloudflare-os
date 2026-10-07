import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowSquareOut, ArrowsClockwise, ShareNetwork, SquaresFour } from '@phosphor-icons/react'
import { HierarchicalList, type HierarchicalListItem } from '@gadgets/ui/hierarchical-list'
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
import { WorkspacePreviewPane } from '../preview/WorkspacePreviewPane'
import { SPACE_ACTION_CLASS_NAME } from '../SpaceEntryPoints'
import { ResyncWorkspaceDialog } from '../sync/ResyncWorkspaceDialog'
import type { SpaceSync } from '../sync/useSpaceSync'
import type { SpaceListing } from '../useSpaceListings'
import { WorkspaceAddressDialog } from '../WorkspaceAddressDialog'
import { SpaceTree, type SpaceTreeEntryActions, type SpaceTreeMember } from './SpaceTree'
import { useSelectedWorkspace } from './useSelectedWorkspace'
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

// A workspace by its id and title, as the dialogs opened for it need it.
type NamedWorkspace = { id: string; title: string }

const UNTITLED = 'Untitled Workspace'

// A new workspace registers with its space apart from the call that created it, so the listing
// is read again, this often and at most this many times, until it shows the new one.
const LISTING_RETRY_MS = 1000
const LISTING_RETRIES = 5

// One dialog at a time, each for the entry, or the workspace shown apart, it was opened from.
type OpenDialog =
  | { kind: 'new-child'; parent: SpaceWorkspaceInfo }
  | { kind: 'move'; entry: SpaceWorkspaceInfo }
  | { kind: 'address'; entry: SpaceWorkspaceInfo }
  | { kind: 'share'; workspace: NamedWorkspace }
  // What the source is called is kept from when the menu offered the re-sync, so the dialog stays
  // up, and gives the focus back as it closes, if the records or accounts change meanwhile.
  | { kind: 'resync'; workspace: NamedWorkspace; sourceName: string }

// The user's own records (`AuthenticatedApi.listGadgets`), read on mount and again by `reread`,
// which resolves once the read has settled either way.
const useOwnRecords = (): {
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
    const request = ++latestRead.current
    try {
      const records = await authenticatedApi.listGadgets()
      if (request === latestRead.current) setRead({ api: authenticatedApi, records })
    } catch (err) {
      logRpcFailure('Failed to load workspaces:', err)
    }
  }

  useEffect(() => {
    void reread()
    // A read finishing after the effect is gone is set aside like a superseded one.
    return () => { latestRead.current++ }
  }, [authenticatedApi])

  return { records: read?.api === authenticatedApi ? read.records : undefined, reread }
}

/**
 * A space's workspaces as its tree beside a live preview of the one selected, with what the user
 * may do to them: each row's menu leads to the dialogs held here (a new child workspace, a move,
 * a change of address, the Share dialog, a re-sync), each of which gives the focus back to what
 * opened the menu as it closes, except a move the Move dialog made, after which the tree focuses
 * the moved entry's row. The selected workspace is in the URL, so a preview can be linked
 * and Back returns to the one before. Side by side from the `md` breakpoint, stacked below it.
 *
 * A member of the space may rearrange the entries the space lets them move; a visitor's tree is
 * read-only and offers nothing a member does. Every move and creation is followed by a read of
 * the listing again (`onListingReload`). With `unlisted`, the user's own workspaces it picks out
 * are read and shown under the tree in a group of their own, and open their preview too.
 *
 * Share is offered on an entry the user owns, and on one their own records say was shared with
 * them to build, which is what lets them share it: membership of the space does not. With `sync`,
 * a workspace of the user's own that a sync into this space created offers a re-sync from its
 * source, while the account that synced it can sync here.
 */
export const SpaceTreeLayout = ({ space, role, listing, onListingReload, unlisted, sync }: {
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
  /** The page's syncs into this space (`useSpaceSync`). */
  sync?: SpaceSync
}) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  const [selectedId, select] = useSelectedWorkspace()
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const [reloading, setReloading] = useState(false)
  // The user's own records also say which workspaces they may share and which a sync created.
  const { records, reread } = useOwnRecords()
  // What a move made from the Move dialog says it did, and the entry the tree then focuses.
  const [dialogMove, setDialogMove] = useState<{ announcement: string; focus: { id: string } } | null>(null)
  // A workspace created here that the listing does not show yet, and how often it was read since.
  const [created, setCreated] = useState<{ id: string; reads: number } | null>(null)

  const apart: readonly NamedWorkspace[] = unlisted && records
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

  // A sync that ended may have created workspaces, whose records say they can be re-synced.
  const rereadRecords = useEffectEvent(() => void reread())
  const endedKey = sync?.endedKey ?? ''
  useEffect(() => {
    if (endedKey !== '') rereadRecords()
  }, [endedKey])

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
        },
      }
    : null

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

  // A re-sync of a workspace of the user's own from the source a sync created it from is offered
  // while the account that synced it can sync here, and is named by that account's vendor. It goes
  // into the space the workspace is in, so it is offered only for one of this space's, whose job
  // is among this space's jobs. A record names only a team space.
  const resyncSourceOf = (id: string): string | undefined => {
    const record = records?.find(candidate => candidate.id === id && !candidate.owner)
    const recordSpaceKey = record?.spaceKey ?? (space.kind === 'personal' ? space.key : undefined)
    if (!sync || !record?.syncedFrom || recordSpaceKey !== space.key) return undefined
    const { accountId } = record.syncedFrom
    return sync.accounts.find(candidate => candidate.id === accountId)?.vendorName
  }

  // A record of a workspace shared with the user gives the role its own sharing gives them, absent
  // meaning build.
  const canShare = (entry: SpaceWorkspaceInfo) => entry.owner.id === currentUser?.id
    || (records?.some(record => record.id === entry.id && record.owner && record.role !== 'use') ?? false)

  const actionsFor = (workspace: NamedWorkspace, shareable: boolean): SpaceTreeEntryActions => {
    const sourceName = resyncSourceOf(workspace.id)
    return {
      ...(shareable && { onShare: () => setDialog({ kind: 'share', workspace }) }),
      ...(sourceName !== undefined && { onResync: () => setDialog({ kind: 'resync', workspace, sourceName }) }),
    }
  }

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
            entryActions={entry => actionsFor(entry, canShare(entry))}
            focusRequest={dialogMove?.focus}
          />
        )}
        {unlisted && apart.length > 0 && (
          <UnlistedGroup
            workspaces={apart}
            description={unlisted.description}
            selectedId={selectedUnlisted?.id}
            onSelect={select}
            onOpen={workspace => void navigate({ to: '/workspace/$id', params: { id: workspace.id } })}
            // The workspaces shown apart are the user's own, which they may share.
            workspaceActions={workspace => actionsFor(workspace, true)}
          />
        )}
      </aside>

      <div className="flex h-[70dvh] min-h-96 min-w-0 flex-col md:h-auto md:min-h-0 md:flex-1">
        {previewed ? (
          <WorkspacePreviewPane
            workspace={previewed}
            place={selectedEntry ? { space: { key: space.key, name: space.label }, listing: entries } : undefined}
            syncEndedKey={endedKey}
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
          workspaceId={dialog.workspace.id}
          onClose={closeDialog}
          onPublicAccessChange={() => void reloadAll()}
        />
      )}
      {dialog?.kind === 'resync' && (
        <ResyncWorkspaceDialog
          workspace={dialog.workspace}
          sourceName={dialog.sourceName}
          syncRunning={sync?.jobs.running !== undefined}
          onClose={closeDialog}
          // Its progress shows with the space's other syncs.
          onStarted={(job) => {
            setDialog(null)
            sync?.follow(job)
          }}
        />
      )}
      <p role="status" className="sr-only">{dialogMove?.announcement}</p>
    </div>
  )
}

// The user's own workspaces no listing shows them, under a heading and a note on why they are
// apart, each with a menu as the tree's rows have.
const UnlistedGroup = ({ workspaces, description, selectedId, onSelect, onOpen, workspaceActions }: {
  workspaces: readonly NamedWorkspace[]
  description: string
  selectedId: string | undefined
  onSelect: (id: string) => void
  onOpen: (workspace: NamedWorkspace) => void
  workspaceActions: (workspace: NamedWorkspace) => SpaceTreeEntryActions
}) => {
  const headingId = useId()
  const byId = new Map(workspaces.map(workspace => [workspace.id, workspace]))

  const renderMenu = (item: HierarchicalListItem) => {
    const workspace = byId.get(item.id)
    if (!workspace) return null
    const { onShare, onResync } = workspaceActions(workspace)
    return (
      <>
        <DropdownMenu.Item icon={ArrowSquareOut} onClick={() => onOpen(workspace)}>Open</DropdownMenu.Item>
        {onShare && <DropdownMenu.Item icon={ShareNetwork} onClick={onShare}>Share</DropdownMenu.Item>}
        {onResync && (
          <DropdownMenu.Item icon={ArrowsClockwise} onClick={onResync}>Re-sync from source</DropdownMenu.Item>
        )}
      </>
    )
  }

  return (
    <section aria-labelledby={headingId} className="mt-3 flex flex-col gap-0.5 border-t border-kumo-line pt-3">
      <h2 id={headingId} className="px-4 text-[12px] leading-4 font-semibold text-kumo-default">Unlisted</h2>
      <p className="px-4 pb-1 text-[12px] leading-4 text-kumo-subtle">{description}</p>
      <HierarchicalList
        items={workspaces.map(workspace => ({
          id: workspace.id,
          name: workspace.title || UNTITLED,
          icon: <SquaresFour aria-hidden="true" size={18} className="shrink-0 text-kumo-subtle" />,
        }))}
        label="Unlisted workspaces"
        selectedId={selectedId}
        onItemClick={item => onSelect(item.id)}
        renderContextMenu={renderMenu}
        showRowActions
      />
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
