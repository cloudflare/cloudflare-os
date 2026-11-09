/**
 * Tiny decoupling layer so any part of the rail (or a global ⌘K handler) can ask the
 * CommandPalette — which is mounted once in AppShell — to open, without prop-drilling or a context
 * that would have to wrap the whole tree. The palette listens for this event in AppShell.
 */
export const OPEN_COMMAND_PALETTE_EVENT = 'gadgets:open-command-palette'

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
}

/** Event the app shell listens for to open the sidebar as a full-screen drawer on phones. */
export const OPEN_SIDEBAR_DRAWER_EVENT = 'gadgets:open-sidebar-drawer'

/**
 * Open the sidebar drawer. On phones the sidebar is hidden and each page's header shows a button
 * that calls this, the way the design's phone frames go back to the chat list.
 */
export function openSidebarDrawer(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SIDEBAR_DRAWER_EVENT))
}
