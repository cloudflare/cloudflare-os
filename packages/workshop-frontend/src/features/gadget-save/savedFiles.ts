import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import { getResourceTypeId } from '@gadgets/workshop-shared/gatekeeper'
import type { SaveTarget } from './saveTargets'

/** The file a gadget's last save made, which a later save can replace. */
export type SavedFile = { accountId: number; url: string; name: string }

/** The gadget being saved. A WorkpieceId is only a per-workspace counter. */
export type SaveScope = { workspaceId: string; workpieceId: WorkpieceId }

export const savedFileKey = (
  userId: string, { workspaceId, workpieceId }: SaveScope, { vendor, resource }: SaveTarget,
) => `gadget-save:${JSON.stringify(
  [userId, workspaceId, workpieceId, vendor.id, getResourceTypeId(resource)])}`

/**
 * Storage may be unavailable or hold anything, and saving works without it: there is then
 * nothing to update, only new copies to save.
 */
export const readSavedFile = (key: string | null): SavedFile | undefined => {
  try {
    const saved: Partial<SavedFile> | null = JSON.parse((key && localStorage.getItem(key)) ?? 'null')
    return typeof saved?.accountId === 'number' && typeof saved.url === 'string' &&
      typeof saved.name === 'string' ? saved as SavedFile : undefined
  } catch {
    return undefined
  }
}

export const writeSavedFile = (key: string | null, saved: SavedFile) => {
  try {
    if (key) localStorage.setItem(key, JSON.stringify(saved))
  } catch {
    // See readSavedFile.
  }
}
