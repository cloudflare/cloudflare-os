import { useCallback, useState, type ReactNode } from 'react'
import { Badge, Tooltip } from '@cloudflare/kumo'
import { Clock, Eye } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  AuthenticatedApi,
  Overseer,
  GadgetClient,
  WorkpieceId,
  GadgetSummary,
  GadgetAccessMode,
} from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'
import { WorkshopButton } from './components/WorkshopControls'
import { GadgetPresence } from './components/GadgetPresence'
import { SharedAppFrame } from './pages/shared-app/SharedAppPage'
import SharedViewPane, { type SharedViewChrome } from './features/shared-view/SharedViewPane'

// An app full screen (Figma "MacBook Pro 14\" - 24"): the frame's top bar plus the gadget's
// deployed UI, and nothing else. It is the whole experience for a "use"-only collaborator.
// Collaborators with the "use" role may only render and interact with the gadget's mainline UI (see UseOverseerInterface in the backend), so we deliberately omit the chat sidebar, the
// Gadget/Code/Connections controls, workspace activity, and every editor-only control. The
// overseer and gadget passed in here are the restricted capabilities returned by openWorkspace() for
// "use" sessions; calling anything outside getMetadata()/subscribeToMetadata()/subscribeToPresence()/
// subscribeToWorkpieces()/getGadget() (and, on the gadget, UI connection and export methods)
// would throw.
//
// When the workspace has more than one gadget, the title pill switches between them (selection is owned by the parent, in the URL's `?w=` search param). Pending gadgets are
// never listed: the restricted overseer's workpiece subscription withholds them.
type Props = {
  overseer: RpcStub<Overseer>
  // Null while the selected gadget is being admitted, or while the workspace has no gadgets.
  gadget: RpcStub<GadgetClient> | null
  // How `gadget` was admitted: live, or only the owner's snapshot of it. Null while unknown.
  gadgetMode: GadgetAccessMode | null
  workspaceId: string
  // An explore passed: reopen the gadget, which now admits the collaborator live.
  onGadgetLive: () => void
  selectedGadgetId: WorkpieceId | null
  // Why the selected gadget couldn't be opened, such as declining to choose connected accounts;
  // the collaborator can retry it or pick another gadget.
  gadgetOpenFailure: string | null
  onRetryGadget: () => void
  // Use-role subscriptions receive gadgets only (worktrees, like pending gadgets, are withheld).
  gadgets: GadgetSummary[]
  onSelectGadget: (id: WorkpieceId) => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  currentUserId: string | null
  // The app's address, for the frame's copy-link button.
  link?: string
  // Leaves full screen for wherever it was opened from, for someone who can build in it.
  onCollapse?: () => void
  // What the collapse button says.
  collapseLabel?: string
  // Whether the title pill switches among `gadgets`; off where it was opened from a list.
  switchable?: boolean
  // The frame's More menu, for someone who builds the gadget.
  menu?: ReactNode
  // Renames the gadget from its title pill, for someone who builds it.
  onRename?: (title: string) => void
}

// The card over a snapshot, put away into the top bar: whose snapshot, and when. Clicking it
// brings the card back; its tooltip holds the full timestamp, and a stale one adds its age.
const ViewChip = ({ chrome, onClick }: { chrome: SharedViewChrome; onClick: () => void }) => (
  <span className="flex min-w-0 shrink items-center gap-1.5">
    <Tooltip
      content={chrome.timestamp}
      render={
        <button
          type="button"
          onClick={onClick}
          // The time is hidden on narrow screens, but always part of the name.
          aria-label={`${chrome.ownerName}'s snapshot · ${chrome.moment}`}
          className="flex h-[34px] min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-tint px-3 text-[13px] font-medium text-kumo-default transition-colors hover:bg-kumo-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          <Eye aria-hidden size={14} className="shrink-0" />
          <span className="truncate">{chrome.ownerName}&rsquo;s snapshot</span>
          <span className="hidden shrink-0 font-normal text-kumo-subtle sm:inline">· {chrome.moment}</span>
        </button>
      }
    />
    {chrome.age && (
      <Badge variant="warning" className="shrink-0 gap-1">
        <Clock aria-hidden size={12} />
        {chrome.age}
      </Badge>
    )}
  </span>
)

export default function GadgetUseView({
  overseer,
  gadget,
  gadgetMode,
  workspaceId,
  onGadgetLive,
  selectedGadgetId,
  gadgets,
  gadgetOpenFailure,
  onRetryGadget,
  onSelectGadget,
  authenticatedApi,
  currentUserId,
  link,
  onCollapse,
  collapseLabel,
  switchable = true,
  menu,
  onRename,
}: Props) {
  const [viewChrome, setViewChrome] = useState<SharedViewChrome | null>(null)
  const [expandView, setExpandView] = useState(0)
  const onViewChrome = useCallback((chrome: SharedViewChrome | null) => setViewChrome(chrome), [])
  const selected = gadgets.find(g => g.id === selectedGadgetId)
  const showsView = gadgetOpenFailure === null && gadget !== null && gadgetMode === 'view'
  return (
    <SharedAppFrame
      title={selected?.title ?? 'Gadget'}
      output={selected?.output}
      choices={switchable ? gadgets.map(g => ({ id: g.id, title: g.title, output: g.output })) : undefined}
      activeId={selectedGadgetId}
      onSelect={onSelectGadget}
      status={showsView && viewChrome?.collapsed
        ? <ViewChip chrome={viewChrome} onClick={() => setExpandView(n => n + 1)} />
        : undefined}
      presence={
        <GadgetPresence overseer={overseer} authenticatedApi={authenticatedApi} currentUserId={currentUserId} />
      }
      menu={menu}
      onRename={onRename}
      link={link}
      onCollapse={onCollapse}
      collapseLabel={collapseLabel}
    >
      {showsView && selectedGadgetId !== null ? (
        <SharedViewPane
          key={selectedGadgetId}
          gadget={gadget}
          gadgetId={selectedGadgetId}
          workspaceId={workspaceId}
          appName={selected?.title ?? 'Gadget'}
          overseer={overseer}
          authenticatedApi={authenticatedApi}
          onLive={onGadgetLive}
          onChrome={onViewChrome}
          expand={expandView}
        />
      ) : gadgetOpenFailure !== null ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          {/* Verification denials list one line per failed connection, so preserve newlines. */}
          <p className="max-w-lg whitespace-pre-line text-sm text-kumo-danger">{gadgetOpenFailure}</p>
          <WorkshopButton tone="primary" onClick={onRetryGadget}>
            Try again
          </WorkshopButton>
        </div>
      ) : gadget && gadgetMode === 'live' ? (
        <GadgetUI
          key={selectedGadgetId}
          gadget={gadget}
          height="100%"
          isVisible={true}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center">
          {selectedGadgetId === null
            ? <p className="text-sm text-kumo-subtle">This workspace has no gadgets yet.</p>
            : <div className="size-6 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />}
        </div>
      )}
    </SharedAppFrame>
  )
}
