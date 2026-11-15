import { useState } from 'react'
import type { GadgetFocus, GadgetSummary, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'
import type { PaneFocus } from './paneFocus'

/**
 * Keeps the spot the selected gadget's frame last reported, for the composer's focus chip.
 * Returns the `GadgetUI` focus to give that frame, wrapping `uiFocus` (from `useFocusUrl`), and
 * the focus the pane offers a message: the gadget whenever the pane is showing it, with the spot
 * once the current frame has reported one.
 */
export const usePaneFocus = ({ uiFocus, gadget, showsGadget }: {
  uiFocus: GadgetUIFocus | undefined
  /** The selected workpiece, when it is a gadget. */
  gadget: GadgetSummary | undefined
  /**
   * Whether the workspace pane is showing it, rather than activity or nothing. Its code tab still
   * counts: the user is still working on that gadget.
   */
  showsGadget: boolean
}): { uiFocus: GadgetUIFocus | undefined; paneFocus: PaneFocus | undefined } => {
  // Tagged with its gadget, and dropped once another is selected: the frame a returning selection
  // gets is a new one, which hasn't reported yet.
  const [reported, setReported] = useState<{ gadgetId: WorkpieceId; spot: GadgetFocus } | null>(null)
  if (reported !== null && reported.gadgetId !== gadget?.id) setReported(null)
  if (gadget === undefined) return { uiFocus, paneFocus: undefined }
  const gadgetId = gadget.id
  const spot = reported?.gadgetId === gadgetId ? reported.spot : undefined
  return {
    uiFocus: uiFocus && {
      ...uiFocus,
      onFocusChange: focus => {
        uiFocus.onFocusChange(focus)
        setReported(focus && { gadgetId, spot: focus })
      },
      // A new frame may be running different code, so the old frame's label must not show while
      // it starts. The URL keeps the anchor, which the new frame is sent to.
      onFocusReset: () => setReported(null),
    },
    paneFocus: showsGadget
      ? {
          focus: { gadgetId, gadgetTitle: gadget.title, ...(spot && { spot }) },
          pendingChatId: gadget.chatId,
        }
      : undefined,
  }
}
