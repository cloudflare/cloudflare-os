/**
 * Tiny decoupling layer so any part of the rail (or a global ⌘K handler) can ask the
 * CommandPalette — which is mounted once in AppShell — to open, without prop-drilling or a context
 * that would have to wrap the whole tree. The palette listens for this event in AppShell.
 */
export const OPEN_COMMAND_PALETTE_EVENT = 'gadgets:open-command-palette'

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
}
