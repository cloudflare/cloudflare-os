import { useState } from 'react'
import type { GadgetFocus, GadgetSummary, MessageFocus, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'
import type { PaneFocus } from './paneFocus'

type GadgetSpot = { gadgetId: WorkpieceId; spot: GadgetFocus }

/**
 * Keeps the spot the selected gadget's frame last reported, for the composer's focus chip.
 * Returns the `GadgetUI` focus to give that frame, wrapping `uiFocus` (from `useFocusUrl`), and
 * the focus the pane offers a message: the gadget whenever the pane is showing it, with the spot
 * once the current frame has reported one, or once a sent message's chip has sent it there.
 * Call `onFocusOpened` with that chip's focus as it opens it.
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
}): {
  uiFocus: GadgetUIFocus | undefined
  paneFocus: PaneFocus | undefined
  onFocusOpened: (focus: MessageFocus) => void
} => {
  // Tagged with its gadget, and dropped once another is selected: the frame a returning selection
  // gets is a new one, which hasn't reported yet.
  const [reported, setReported] = useState<GadgetSpot | null>(null)
  if (reported !== null && reported.gadgetId !== gadget?.id) setReported(null)
  // The spot a sent message's chip sent the gadget to, as that message recorded it, since a gadget
  // need not report the spot it is sent to. The click records it before the URL selects the gadget
  // and anchor, so it waits for them (`shown`), and stands until the URL moves on or the gadget
  // reports. A frame reset leaves it: opening another gadget's spot starts a new frame.
  const [opened, setOpened] = useState<GadgetSpot & { shown: boolean } | null>(null)
  const showsOpened = opened !== null && opened.gadgetId === gadget?.id && opened.spot.anchor === uiFocus?.anchor
  if (showsOpened && !opened.shown) setOpened({ ...opened, shown: true })
  if (!showsOpened && opened?.shown) setOpened(null)
  const onFocusOpened = ({ gadgetId, spot }: MessageFocus) => {
    // A click that leaves `at` as it is sends the frame nowhere, so its report still stands.
    if (spot && !(gadgetId === gadget?.id && spot.anchor === uiFocus?.anchor)) {
      setOpened({ gadgetId, spot, shown: false })
    }
  }
  if (gadget === undefined) return { uiFocus, paneFocus: undefined, onFocusOpened }
  const gadgetId = gadget.id
  const spot = showsOpened ? opened.spot : reported?.gadgetId === gadgetId ? reported.spot : undefined
  return {
    uiFocus: uiFocus && {
      ...uiFocus,
      onFocusChange: focus => {
        uiFocus.onFocusChange(focus)
        setReported(focus && { gadgetId, spot: focus })
        // A report from the gadget being left mustn't cancel the spot the click is opening.
        setOpened(current => current?.gadgetId === gadgetId ? null : current)
      },
      // A new frame may be running different code, so the old frame's label must not show while
      // it starts, and a frame sent elsewhere has left the spot it reported. The URL keeps the
      // anchor, which the frame is sent to.
      onFocusReset: () => setReported(null),
    },
    paneFocus: showsGadget
      ? {
          focus: { gadgetId, gadgetTitle: gadget.title, ...(spot && { spot }) },
          pendingChatId: gadget.chatId,
        }
      : undefined,
    onFocusOpened,
  }
}
