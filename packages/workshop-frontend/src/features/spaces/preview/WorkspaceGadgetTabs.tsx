import { Tabs } from '@cloudflare/kumo'
import type { WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { FormatGlyph } from '../../../components/format/FormatVisuals'

/**
 * The tab strip of a workspace preview, one tab per permanent gadget of the workspace with its
 * default gadget first (see `useWorkspaceGadgets`). A workspace holding a single gadget gets no
 * strip at all: a single tab would say nothing.
 */
export const WorkspaceGadgetTabs = ({ gadgets, selectedId, onSelect }: {
  /** The workspace's permanent gadgets, its default gadget first. */
  gadgets: WorkpieceSummary[]
  /** The gadget on screen. */
  selectedId: WorkpieceId | null
  onSelect: (id: WorkpieceId) => void
}) => {
  if (gadgets.length < 2) return null
  return (
    <nav aria-label="Workspace gadgets" className="shrink-0 border-b border-kumo-line px-4">
      <Tabs
        variant="underline"
        value={selectedId === null ? undefined : String(selectedId)}
        onValueChange={(value) => onSelect(Number(value))}
        tabs={gadgets.map(gadget => ({
          value: String(gadget.id),
          label: (
            <span className="inline-flex max-w-[200px] items-center gap-1.5">
              <FormatGlyph output={gadget.type === 'gadget' ? gadget.output : undefined} size="sm" className="shrink-0" />
              <span className="truncate" title={gadget.title}>{gadget.title}</span>
            </span>
          ),
        }))}
      />
    </nav>
  )
}
