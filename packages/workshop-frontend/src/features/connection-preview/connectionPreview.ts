import type { ActionLogEntry, WorkpieceId } from '@gadgets/workshop-shared/api'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

/** A connection whose content can be drawn beside the chat. */
export type ConnectionPreview = {
  gatekeeperId: WorkpieceId
  title: string
  /** The real file, for the pane's link out. */
  url?: string
}

/**
 * The preview an action's connection offers, or null when it has none.
 *
 * SPIKE: only a native Google Doc, recognised by its URL. This check stands in for the gatekeeper
 * declaring that it has a preview, and is the one vendor-specific line in the Workshop.
 */
export const connectionPreviewOf = (entry: ActionLogEntry): ConnectionPreview | null => {
  const url = safeExternalUrl(entry.resourceUrl)
  if (entry.gatekeeperId === undefined || !url?.startsWith('https://docs.google.com/document/d/')) {
    return null
  }
  return { gatekeeperId: entry.gatekeeperId, title: entry.resourceTitle, url }
}
