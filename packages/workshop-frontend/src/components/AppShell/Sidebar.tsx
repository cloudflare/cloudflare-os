import { Link, useRouterState } from '@tanstack/react-router'
import {
  BookOpen,
  Books,
  Hexagon,
  House,
  MagnifyingGlass,
  SidebarSimple,
  SquaresFour,
  TerminalWindow,
  WarningCircle,
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
} from './SidebarWorkspaces'
import SidebarUtilityStrip from './SidebarUtilityStrip'
import SessionsSidebar from '../sessions/SessionsSidebar'
import ProductFeedbackButton from '../../ProductFeedbackButton'
import NativeUpdateCard from './NativeUpdateCard'
import { useSessionsContext } from '../sessions/SessionsContext'

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
 *   • native update / feedback calls-to-action pinned
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
  const { github, activity } = useSessionsContext()
  const showSessions = github.state === 'connected'
  const codeNeedsSetup = github.state === 'missing' || github.state === 'expired'
  const pendingSessionActions = showSessions ? activity.filter((entry) => entry.state === 'pending').length : 0
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isCodeMode = pathname === '/sessions'

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

      <div className={collapsed ? 'flex shrink-0 justify-center px-2 py-2' : 'shrink-0 border-b border-kumo-line px-3 py-3'}>
        {collapsed ? (
          <div className="flex flex-col gap-1">
            <Link to="/" aria-label="Chat" title="Chat" className={`flex h-9 w-9 items-center justify-center rounded-lg ${!isCodeMode ? 'bg-kumo-fill text-kumo-brand' : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'}`}>
              <House size={15} />
            </Link>
            <Link
              to="/sessions"
              aria-label={codeNeedsSetup ? 'Code setup required' : 'Code'}
              title={codeNeedsSetup ? 'Code needs a GitHub connection' : 'Code'}
              className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${isCodeMode ? 'bg-kumo-fill text-kumo-brand' : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'}`}
            >
                <TerminalWindow size={15} />
              {codeNeedsSetup && <WarningCircle size={10} weight="fill" className="absolute right-1 top-1 text-kumo-warning" aria-hidden />}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 rounded-xl border border-kumo-line bg-kumo-base p-1 shadow-sm" role="group" aria-label="Workspace mode">
            <Link to="/" className={`flex h-9 items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-colors ${!isCodeMode ? 'bg-kumo-contrast text-kumo-inverse shadow-sm' : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'}`}>
              <House size={14} /> Chat
            </Link>
            <Link
              to="/sessions"
              title={codeNeedsSetup ? 'Code needs a GitHub connection' : 'Code'}
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors ${isCodeMode ? 'bg-kumo-contrast text-kumo-inverse shadow-sm' : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'}`}
            >
                <TerminalWindow size={14} /> Code
                {codeNeedsSetup && <WarningCircle size={12} weight="fill" className="text-kumo-warning" aria-label="setup required" />}
                {pendingSessionActions > 0 && <span className="rounded-full bg-kumo-brand px-1.5 text-[10px] leading-4 text-white">{pendingSessionActions}</span>}
            </Link>
          </div>
        )}
      </div>

      {isCodeMode && showSessions ? (
        <SessionsSidebar collapsed={collapsed} />
      ) : isCodeMode ? (
        <CodeSetupSidebarState collapsed={collapsed} state={github.state} />
      ) : (
      <SidebarWorkspacesProvider>
        {/* Pinned top stack. shrink-0 keeps it from squishing when the lists below grow. */}
        <div className="flex shrink-0 flex-col gap-3 pt-3">
          {/* Primary nav */}
          <nav className="flex flex-col gap-0.5 px-2">
            <SidebarItem
              to="/"
              label="Ask"
              icon={<House size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/workspaces"
              label="History"
              icon={<SquaresFour size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/outputs"
              label="Library"
              icon={<Books size={14} weight="regular" />}
              activePaths={['/outputs', '/explore', '/blueprints']}
              activePrefixes={['/blueprint']}
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
          </nav>

          {/* Workspace tools: search. Pinned so it's always reachable. */}
          <SidebarWorkspacesTools collapsed={collapsed} />
        </div>

        {/* Scrolling middle: only the Favorites / Recent workspaces / Recent blueprints lists.
            min-h-0 lets flex children compute scroll height correctly. */}
        <div className="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto">
          <SidebarWorkspacesLists collapsed={collapsed} />
        </div>
      </SidebarWorkspacesProvider>
      )}

      <div className={collapsed ? 'flex shrink-0 flex-col items-center gap-2 pb-2' : 'flex shrink-0 flex-col gap-2 px-3 pb-2'}>
        <NativeUpdateCard collapsed={collapsed} />
        <ProductFeedbackButton pathname={pathname} placement="sidebar" collapsed={collapsed} />
      </div>
      <SidebarUtilityStrip collapsed={collapsed} />
    </aside>
  )
}

function CodeSetupSidebarState({ collapsed, state }: { collapsed: boolean; state: string }) {
  if (collapsed) {
    return <div className="min-h-0 flex-1" aria-label="Code setup required" />
  }
  return (
    <div className="min-h-0 flex-1 px-3 py-4">
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-3 text-xs leading-5 text-kumo-subtle">
        <div className="flex items-center gap-2 font-medium text-kumo-default">
          <WarningCircle size={14} weight="fill" className="text-kumo-warning" />
          {state === 'loading' ? 'Checking Code access' : 'Code setup required'}
        </div>
        <p className="mt-1">
          {state === 'loading'
            ? 'Checking your GitHub connection.'
            : state === 'expired'
              ? 'Reconnect GitHub to start code sessions.'
              : 'Connect GitHub to start code sessions.'}
        </p>
      </div>
    </div>
  )
}
