import { Link } from '@tanstack/react-router'
import { Hexagon } from '@phosphor-icons/react'
import { FormatGlyph } from './components/format/FormatVisuals'
import { RpcStub } from 'capnweb'
import {
  AuthenticatedApi,
  Overseer,
  GadgetClient,
  GadgetMetadata,
  WorkpieceId,
  WorkpieceSummary,
} from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'
import UserMenu from './components/UserMenu'
import { GadgetPresence } from './components/GadgetPresence'
import TopBarNotice from './TopBarNotice'
import SiteLogo from './components/SiteLogo'
import GadgetExportMenu from './GadgetExportMenu'

// The minimal, "use"-only experience: a shared top bar plus the gadget's deployed UI, and nothing
// else. Collaborators with the "use" role may only render and interact with the gadget's mainline
// UI (see UseOverseerInterface in the backend), so we deliberately omit the chat sidebar, the
// Gadget/Code/Connections controls, workspace activity, and every editor-only control. The
// overseer and gadget passed in here are the restricted capabilities returned by openGadget() for
// "use" sessions; calling anything outside getMetadata()/subscribeToMetadata()/subscribeToPresence()/
// subscribeToWorkpieces()/getGadget() (and, on the gadget, UI connection and export methods)
// would throw.
//
// When the workspace has more than one gadget, a simple picker in the top bar switches between
// them (selection is owned by the parent, in the URL's `?w=` search param). Pending gadgets are
// never listed: the restricted overseer's workpiece subscription withholds them.
type Props = {
  overseer: RpcStub<Overseer>
  // The selected gadget's client, or null if the workspace has no gadgets.
  gadget: RpcStub<GadgetClient> | null
  selectedGadgetId: WorkpieceId | null
  gadgets: WorkpieceSummary[]
  onSelectGadget: (id: WorkpieceId) => void
  metadata: GadgetMetadata
  authenticatedApi: RpcStub<AuthenticatedApi>
  currentUserId: string | null
}

// Matches the top bar height used by the full editor (and the home page header).
const TOPBAR_H = 56

export default function GadgetUseView({
  overseer,
  gadget,
  selectedGadgetId,
  gadgets,
  onSelectGadget,
  metadata,
  authenticatedApi,
  currentUserId,
}: Props) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-kumo-base">
      {/* ═══ TOP BAR ════════════════════════════════════════════════════════════ */}
      <div
        className="relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3"
        style={{ height: TOPBAR_H, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)' }}
      >
        <TopBarNotice />
        {/* Left: logo / title */}
        <div className="flex items-center gap-2 min-w-0">
          <Link to="/" aria-label="Home" className="flex-shrink-0 hover:opacity-80 transition-opacity">
            <SiteLogo size={22}>
              <Hexagon size={22} className="text-kumo-brand" weight="bold" />
            </SiteLogo>
          </Link>

          <span className="text-kumo-inactive flex-shrink-0">/</span>

          <span className="text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default truncate">
            {metadata.title}
          </span>

          {metadata.owner && (
            <span className="text-xs text-kumo-inactive flex-shrink-0">
              by {metadata.owner.name}
            </span>
          )}
        </div>

        {/* Center: gadget picker (only when there's a real choice) */}
        {gadgets.length > 1 && (
          <div className="hidden min-w-0 items-center gap-1 overflow-x-auto md:flex">
            {gadgets.map(g => (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelectGadget(g.id)}
                aria-current={g.id === selectedGadgetId ? 'true' : undefined}
                className={`flex-shrink-0 cursor-pointer rounded-full px-3 py-1 text-[12px] leading-4 tracking-[-0.2px] transition-colors duration-150 ease-out ${
                  g.id === selectedGadgetId
                    ? 'bg-kumo-contrast font-medium text-kumo-inverse'
                    : 'bg-kumo-tint text-kumo-subtle hover:text-kumo-default'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <FormatGlyph output={g.output} size="sm" className="flex-shrink-0" weight="regular" />
                  <span className="block max-w-[160px] truncate">{g.title}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Right: presence and user menu */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <GadgetExportMenu
            gadget={gadget}
            gadgetTitle={gadgets.find(g => g.id === selectedGadgetId)?.title ?? 'Gadget'}
          />
          <span className="hidden md:inline-flex">
            <GadgetPresence
              overseer={overseer}
              authenticatedApi={authenticatedApi}
              currentUserId={currentUserId}
            />
          </span>
          <UserMenu />
        </div>
      </div>

      {gadgets.length > 1 && (
        <div className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-kumo-line px-2 md:hidden">
          {gadgets.map(g => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelectGadget(g.id)}
              aria-current={g.id === selectedGadgetId ? 'true' : undefined}
              className={`h-9 max-w-[180px] shrink-0 truncate rounded-lg px-3 text-[14px] font-medium ${
                g.id === selectedGadgetId
                  ? 'bg-kumo-tint text-kumo-default'
                  : 'text-kumo-subtle'
              }`}
            >
              {g.title}
            </button>
          ))}
        </div>
      )}

      {/* ═══ GADGET UI ══════════════════════════════════════════════════════════ */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {gadget ? (
          <GadgetUI
            key={selectedGadgetId}
            gadget={gadget}
            height="100%"
            isVisible={true}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-sm text-kumo-subtle">This workspace has no gadgets yet.</p>
          </div>
        )}
      </div>
    </div>
  )
}
