import { useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Loader } from '@cloudflare/kumo'
import { ArrowSquareOut } from '@phosphor-icons/react'
import type { GadgetMetadata, Overseer, SpaceWorkspaceInfo, WorkpieceId } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../../components/WorkshopControls'
import GadgetUI from '../../../GadgetUI'
import { PublishedIndicator, publicationHeldBack } from '../PublishedIndicator'
import { SPACE_ACTION_CLASS_NAME } from '../SpaceEntryPoints'
import type { WorkspaceAddress } from '../workspaceAddress'
import { WorkspaceLink } from '../WorkspaceLink'
import { useWorkspaceGadgets } from './useWorkspaceGadgets'
import { useWorkspacePreview, type WorkspacePreviewFailure } from './useWorkspacePreview'
import { WorkspaceBreadcrumbs } from './WorkspaceBreadcrumbs'
import { WorkspaceGadgetTabs } from './WorkspaceGadgetTabs'

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
  /**
   * Changes each time a sync into the workspace's space is seen to end, which may have replaced
   * the workspace's content: the preview is then opened again.
   */
  syncEndedKey?: string
}

/**
 * A live preview of one workspace beside a tree of them: a header with its place in the space,
 * its title, whether it is published and a link that opens it, over its gadgets as the viewer's
 * role shows them, with no chat and no editor. What else the viewer may do with the workspace is
 * in its row's menu in the tree. A workspace whose open needs the viewer to choose connected
 * accounts, or that they may not open, says so in place of its gadgets. Everything the preview
 * holds belongs to one workspace, and starts afresh for another.
 *
 * Whenever a sync ends (`syncEndedKey`), a re-sync or one that found the workspace again, the
 * preview is opened again, to show what the source replaced.
 */
export const WorkspacePreviewPane = (props: PaneProps) => (
  <WorkspacePreview key={props.workspace.id} {...props} />
)

const WorkspacePreview = ({ workspace, place, syncEndedKey }: PaneProps) => {
  const preview = useWorkspacePreview(workspace.id)
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
  const heldBack = place && entry ? publicationHeldBack(place.listing, entry) : undefined
  const title = (preview.state === 'ready' ? preview.metadata.title : workspace.title) || 'Untitled Workspace'

  return (
    <section aria-label={`Preview of ${title}`} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-kumo-line px-4 py-3">
        {place && entry && (
          <WorkspaceBreadcrumbs space={place.space} listing={place.listing} workspaceId={workspace.id} />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-[16px] leading-6 font-semibold tracking-[-0.3px] text-kumo-default">
              {title}
            </h2>
            {entry?.published && (
              <PublishedIndicator
                access={entry.published}
                heldBack={heldBack}
              />
            )}
          </div>
          <WorkspaceLink id={workspace.id} address={address} className={OPEN_LINK_CLASS_NAME}>
            <ArrowSquareOut size={13} aria-hidden="true" />
            Open
          </WorkspaceLink>
        </div>
        {heldBack && (
          <p className="text-[12px] leading-4 text-kumo-subtle">
            {heldBack.blockerTitle === undefined
              ? 'Not visible to others until a workspace above it is published'
              : `Not visible to others until “${heldBack.blockerTitle}” is published`}
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
