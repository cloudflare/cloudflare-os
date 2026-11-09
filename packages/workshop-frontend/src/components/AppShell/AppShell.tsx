import { useEffect, useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import TopBarNotice from '../../TopBarNotice'
import ReconnectingChip from '../ReconnectingChip'
import { useConnectionLost } from '../../RpcContext'
import Sidebar from './Sidebar'
import CommandPalette from './CommandPalette'
import { OPEN_COMMAND_PALETTE_EVENT, OPEN_SIDEBAR_DRAWER_EVENT } from './commandPaletteBus'
import { WorkspacesProvider } from '../../features/workspaces/WorkspacesContext'
import { BareShellProvider, CONTENT_CARD_CLASS } from './shellChrome'

/**
 * The authenticated application chrome (Figma frame "MacBook Pro 14\""): the sidebar and a white
 * content card side by side on the elevated canvas, 8px in from the edges with a 12px gutter. Every
 * page renders inside the card and draws its own header row, except a page that calls
 * `useBareShell` to lay out cards of its own, as the chat does to show an app beside it.
 *
 * Below `md` the sidebar is a full-screen drawer opened from each page's header (see
 * `openSidebarDrawer`), as in the design's phone frames, where the chat list is its own screen.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [bare, setBare] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const connectionLost = useConnectionLost()

  useEffect(() => {
    const open = () => setMobileOpen(true)
    window.addEventListener(OPEN_SIDEBAR_DRAWER_EVENT, open)
    return () => window.removeEventListener(OPEN_SIDEBAR_DRAWER_EVENT, open)
  }, [])

  // Escape closes the drawer, and focus stays inside it while it's open.
  useEffect(() => {
    if (!mobileOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    drawerRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false)
        return
      }
      if (e.key !== 'Tab' || !drawerRef.current) return
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawerRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      window.setTimeout(() => previousFocus?.focus(), 0)
    }
  }, [mobileOpen])

  // Close the drawer on navigation: picking a chat or a menu item navigates while the drawer would
  // otherwise keep covering the page. Watching the location catches every source of navigation.
  const location = useRouterState({ select: (s) => s.location.href })
  useEffect(() => {
    setMobileOpen(false)
  }, [location])

  // Global ⌘K / Ctrl+K opens the command palette; the sidebar's search button opens it via a
  // custom event so it doesn't have to prop-drill into the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    const onOpen = () => setPaletteOpen(true)
    document.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [])

  return (
    <WorkspacesProvider>
      <div className="flex h-full min-h-0 w-full gap-3 overflow-hidden bg-kumo-elevated p-0 md:p-2">
        <div className="hidden h-full md:flex">
          <Sidebar />
        </div>
        {mobileOpen && (
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Chats"
            tabIndex={-1}
            className="fixed inset-0 z-50 flex bg-kumo-elevated p-2 outline-none md:hidden"
          >
            <Sidebar />
          </div>
        )}
        <div
          className={`relative flex min-w-0 flex-1 flex-col overflow-hidden ${bare ? 'bg-kumo-base md:bg-transparent' : CONTENT_CARD_CLASS}`}
          inert={mobileOpen ? true : undefined}
          aria-hidden={mobileOpen ? true : undefined}
        >
          {/* The admin's notice, or the reconnecting chip, float over the middle of whichever page
              header is showing: every page header leaves that span empty. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[60px] items-center justify-center">
            {connectionLost ? <span className="pointer-events-auto"><ReconnectingChip /></span> : <TopBarNotice />}
          </div>
          <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
            <BareShellProvider value={setBare}>{children}</BareShellProvider>
          </main>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </WorkspacesProvider>
  )
}
