import { Link, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * A single nav row in the sidebar. Renders as a TanStack <Link>, whose active state (path only,
 * ignoring search) styles both the row and its icon. When `collapsed` is true the label is hidden
 * but kept in the DOM for screen readers / hover-tooltips.
 */
export type SidebarItemProps = {
  icon: ReactNode
  label: string
  to: LinkProps['to']
  params?: LinkProps['params']
  trailing?: ReactNode
  collapsed?: boolean
  /** When true, match this item active when the current path is `to` or below it. */
  matchPrefix?: boolean
}

export default function SidebarItem({
  icon,
  label,
  to,
  params,
  trailing,
  collapsed = false,
  matchPrefix = false,
}: SidebarItemProps) {
  // Kept loose: the generated route-tree union is stricter than is convenient for a generic row.
  const linkProps = { to, params } as unknown as LinkProps

  return (
    <Link
      {...linkProps}
      activeOptions={{ exact: !matchPrefix, includeSearch: false }}
      title={collapsed ? label : undefined}
      className="group relative flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-[14px] leading-5 transition-colors md:h-8 md:text-[13px] md:leading-[18px]"
      activeProps={{ className: 'bg-kumo-fill font-medium text-kumo-strong' }}
      inactiveProps={{ className: 'font-normal text-kumo-default hover:bg-kumo-tint' }}
    >
      {({ isActive }) => (
        <>
          <span
            className={[
              'flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
              isActive ? 'text-kumo-brand' : 'text-kumo-subtle group-hover:text-kumo-default',
            ].join(' ')}
          >
            {icon}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {trailing && <span className="shrink-0 text-kumo-inactive">{trailing}</span>}
            </>
          )}
        </>
      )}
    </Link>
  )
}
