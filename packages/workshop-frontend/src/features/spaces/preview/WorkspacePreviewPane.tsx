import { useState, type Ref } from 'react'
import type { RpcStub } from 'capnweb'
import { Loader } from '@cloudflare/kumo'
import { ArrowSquareOut, ArrowsClockwise, ArrowsDownUp, LinkSimple, Plus, ShareNetwork } from '@phosphor-icons/react'
import type {
  CollaboratorRole,
  GadgetMetadata,
  Overseer,
  SpaceSyncJobInfo,
  SpaceWorkspaceInfo,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { WorkshopButton } from '../../../components/WorkshopControls'
import GadgetUI from '../../../GadgetUI'
import ShareModal from '../../../ShareModal'
import { PublishedBadge } from '../PublishedBadge'
import { SPACE_ACTION_CLASS_NAME } from '../SpaceEntryPoints'
import { ResyncWorkspaceDialog } from '../sync/ResyncWorkspaceDialog'
import { hiddenByTitle } from '../tree/workspaceTree'
import type { WorkspaceAddress } from '../workspaceAddress'
import { WorkspaceLink } from '../WorkspaceLink'
import { useWorkspaceGadgets } from './useWorkspaceGadgets'
import { useWorkspacePreview, type WorkspacePreviewFailure } from './useWorkspacePreview'
import { WorkspaceBreadcrumbs } from './WorkspaceBreadcrumbs'
import { WorkspaceGadgetTabs } from './WorkspaceGadgetTabs'

/**
 * The actions the pane's header offers besides Open and Share, each present only when the
 * caller lets the viewer take it. The caller owns the dialogs they lead to.
 */
export type WorkspacePreviewActions = {
  /** Creates a workspace under this one in the space's tree. */
  onNewChild?: () => void
  /** Moves this workspace elsewhere in the space's tree. */
  onMove?: () => void
  /** Changes this workspace's address in the space. */
  onAddressChange?: () => void
}

/**
 * A re-sync of the previewed workspace from the source a sync created it from, offered to its
 * owner while the account that synced it can sync into the workspace's space.
 */
export type WorkspaceResync = {
  /** What the workspace's source is called: the display name of that account's vendor. */
  sourceName: string
  /** A sync of the user's into the workspace's space is running, so the server would refuse. */
  syncRunning: boolean
  /**
   * A re-sync was started, and `job` is as the server recorded it. Showing its progress is the
   * caller's, with the space's other syncs.
   */
  onStarted: (job: SpaceSyncJobInfo) => void
}

/** Where a previewed workspace sits: the space whose listing holds it, and that listing. */
export type WorkspacePreviewPlace = {
  space: { key: string; name: string }
  /** The space's listing, as `Space.listWorkspaces` returns it. */
  listing: readonly SpaceWorkspaceInfo[]
}

const OPEN_LINK_CLASS_NAME =
  'inline-flex h-7 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 text-[12px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-elevated'

const FAILURES: Record<WorkspacePreviewFailure, { title: string; message: string; retryable: boolean }> = {
  'needs-setup': {
    title: 'Open the workspace to finish setting it up',
    message: 'It uses connected services, and you need to choose your accounts for them before it can be shown.',
    retryable: false,
  },
  'access-denied': {
    title: 'You don’t have access to this workspace',
    message: 'Ask the workspace owner to grant you access, then try again.',
    retryable: true,
  },
  'not-found': {
    title: 'Workspace not found',
    message: 'It may have been deleted.',
    retryable: false,
  },
  'share-links-disabled': {
    title: 'Share links are turned off for this workspace',
    message: 'Ask the workspace owner to add you directly, then try again.',
    retryable: true,
  },
  // The server names no workspace, so neither does this.
  'not-visible': {
    title: 'This workspace isn’t visible yet',
    message: 'It’s published, but a workspace above it in its space isn’t. Ask the workspace owner, then try again.',
    retryable: true,
  },
  unexpected: {
    title: 'Couldn’t load a preview of this workspace',
    message: 'Try again, or open the workspace.',
    retryable: true,
  },
}

type PaneProps = {
  /** The workspace as the caller lists it, named by its title until its own metadata arrives. */
  workspace: Pick<SpaceWorkspaceInfo, 'id' | 'title'>
  /** Undefined for a workspace no space lists. */
  place: WorkspacePreviewPlace | undefined
  actions: WorkspacePreviewActions
  resync?: WorkspaceResync
  /**
   * Changes each time a sync into the workspace's space is seen to end, which may have replaced
   * the workspace's content: the preview is then opened again.
   */
  syncEndedKey?: string
  /**
   * The owner published the workspace with this role from the Share dialog, or with null
   * withdrew the publication: the listing's entry for it changes with it.
   */
  onPublicAccessChange?: (role: CollaboratorRole | null) => void
  /** The preview's region, which can take the focus. */
  ref?: Ref<HTMLElement>
}

/**
 * A live preview of one workspace beside a tree of them: a header with its place in the space,
 * its title and what the viewer may do with it, over its gadgets as the viewer's role shows
 * them, with no chat and no editor. A workspace whose open needs the viewer to choose connected
 * accounts, or that they may not open, says so in place of its gadgets. Everything the preview
 * holds belongs to one workspace, and starts afresh for another.
 *
 * With `resync`, the header offers 'Re-sync from source', which asks for confirmation first
 * (`ResyncWorkspaceDialog`). Whenever a sync ends (`syncEndedKey`), a re-sync or one that found
 * the workspace again, the preview is opened again, to show what the source replaced.
 */
export const WorkspacePreviewPane = (props: PaneProps) => (
  <WorkspacePreview key={props.workspace.id} {...props} />
)

const WorkspacePreview = ({ workspace, place, actions, resync, syncEndedKey, onPublicAccessChange, ref }: PaneProps) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const preview = useWorkspacePreview(workspace.id)
  const [shareOpen, setShareOpen] = useState(false)
  const [resyncOpen, setResyncOpen] = useState(false)
  // The syncs seen to have ended when the preview was last opened.
  const [openedAfter, setOpenedAfter] = useState(syncEndedKey)
  if (openedAfter !== syncEndedKey) {
    setOpenedAfter(syncEndedKey)
    preview.retry()
  }

  const entry = place?.listing.find(candidate => candidate.id === workspace.id)
  const address = place && entry?.slug !== undefined ? { spaceKey: place.space.key, slug: entry.slug } : undefined
  // The unpublished entry above that holds back the workspace's publication, by its title when the
  // listing holds it.
  const hiddenBy = place && entry?.hiddenBy !== undefined
    ? { title: hiddenByTitle(place.listing, entry) }
    : undefined
  const title = (preview.state === 'ready' ? preview.metadata.title : workspace.title) || 'Untitled Workspace'
  const canShare = preview.state === 'ready' && preview.metadata.role !== 'use'

  return (
    <section ref={ref} tabIndex={-1} aria-label={`Preview of ${title}`} className="flex h-full min-h-0 flex-col outline-none">
      <header className="flex shrink-0 flex-col gap-2 border-b border-kumo-line px-4 py-3">
        {place && entry && (
          <WorkspaceBreadcrumbs space={place.space} listing={place.listing} workspaceId={workspace.id} />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-[16px] leading-6 font-semibold tracking-[-0.3px] text-kumo-default">
              {title}
            </h2>
            {entry?.published && <PublishedBadge role={entry.published} />}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <WorkspaceLink id={workspace.id} address={address} className={OPEN_LINK_CLASS_NAME}>
              <ArrowSquareOut size={13} aria-hidden="true" />
              Open
            </WorkspaceLink>
            {actions.onNewChild && (
              <WorkshopButton className={SPACE_ACTION_CLASS_NAME} onClick={actions.onNewChild}>
                <Plus size={12} weight="bold" aria-hidden="true" />
                New child workspace
              </WorkshopButton>
            )}
            {actions.onMove && (
              <WorkshopButton className={SPACE_ACTION_CLASS_NAME} onClick={actions.onMove}>
                <ArrowsDownUp size={13} aria-hidden="true" />
                Move…
              </WorkshopButton>
            )}
            {actions.onAddressChange && (
              <WorkshopButton className={SPACE_ACTION_CLASS_NAME} onClick={actions.onAddressChange}>
                <LinkSimple size={13} aria-hidden="true" />
                Change address
              </WorkshopButton>
            )}
            {canShare && (
              <WorkshopButton className={SPACE_ACTION_CLASS_NAME} onClick={() => setShareOpen(true)}>
                <ShareNetwork size={13} aria-hidden="true" />
                Share
              </WorkshopButton>
            )}
            {resync && (
              <WorkshopButton className={SPACE_ACTION_CLASS_NAME} onClick={() => setResyncOpen(true)}>
                <ArrowsClockwise size={13} aria-hidden="true" />
                Re-sync from source
              </WorkshopButton>
            )}
          </div>
        </div>
        {hiddenBy && (
          <p className="text-[12px] leading-4 text-kumo-subtle">
            {hiddenBy.title === undefined
              ? 'Not visible to others until a workspace above it is published'
              : `Not visible to others until “${hiddenBy.title || 'Untitled Workspace'}” is published`}
          </p>
        )}
      </header>

      {preview.state === 'ready' ? (
        <PreviewGadgets overseer={preview.overseer} metadata={preview.metadata} />
      ) : preview.state === 'failed' ? (
        <PreviewFailure
          failure={preview.failure}
          workspace={{ id: workspace.id, address }}
          onRetry={preview.retry}
        />
      ) : (
        <PreviewLoading />
      )}

      {shareOpen && preview.state === 'ready' && (
        <ShareModal
          open
          onClose={() => setShareOpen(false)}
          overseer={preview.overseer}
          metadata={preview.metadata}
          currentUser={currentUser}
          authenticatedApi={authenticatedApi}
          onPublicAccessChange={onPublicAccessChange}
        />
      )}
      {resyncOpen && resync && (
        <ResyncWorkspaceDialog
          workspace={{ id: workspace.id, title }}
          sourceName={resync.sourceName}
          syncRunning={resync.syncRunning}
          onClose={() => setResyncOpen(false)}
          onStarted={(job) => {
            setResyncOpen(false)
            resync.onStarted(job)
          }}
        />
      )}
    </section>
  )
}

const PreviewGadgets = ({ overseer, metadata }: {
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
}) => {
  const [requestedId, setRequestedId] = useState<WorkpieceId | undefined>()
  const { gadgets, selectedId, gadget, ready } = useWorkspaceGadgets(overseer, metadata.defaultGadgetId, requestedId)

  if (ready && gadgets.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <p className="text-sm text-kumo-subtle">This workspace has no gadgets yet.</p>
      </div>
    )
  }
  return (
    <>
      <WorkspaceGadgetTabs gadgets={gadgets} selectedId={selectedId} onSelect={setRequestedId} />
      <div className="min-h-0 flex-1">
        {gadget ? <GadgetUI key={selectedId} gadget={gadget} height="100%" isVisible /> : <PreviewLoading />}
      </div>
    </>
  )
}

const PreviewLoading = () => (
  <div role="status" aria-label="Loading the preview" className="flex min-h-0 flex-1 items-center justify-center">
    <Loader size="lg" />
  </div>
)

const PreviewFailure = ({ failure, workspace, onRetry }: {
  failure: WorkspacePreviewFailure
  /** Where the workspace opens, which is where a workspace that needs setting up is set up. */
  workspace: { id: string; address: WorkspaceAddress | undefined }
  onRetry: () => void
}) => {
  const { title, message, retryable } = FAILURES[failure]
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
      {/* Announced, but the focus stays in the tree the viewer is moving through. */}
      <div role="status" aria-atomic="true" className="flex max-w-md flex-col items-center gap-2 text-center">
        <h3 className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">{title}</h3>
        <p className="text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">{message}</p>
        {failure === 'needs-setup' && (
          <WorkspaceLink id={workspace.id} address={workspace.address} className={`mt-2 ${OPEN_LINK_CLASS_NAME}`}>
            Open the workspace
          </WorkspaceLink>
        )}
        {retryable && (
          <WorkshopButton className={`mt-2 ${SPACE_ACTION_CLASS_NAME}`} onClick={onRetry}>
            Try again
          </WorkshopButton>
        )}
      </div>
    </div>
  )
}
