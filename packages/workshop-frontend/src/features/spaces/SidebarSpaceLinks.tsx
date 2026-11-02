import { Link, useRouterState } from '@tanstack/react-router'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { spaceLabel } from './spaceKinds'

const ROW_CLASS_NAME =
  'flex h-8 items-center gap-2 rounded-lg pl-1.5 pr-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint'

const initial = (label: string) => [...label.trim()][0]?.toUpperCase() ?? ''

/**
 * The sidebar's links to the user's spaces, one row each: the space's section on the workspaces
 * page. A link asks the page for that section and names no place the user stays at (the page
 * drops the request once it has answered), so no row is marked as the current one. In the
 * collapsed rail a row is its monogram alone, named by its title.
 */
export const SidebarSpaceLinks = ({ spaces, collapsed }: {
  spaces: SpaceInfo[]
  collapsed: boolean
}) => {
  // Followed on the page itself, a link takes the page's place in the history, as the page does
  // when it drops the request. Added to the history instead, each link followed would leave Back
  // one more press that changes nothing.
  const onWorkspacesPage = useRouterState({ select: (s) => s.location.pathname === '/workspaces' })

  return spaces.map((space) => {
    const label = spaceLabel(space)
    return (
      <Link
        key={space.key}
        to="/workspaces"
        search={{ space: space.key }}
        replace={onWorkspacesPage}
        className={ROW_CLASS_NAME}
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
