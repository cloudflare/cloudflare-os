import { createContext, useContext, useLayoutEffect } from 'react'

// Lets a page draw its own content cards instead of sitting in the shell's single card. The chat
// does this: with an app or file open the design shows the chat and the pane as two cards side by
// side on the canvas (Figma "MacBook Pro 14\" - 22").
const BareShellContext = createContext<((bare: boolean) => void) | null>(null)

export const BareShellProvider = BareShellContext.Provider

/**
 * Draws the calling page straight onto the canvas, without the shell's card, while `active`. A
 * page passes false for states it shows in the ordinary card, such as loading and errors.
 */
export function useBareShell(active = true) {
  const setBare = useContext(BareShellContext)
  useLayoutEffect(() => {
    if (!setBare || !active) return
    setBare(true)
    return () => setBare(false)
  }, [setBare, active])
}

/** The class list of a design content card: white, 24px corners and a 4% black hairline. */
export const CONTENT_CARD_CLASS = 'bg-kumo-base md:rounded-3xl md:ring-1 md:ring-kumo-tint'
