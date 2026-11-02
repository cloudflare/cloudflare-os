import { Link } from '@tanstack/react-router'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { spaceLabel } from './spaceKinds'

const ROW_CLASS_NAME =
  'flex h-8 items-center gap-2 rounded-lg pl-1.5 pr-1 text-[13px] leading-[18px] tracking-[-0.25px] transition-colors'
// The sidebar's rows, as `SidebarItem` styles the one whose page is open and the others.
const CURRENT_ROW_CLASS_NAME = 'bg-kumo-fill font-medium text-kumo-strong'
const OTHER_ROW_CLASS_NAME = 'text-kumo-default hover:bg-kumo-tint'

const initial = (label: string) => [...label.trim()][0]?.toUpperCase() ?? ''

/**
 * The sidebar's links to the user's spaces, one row each, to the space's own page. The row of
 * the space whose page is open is marked as the current one; a workspace's address under that
 * space is another page, and marks none. In the collapsed rail a row is its monogram alone,
 * named by its title.
 */
export const SidebarSpaceLinks = ({ spaces, collapsed }: {
  spaces: SpaceInfo[]
  collapsed: boolean
}) => {
  return spaces.map((space) => {
    const label = spaceLabel(space)
    return (
      <Link
        key={space.key}
        to="/spaces/$spaceKey"
        params={{ spaceKey: space.key }}
        activeOptions={{ exact: true }}
        className={ROW_CLASS_NAME}
        activeProps={{ className: CURRENT_ROW_CLASS_NAME }}
        inactiveProps={{ className: OTHER_ROW_CLASS_NAME }}
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
      >
        {/* Round, where a workspace's monogram is square. */}
        <div
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-[10px] font-medium text-kumo-subtle"
        >
          {initial(label)}
        </div>
        {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      </Link>
    )
  })
}
