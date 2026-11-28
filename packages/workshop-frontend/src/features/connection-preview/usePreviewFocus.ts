import { useRef, useState } from 'react'
import type { GadgetUIFocus } from '../../GadgetUI'
import { previewKey, type ConnectionPreview } from './connectionPreview'

type Named = Pick<ConnectionPreview, 'gatekeeperId' | 'item'>

/**
 * Keeps the spot each preview's frame last reported, for as long as the workspace stays open. A
 * frame is sent to that spot as it starts, so a preview closed and opened again, or one whose
 * frame was replaced, is drawn where it was left. The preview of an item starts at the item: its
 * ID is the anchor the connection's code draws it by. Connections are numbered within a workspace,
 * so another workspace starts afresh.
 */
export const usePreviewFocus = (workspaceId: string | undefined) => {
  const kept = useRef({ workspaceId, anchors: new Map<string, string>() })
  if (kept.current.workspaceId !== workspaceId) kept.current = { workspaceId, anchors: new Map() }
  const { anchors } = kept.current
  // Counts the spots previews were sent to by anything but their own frames.
  const [navigation, setNavigation] = useState(0)

  return {
    /** The `GadgetUI` focus of `preview`'s frame. */
    focusOf: (preview: Named): GadgetUIFocus => {
      const key = previewKey(preview)
      const latestAnchor = () => anchors.get(key) ?? preview.item
      return {
        anchor: latestAnchor(),
        latestAnchor,
        navigation,
        onFocusChange: focus => {
          if (focus) anchors.set(key, focus.anchor)
          else anchors.delete(key)
        },
      }
    },
    /** Sends `preview` to `anchor` (a sent message's chip): its frame if it is open, or its next. */
    send: (preview: Named, anchor: string) => {
      const key = previewKey(preview)
      // A frame sent where it already is reports nothing anew, and the composer would lose the spot.
      if (anchors.get(key) === anchor) return
      anchors.set(key, anchor)
      setNavigation(count => count + 1)
    },
  }
}
