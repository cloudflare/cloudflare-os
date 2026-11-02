import { Tabs, type TabsItem } from '@cloudflare/kumo'
import { ListBullets, TreeStructure } from '@phosphor-icons/react'
import type { SpaceViewMode } from './useSpaceViewMode'

const tabLabel = (Icon: typeof ListBullets, text: string) => (
  <span className="flex items-center gap-1.5">
    <Icon aria-hidden="true" size={14} />
    {text}
  </span>
)

const TABS = [
  { value: 'list', label: tabLabel(ListBullets, 'List') },
  { value: 'tree', label: tabLabel(TreeStructure, 'Tree') },
] satisfies (TabsItem & { value: SpaceViewMode })[]

/** Switches the workspaces of a space between the list and the tree with a preview. */
export const SpaceViewToggle = ({ mode, onModeChange }: {
  mode: SpaceViewMode
  onModeChange: (mode: SpaceViewMode) => void
}) => (
  // Kumo's tab list takes no accessible name of its own, so the group around it carries one.
  <div role="group" aria-label="View" className="shrink-0">
    <Tabs
      variant="segmented"
      size="sm"
      tabs={TABS}
      value={mode}
      onValueChange={(value) => onModeChange(value === 'tree' ? 'tree' : 'list')}
    />
  </div>
)
