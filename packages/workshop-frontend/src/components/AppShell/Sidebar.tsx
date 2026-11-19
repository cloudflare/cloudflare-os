import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowUpRight,
  Blueprint,
  CaretDown,
  BookOpen,
  Compass,
  Hexagon,
  House,
  MagnifyingGlass,
  SidebarSimple,
  SquaresFour,
  Stack,
} from '@phosphor-icons/react'
import { useSiteName } from '../../ServerConfigContext'
import SiteLogo from '../SiteLogo'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import { openCommandPalette } from './commandPaletteBus'
import SidebarItem from './SidebarItem'
import {
  SidebarWorkspacesProvider,
  SidebarWorkspacesTools,
  SidebarWorkspacesLists,
  SidebarSection,
} from './SidebarWorkspaces'
import SidebarUtilityStrip from './SidebarUtilityStrip'
import { type NavApp } from '../../siteConfig'
import { useSiteConfig } from '../../useSiteConfig'
import { workspaceMonogram } from '../../workspaceMonogram'
import { useState, type ReactNode } from 'react'
import { UnreadSummary } from '../../features/notifications/UnreadSummary'
import { inNativeApp, returnToInstalls } from '../../features/native-app/nativeApp'

const BUILD_OPEN_KEY = 'sidebar:build-open'

/**
 * The persistent left rail. Three pinned regions sandwich a single scrolling region of lists, so
 * the user can always reach Search, primary nav, and the bottom utility strip no matter how many
 * workspaces they have.
 *
 * Layout (top → bottom):
 *   • brand row                            pinned
 *   • primary nav (Home, Workspaces, …)    pinned
 *   • workspace tools (⌘K search)          pinned
 *   • Favorites / Recent workspaces        SCROLLS
 *   • utility strip (plug, avatar)         pinned
 */
export default function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const siteName = useSiteName()
  // Gatekeeper-served management apps the user can reach now (one per gatekeeper that provides a UI
  // and is connected / enabled for everyone). Disabled or not-yet-connected ones aren't returned, so
  // they simply don't appear. The set is fully dynamic — no gatekeeper is hardcoded.
  const gatekeeperApps = useGatekeeperApps()
  const nav = useSiteConfig().nav
  const buildSection = nav?.buildSection === true
  // A site config can move Build down among the workspace groups, and list Outputs inside a group.
  const buildAfterGroup = buildSection && !collapsed
    && nav?.groups.some((g) => g.label === nav.buildAfterGroup) ? nav?.buildAfterGroup : undefined
  const outputsGroup = collapsed ? undefined : nav?.groups.find((g) => g.links?.includes('outputs'))?.label
  // Remembered per browser; starts closed so the rail leads with the work.
  const [buildOpen, setBuildOpen] = useState(() => {
    try { return localStorage.getItem(BUILD_OPEN_KEY) === '1' } catch { return false }
  })
  const toggleBuild = () => setBuildOpen((open) => {
    try { localStorage.setItem(BUILD_OPEN_KEY, open ? '0' : '1') } catch { /* storage unavailable */ }
    return !open
  })

  const buildItems = (
    <>
            <SidebarItem
              to="/workspaces"
              label="Workspaces"
              icon={<SquaresFour size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/blueprints"
              label="Blueprints"
              icon={<Blueprint size={14} weight="regular" />}
              collapsed={collapsed}
            />
            {/* Gatekeeper management apps (e.g. the Context Library), listed dynamically. */}
            {gatekeeperApps.map((app) => {
              // Escape the icon URL for safe interpolation into a CSS url("…") string.
              const maskUrl = app.icon
                ? `url("${app.icon.url.replace(/[\\"]/g, '\\$&')}")`
                : undefined
              return (
              <SidebarItem
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                label={nav?.appTitles?.[app.title] ?? app.title}
                icon={
                  maskUrl ? (
                    // Render the (monochrome) app icon as a CSS mask filled with the row's current
                    // text color, so it tints like the Phosphor icons — subtle by default, accent
                    // when active, darker on hover.
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 bg-current"
                      style={{
                        maskImage: maskUrl,
                        WebkitMaskImage: maskUrl,
                        maskRepeat: 'no-repeat',
                        WebkitMaskRepeat: 'no-repeat',
                        maskPosition: 'center',
                        WebkitMaskPosition: 'center',
                        maskSize: 'contain',
                        WebkitMaskSize: 'contain',
                      }}
                    />
                  ) : (
                    <BookOpen size={14} weight="regular" />
                  )
                }
                collapsed={collapsed}
              />
              )
            })}
            <SidebarItem
              to="/explore"
              label="Explore"
              icon={<Compass size={14} weight="regular" />}
              collapsed={collapsed}
            />
    </>
  )

  const outputsItem = (
    <SidebarItem
      to="/outputs"
      label="Outputs"
      icon={<Stack size={14} weight="regular" />}
      collapsed={collapsed}
    />
  )
  const groupLead: Record<string, ReactNode> = outputsGroup ? { [outputsGroup]: outputsItem } : {}
  // External apps a group lists (Pursue, Parcel, …) follow its workspaces.
  const groupTail: Record<string, ReactNode> = collapsed ? {} : Object.fromEntries(
    (nav?.groups ?? []).filter((g) => g.apps?.length).map((g) => [
      g.label,
      g.apps!.map((app) => <SidebarAppRow key={app.href} app={app} />),
    ]),
  )
  const afterGroup: Record<string, ReactNode> = buildAfterGroup
    ? {
        [buildAfterGroup]: (
          <SidebarSection label="Build" open={buildOpen} onToggle={toggleBuild}>
            <div className="flex flex-col gap-0.5">{buildItems}</div>
          </SidebarSection>
        ),
      }
    : {}

  return (
    <aside
      aria-label="Primary"
      className={[
        // Sidebar is the app chrome: a hair greyer than the (lighter) content canvas so the two
        // surfaces read as distinct without a heavy divider.
        'flex h-full flex-col border-r border-kumo-line bg-kumo-elevated',
        collapsed ? 'w-[56px]' : 'w-[min(320px,100vw)] md:w-[260px]',
        'shrink-0 transition-[width] duration-200 ease-out',
      ].join(' ')}
    >
      {/* Brand row */}
      <div
        className={[
          'flex h-14 shrink-0 items-center border-b border-kumo-line',
          collapsed ? 'justify-center px-1.5' : 'justify-between gap-2 px-3',
        ].join(' ')}
      >
        <Link to="/" aria-label={siteName} className="flex min-w-0 items-center gap-2">
          <SiteLogo size={20} className="shrink-0">
            <Hexagon size={20} weight="bold" className="text-kumo-brand shrink-0" />
          </SiteLogo>
          {!collapsed && (
            <span className="truncate text-[14px] leading-5 font-semibold tracking-[-0.25px] text-kumo-default">
              {siteName}
            </span>
          )}
        </Link>
        {!collapsed && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => openCommandPalette()}
              aria-label="Search"
              title="Search (⌘K)"
              className="press flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
            >
              <MagnifyingGlass size={15} />
            </button>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
            >
              <SidebarSimple size={15} />
            </button>
          </div>
        )}
      </div>

      {/* Expand affordance when collapsed — placed just under the logo for discoverability. */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mx-auto mt-2 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
        >
          <SidebarSimple size={15} className="rotate-180" />
        </button>
      )}

      <SidebarWorkspacesProvider>
        {/* Pinned top stack. shrink-0 keeps it from squishing when the lists below grow. */}
        <div className="flex shrink-0 flex-col gap-3 pt-3">
          {/* Primary nav */}
          <nav className="flex flex-col gap-0.5 px-2">
            <SidebarItem
              to="/"
              label="Home"
              icon={<House size={14} weight="regular" />}
              collapsed={collapsed}
            />
            {!outputsGroup && outputsItem}
            {/* With a site-config Build section, the builder surfaces fold into one collapsible group
                so the rail leads with Home, Outputs and the workspaces people work in. */}
            {buildAfterGroup ? null : buildSection && !collapsed ? (
              <>
                <button
                  type="button"
                  onClick={toggleBuild}
                  aria-expanded={buildOpen}
                  className="mt-2 flex h-6 cursor-pointer items-center gap-1 px-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive transition-colors hover:text-kumo-subtle"
                >
                  <CaretDown
                    size={10}
                    weight="bold"
                    className={['transition-transform', buildOpen ? '' : '-rotate-90'].join(' ')}
                  />
                  <span>Build</span>
                </button>
                {buildOpen && buildItems}
              </>
            ) : buildItems}
            <SidebarItem
              to="/workspaces"
              label="Workspaces"
              icon={<SquaresFour size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/blueprints"
              label="Blueprints"
              icon={<Blueprint size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/outputs"
              label="Outputs"
              icon={<Stack size={14} weight="regular" />}
              collapsed={collapsed}
            />
            {/* Gatekeeper management apps (e.g. the Context Library), listed dynamically. */}
            {gatekeeperApps.map((app) => {
              // Escape the icon URL for safe interpolation into a CSS url("…") string.
              const maskUrl = app.icon
                ? `url("${app.icon.url.replace(/[\\"]/g, '\\$&')}")`
                : undefined
              return (
              <SidebarItem
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                label={app.title}
                icon={
                  maskUrl ? (
                    // Render the (monochrome) app icon as a CSS mask filled with the row's current
                    // text color, so it tints like the Phosphor icons — subtle by default, accent
                    // when active, darker on hover.
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 bg-current"
                      style={{
                        maskImage: maskUrl,
                        WebkitMaskImage: maskUrl,
                        maskRepeat: 'no-repeat',
                        WebkitMaskRepeat: 'no-repeat',
                        maskPosition: 'center',
                        WebkitMaskPosition: 'center',
                        maskSize: 'contain',
                        WebkitMaskSize: 'contain',
                      }}
                    />
                  ) : (
                    <BookOpen size={14} weight="regular" />
                  )
                }
                collapsed={collapsed}
              />
              )
            })}
            <SidebarItem
              to="/explore"
              label="Explore"
              icon={<Compass size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <UnreadSummary collapsed={collapsed} />          </nav>

          {/* Workspace tools: search. Pinned so it's always reachable. */}
          <SidebarWorkspacesTools collapsed={collapsed} />
        </div>

        {/* Scrolling middle: only the Favorites / Recent workspaces / Recent blueprints lists.
            min-h-0 lets flex children compute scroll height correctly. */}
        <div className="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto">
          <SidebarWorkspacesLists
            collapsed={collapsed}
            groupLead={groupLead}
            groupTail={groupTail}
            afterGroup={afterGroup}
          />
        </div>
      </SidebarWorkspacesProvider>

      <SidebarUtilityStrip collapsed={collapsed} />
      {inNativeApp() && (
        <button
          type="button"
          onClick={returnToInstalls}
          aria-label="Back to installs"
          className={[
            'flex min-h-11 shrink-0 items-center border-t border-kumo-line py-2 text-sm text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
            collapsed ? 'justify-center px-2' : 'gap-2 px-4',
          ].join(' ')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {!collapsed && 'Back to installs'}
        </button>
      )}
    </aside>
  )
}

/** An external app in a nav group: the workspace row's look, opening the app in a new tab. */
function SidebarAppRow({ app }: { app: NavApp }) {
  return (
    <a
      href={app.href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-8 items-center gap-2 rounded-lg pl-1.5 pr-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint"
    >
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-kumo-fill text-[10px] font-medium text-kumo-subtle"
        aria-hidden="true"
      >
        {workspaceMonogram(app.label)}
      </div>
      <span className="min-w-0 flex-1 truncate">{app.label}</span>
      <ArrowUpRight size={12} className="shrink-0 text-kumo-inactive opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  )
}
