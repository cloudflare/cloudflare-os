import type { WorkpieceId } from '@gadgets/workshop-shared/api'

/** A connection whose content can be drawn beside the chat. */
export type ConnectionPreview = {
  gatekeeperId: WorkpieceId
  title: string
  /** The real file, for the pane's link out. */
  url?: string
}
