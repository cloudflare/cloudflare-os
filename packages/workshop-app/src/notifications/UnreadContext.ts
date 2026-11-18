import { createContext, useContext } from 'react'
import type { UnreadTotals } from './UnreadSummary'

export type UnreadContextValue = {
  /** What the viewer has not read, by workspace, live. */
  totals: UnreadTotals
  /**
   * Marks every chat in a workspace read, through what the account knows of it now
   * (`markWorkspaceRead`). The marks clear as the account says they have. Rejects with why.
   */
  markWorkspaceRead: (workspaceId: string) => Promise<void>
  /** Marks every chat in every workspace read (`markAllRead`). Rejects with why. */
  markAllRead: () => Promise<void>
}

export const UnreadContext = createContext<UnreadContextValue | null>(null)

/**
 * What the viewer has not read, and the ways to mark it read, beneath `UnreadProvider`. Null
 * elsewhere, such as in a scripted chat, which marks nothing.
 */
export const useUnread = (): UnreadContextValue | null => useContext(UnreadContext)
