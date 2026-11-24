import { useRef } from 'react'
import type { GadgetUIFocus } from '../../GadgetUI'
import { previewKey, type ConnectionPreview } from './connectionPreview'

/**
 * Keeps the spot each preview's frame last reported, for as long as the workspace stays open, and
 * returns what gives a preview its `GadgetUI` focus. A frame is sent to that spot as it starts, so
 * a preview closed and opened again, or one whose frame was replaced, is drawn where it was left.
 * The preview of an item starts at the item: its ID is the anchor the connection's code draws it
 * by. Connections are numbered within a workspace, so another workspace starts afresh.
 */
export const usePreviewFocus = (workspaceId: string | undefined) => {
  const kept = useRef({ workspaceId, anchors: new Map<string, string>() })
  if (kept.current.workspaceId !== workspaceId) kept.current = { workspaceId, anchors: new Map() }
  const { anchors } = kept.current

  return (preview: Pick<ConnectionPreview, 'gatekeeperId' | 'item'>): GadgetUIFocus => {
    const key = previewKey(preview)
    const latestAnchor = () => anchors.get(key) ?? preview.item
    return {
      anchor: latestAnchor(),
      latestAnchor,
      // Only the frame's own reports move the spot, so a frame is sent to it only as it starts.
      navigation: 0,
      onFocusChange: focus => {
        if (focus) anchors.set(key, focus.anchor)
        else anchors.delete(key)
      },
    }
  }
}
