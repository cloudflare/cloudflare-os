import type {
  GadgetAccessMode, ObserverAccountChoice, ObserverBindingNeed, WorkpieceId,
} from '@gadgets/workshop-shared/api'

/**
 * What this browser remembers about one viewer's visits to one shared gadget: how they last saw
 * it, and the accounts a failed explore chose. The server publishes an account choice only once
 * it verifies (a refused choice would otherwise be checked against the owner's own reads), so a
 * refused one is remembered here, per device, to re-check silently on the next open rather than
 * ask again.
 */
export type ExploreMemory = {
  mode: GadgetAccessMode
  /** Set after an explore was refused: the accounts that were tried. */
  refusedChoices?: ObserverAccountChoice[]
}

const key = (workspaceId: string, gadgetId: WorkpieceId) =>
  `shared-view:${workspaceId}:${gadgetId}`

export const readExploreMemory = (
  workspaceId: string, gadgetId: WorkpieceId,
): ExploreMemory | null => {
  try {
    const raw = localStorage.getItem(key(workspaceId, gadgetId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return null
    const { mode, refusedChoices } = parsed as Partial<ExploreMemory>
    if (mode !== 'live' && mode !== 'view') return null
    return Array.isArray(refusedChoices) ? { mode, refusedChoices } : { mode }
  } catch {
    return null
  }
}

export const writeExploreMemory = (
  workspaceId: string, gadgetId: WorkpieceId, memory: ExploreMemory,
): void => {
  try {
    localStorage.setItem(key(workspaceId, gadgetId), JSON.stringify(memory))
  } catch {
    // Storage blocked or full: the viewer is asked again next time, which is the safe default.
  }
}

/**
 * Answers a configuration prompt from remembered choices alone, never showing anything: it
 * declines when the server asks about a source it has no choice for, or reports a failure.
 */
export const answerFromMemory = (
  needs: ObserverBindingNeed[], remembered: ObserverAccountChoice[],
): ObserverAccountChoice[] => {
  if (needs.some(need => need.failure)) throw new Error('Not now.')
  return needs.map(need => {
    const choice = remembered.find(c => c.gatekeeperId === need.gatekeeperId)
    if (!choice) throw new Error('Not now.')
    return choice
  })
}

const dismissedKey = (workspaceId: string, gadgetId: WorkpieceId) =>
  `shared-view-card:${workspaceId}:${gadgetId}`

/** Whether this viewer put the card over this shared view away, on this device. */
export const readCardDismissed = (workspaceId: string, gadgetId: WorkpieceId): boolean => {
  try {
    return localStorage.getItem(dismissedKey(workspaceId, gadgetId)) === '1'
  } catch {
    return false
  }
}

/** Remembers the card put away, or brought back from the header chip. */
export const writeCardDismissed = (workspaceId: string, gadgetId: WorkpieceId, dismissed: boolean): void => {
  try {
    if (dismissed) localStorage.setItem(dismissedKey(workspaceId, gadgetId), '1')
    else localStorage.removeItem(dismissedKey(workspaceId, gadgetId))
  } catch {
    // Storage blocked: the card comes back next time, which is only a little louder.
  }
}
