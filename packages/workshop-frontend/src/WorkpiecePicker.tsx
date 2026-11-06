import { useState, type ReactNode } from 'react'
import {
  CaretLeft, CaretRight, Check, GitBranch, Lightning, PencilSimple, Pulse, Warning, X,
} from '@phosphor-icons/react'
import { FormatGlyph } from './components/format/FormatVisuals'
import { Tooltip } from '@cloudflare/kumo'
import type { ChatBindingInfo, GadgetSummary, WorkpieceId, WorktreeSummary } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { CountBadge } from './components/CountBadge'
import { WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { ChatBindingRow } from './features/chat-bindings/ChatBindingRow'
import type { ChatBindings } from './features/chat-bindings/useChatBindings'
import { useGatekeeperVendors } from './hooks/useGatekeeperVendors'
import { isImeComposing } from './keyboardEvent'

export const WORKPIECE_RAIL_COLLAPSED_WIDTH = 48
export const WORKPIECE_RAIL_EXPANDED_WIDTH = 220

interface WorkpiecePickerProps {
  // Draft apps remain listed globally; selecting one returns to its creating conversation.
  gadgets: GadgetSummary[]
  // Worktrees are listed the same way, in their own group after the apps: each belongs to one
  // conversation, and selecting it returns there.
  worktrees: WorktreeSummary[]
  selectedId: WorkpieceId | null
  // The selected chat's bindings, or null when no chat is selected. Listed after the workspace's
  // gadgets and worktrees, in groups named for the chat: what its agent created, then the rest.
  chatBindings: ChatBindings | null
  // The gadget the agent is currently streaming edits into, if any. Shown as an activity dot when
  // it isn't the selected one (e.g. because the user pinned their selection mid-turn).
  agentEditingId?: WorkpieceId | null
  // Gadgets with at least one enabled hook, i.e. whose code can be woken by an external event.
  hookedGadgetIds: ReadonlySet<WorkpieceId>
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onSelect: (id: WorkpieceId) => void
  onRename: (id: WorkpieceId, title: string) => void
  pendingActivityCount: number
  onOpenActivity: () => void
}

export default function WorkpiecePicker({
  gadgets,
  worktrees,
  selectedId,
  chatBindings,
  agentEditingId,
  hookedGadgetIds,
  expanded,
  onExpandedChange,
  onSelect,
  onRename,
  pendingActivityCount,
  onOpenActivity,
}: WorkpiecePickerProps) {
  const [editing, setEditing] = useState<{ id: WorkpieceId; value: string } | null>(null)
  const vendors = useGatekeeperVendors(useAuthenticatedApi().authenticatedApi)
  const vendorOf = (binding: ChatBindingInfo) =>
    binding.vendorId === undefined ? undefined : vendors.get(binding.vendorId)
  // Two binding names can alias one connection.
  const listed = chatBindings?.status === 'ready'
    ? chatBindings.bindings.filter((binding, i, all) => all.findIndex(b => b.target === binding.target) === i)
    : []
  const createdResources = listed.filter(binding => binding.created)
  const hasWorkpieces = gadgets.length > 0 || worktrees.length > 0
  const hasOutputs = hasWorkpieces || createdResources.length > 0
  // Always-available connections (an auto-provisioning vendor's) come last: they say least about
  // this chat.
  const connections = listed.filter(binding => !binding.created)
    .toSorted((a, b) => Number(a.alwaysAvailable) - Number(b.alwaysAvailable))

  const commitRename = () => {
    if (!editing) return
    const title = editing.value.trim()
    if (title) onRename(editing.id, title)
    setEditing(null)
  }

  const toggleExpanded = () => {
    if (expanded) setEditing(null)
    onExpandedChange(!expanded)
  }

  return (
    <div
      className="flex flex-shrink-0 flex-col overflow-hidden border-l border-kumo-line bg-kumo-elevated transition-[width] duration-200 ease-out"
      style={{ width: expanded ? WORKPIECE_RAIL_EXPANDED_WIDTH : WORKPIECE_RAIL_COLLAPSED_WIDTH }}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        title={expanded ? 'Collapse outputs' : 'Expand outputs'}
        aria-label={expanded ? 'Collapse outputs' : 'Expand outputs'}
        aria-expanded={expanded}
        className={`flex h-12 flex-shrink-0 cursor-pointer items-center text-kumo-inactive transition-colors hover:text-kumo-subtle ${
          expanded ? 'justify-between px-3' : 'justify-center'
        }`}
      >
        {expanded && (
          <span className="text-[11px] font-medium uppercase tracking-[0.06em]">Outputs</span>
        )}
        {expanded ? <CaretRight size={14} /> : <CaretLeft size={14} />}
      </button>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
        {gadgets.map(gadget => {
          const isSelected = gadget.id === selectedId
          const isPending = gadget.chatId !== undefined
          const isAgentEditing = agentEditingId === gadget.id && !isSelected
          const hasHook = hookedGadgetIds.has(gadget.id)

          if (expanded && editing?.id === gadget.id) {
            return (
              <div key={gadget.id} className="flex items-center gap-1 py-0.5">
                <WorkshopInput
                  type="text"
                  value={editing.value}
                  onChange={e => setEditing({ id: gadget.id, value: e.target.value })}
                  onKeyDown={e => {
                    if (isImeComposing(e)) return
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  autoFocus
                  className="!h-7 min-w-0 flex-1 bg-kumo-tint text-[13px]"
                />
                <WorkshopIconButton
                  onClick={commitRename}
                  disabled={!editing.value.trim()}
                  className="!h-6 !w-6"
                  aria-label="Save gadget name"
                >
                  <Check size={13} />
                </WorkshopIconButton>
                <WorkshopIconButton
                  onClick={() => setEditing(null)}
                  className="!h-6 !w-6"
                  aria-label="Cancel rename"
                >
                  <X size={13} />
                </WorkshopIconButton>
              </div>
            )
          }

          return (
            <div
              key={gadget.id}
              className={`group/workpiece flex items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                expanded ? 'h-8 gap-1 pl-2 pr-1' : 'h-9 w-9 justify-center self-center'
              } ${
                isSelected
                  ? 'bg-kumo-fill font-medium text-kumo-strong'
                  : 'text-kumo-default hover:bg-kumo-tint'
              }`}
            >
              <Tooltip content={`${gadget.title}${!expanded && isPending ? ' (Draft)' : ''}${hasHook ? ' · Hooks enabled' : ''}`} asChild>
                <button
                  type="button"
                  onClick={() => onSelect(gadget.id)}
                  className={`relative flex min-w-0 cursor-pointer items-center text-left ${
                    expanded ? 'flex-1 gap-2' : 'h-full w-full justify-center'
                  }`}
                  aria-current={isSelected ? 'true' : undefined}
                >
                  {/* Drawn as whatever the workpiece is -- a page for a Document, a grid for a
                      Spreadsheet -- falling back to the generic app glyph. */}
                  <FormatGlyph
                    output={gadget.output}
                    size={expanded ? 'md' : 'lg'}
                    className={`flex-shrink-0 ${isSelected ? 'text-kumo-strong' : 'text-kumo-inactive'}`}
                    weight={isSelected ? 'fill' : 'regular'}
                  />
                  {expanded && (
                    <span className="min-w-0 flex-1 truncate">{gadget.title}</span>
                  )}
                  {isAgentEditing && (
                    <span className={`${expanded ? '' : 'absolute right-1 top-1'} h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kumo-brand`} />
                  )}
                  {isPending && (
                    expanded ? (
                      <span className="flex-shrink-0 rounded-full bg-kumo-base px-1.5 py-0.5 text-[10px] leading-none font-medium text-kumo-subtle">
                        Draft
                      </span>
                    ) : (
                      <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-kumo-base bg-kumo-brand" />
                    )
                  )}
                  {hasHook && (
                    <span
                      role="img"
                      aria-label="Hooks enabled"
                      className={expanded
                        ? 'flex-shrink-0 text-kumo-inactive'
                        : 'absolute bottom-0.5 left-0.5 rounded-full border border-kumo-base bg-kumo-base text-kumo-inactive'}
                    >
                      <Lightning size={expanded ? 14 : 10} weight="fill" />
                    </span>
                  )}
                </button>
              </Tooltip>
              {expanded && (
                <WorkshopIconButton
                  onClick={() => setEditing({ id: gadget.id, value: gadget.title })}
                  className="!h-6 !w-6 flex-shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover/workpiece:opacity-100 focus-visible:opacity-100"
                  title="Rename gadget"
                  aria-label={`Rename ${gadget.title}`}
                >
                  <PencilSimple size={13} />
                </WorkshopIconButton>
              )}
            </div>
          )
        })}

        {expanded && !hasOutputs && chatBindings?.status === 'ready' && (
          <span className="px-2 text-[12px] text-kumo-inactive">Nothing yet</span>
        )}

        {worktrees.length > 0 && (
          <>
            {expanded ? (
              <span className="mt-3 mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
                Worktrees
              </span>
            ) : (
              <span aria-hidden="true" className="mx-2 mt-2 mb-1.5 border-t border-kumo-line" />
            )}
            {worktrees.map(worktree => {
              const isSelected = worktree.id === selectedId
              const isAgentEditing = agentEditingId === worktree.id && !isSelected
              return (
                <div
                  key={worktree.id}
                  className={`flex items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                    expanded ? 'h-8 gap-1 pl-2 pr-1' : 'h-9 w-9 justify-center self-center'
                  } ${
                    isSelected
                      ? 'bg-kumo-fill font-medium text-kumo-strong'
                      : 'text-kumo-default hover:bg-kumo-tint'
                  }`}
                >
                  <Tooltip content={worktree.title} asChild>
                    <button
                      type="button"
                      onClick={() => onSelect(worktree.id)}
                      className={`relative flex min-w-0 cursor-pointer items-center text-left ${
                        expanded ? 'flex-1 gap-2' : 'h-full w-full justify-center'
                      }`}
                      aria-current={isSelected ? 'true' : undefined}
                    >
                      <GitBranch
                        size={expanded ? 15 : 17}
                        className={`flex-shrink-0 ${isSelected ? 'text-kumo-strong' : 'text-kumo-inactive'}`}
                        weight={isSelected ? 'fill' : 'regular'}
                      />
                      {expanded && (
                        <span className="min-w-0 flex-1 truncate">{worktree.title}</span>
                      )}
                      {isAgentEditing && (
                        <span className={`${expanded ? '' : 'absolute right-1 top-1'} h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kumo-brand`} />
                      )}
                    </button>
                  </Tooltip>
                </div>
              )
            })}
          </>
        )}

        {createdResources.length > 0 && (
          <RailGroup label="Created in this chat" expanded={expanded} divider={hasWorkpieces}>
            {createdResources.map(binding => (
              <ChatBindingRow key={binding.target} binding={binding} vendor={vendorOf(binding)} expanded={expanded} />
            ))}
          </RailGroup>
        )}

        {chatBindings && (
          <RailGroup label="Connected to this chat" expanded={expanded} divider={hasOutputs}>
            {chatBindings.status === 'loading' && expanded && (
              <span className="px-2 text-[12px] text-kumo-inactive">Loading…</span>
            )}
            {chatBindings.status === 'failed' && (expanded ? (
              <span className="px-2 text-[12px] text-kumo-subtle">Couldn’t load connections</span>
            ) : (
              <Tooltip content="Couldn’t load connections" asChild>
                <span role="img" aria-label="Couldn’t load connections" className="flex h-9 w-9 items-center justify-center self-center text-kumo-inactive">
                  <Warning size={17} />
                </span>
              </Tooltip>
            ))}
            {connections.map(binding => (
              <ChatBindingRow key={binding.target} binding={binding} vendor={vendorOf(binding)} expanded={expanded} />
            ))}
            {chatBindings.status === 'ready' && connections.length === 0 && expanded && (
              <span className="px-2 text-[12px] text-kumo-inactive">None yet</span>
            )}
          </RailGroup>
        )}

        <Tooltip content="View activity" asChild>
          <button
            type="button"
            onClick={onOpenActivity}
            className={`relative mt-3 flex cursor-pointer items-center rounded-lg text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default ${
              expanded ? 'h-8 gap-2 px-2 text-left' : 'h-9 w-9 justify-center self-center'
            }`}
          >
            <Pulse size={expanded ? 15 : 17} className="flex-shrink-0 text-kumo-inactive" />
            {expanded && <span className="min-w-0 flex-1 truncate">View activity</span>}
            {expanded ? (
              <CountBadge count={pendingActivityCount} />
            ) : pendingActivityCount > 0 && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-kumo-brand" />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

// A group of the rail's rows, named by a heading when expanded and set apart by a divider when
// collapsed below other rows.
function RailGroup({ label, expanded, divider, children }: {
  label: string
  expanded: boolean
  divider: boolean
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      {expanded ? (
        <span aria-hidden="true" className="mt-3 mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
          {label}
        </span>
      ) : divider && (
        <span aria-hidden="true" className="mx-2 mt-2 mb-1.5 border-t border-kumo-line" />
      )}
      {children}
    </div>
  )
}
