import { useCallback, useState } from 'react'
import type { GadgetFocus, GadgetSummary, MessageFocus, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'
import type { PaneFocus } from './paneFocus'

type GadgetSpot = { gadgetId: WorkpieceId; spot: GadgetFocus }

/**
 * What the workspace pane shows: the selected workpiece (any of its tabs), activity, or nothing,
 * when it is closed.
 */
export type PaneView = 'workpiece' | 'activity' | null

/**
 * Keeps the spot the selected gadget's frame last reported, for the composer's focus chip.
 * Returns the `GadgetUI` focus to give that frame, wrapping `uiFocus` (from `useFocusUrl`), and
 * the focus the pane offers a message: the gadget whenever the pane is showing it, with the spot
 * once the current frame has reported one, or once a sent message's chip has sent it there.
 * Each new focus signal is a new offer (see `FocusOffer`).
 * Call `onFocusOpened` with that chip's focus as it opens it, and `onWorkspaceChange` when the
 * editor moves to another workspace, whose pane has shown nothing yet.
 */
export const usePaneFocus = ({ uiFocus, gadget, pane, singlePane }: {
  uiFocus: GadgetUIFocus | undefined
  /** The selected workpiece, when it is a gadget. */
  gadget: GadgetSummary | undefined
  pane: PaneView
  /**
   * Whether the chat and the pane take turns on screen. Closing the pane is then only switching to
   * the chat, so the composer offers what the pane showed when it was last open. Beside the chat,
   * closing it is deliberate, and offers nothing.
   */
  singlePane: boolean
}): {
  uiFocus: GadgetUIFocus | undefined
  paneFocus: PaneFocus | undefined
  onFocusOpened: (focus: MessageFocus) => void
  onWorkspaceChange: () => void
} => {
  // The gadget the pane showed when last open in this workspace; null if it showed something else
  // or hasn't been open. Kept by id, because the selection can move while the pane is closed (the
  // agent's edits pull it along, and a workpiece the pane remembers may be deleted), and the user
  // hasn't seen the gadget it moves to.
  const [lastShown, setLastShown] = useState<WorkpieceId | null>(null)
  const showing = pane === 'workpiece' ? gadget?.id ?? null : null
  if (pane !== null && showing !== lastShown) setLastShown(showing)
  const onWorkspaceChange = useCallback(() => setLastShown(null), [])
  const showsGadget = pane === 'workpiece' ||
    (pane === null && singlePane && gadget !== undefined && gadget.id === lastShown)
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
  // The anchor is the selected gadget's last report, which a frame reset leaves, so a new frame
  // restored to the spot is the same offer. A chip opening another gadget's spot records it before
  // the URL selects that gadget, so it is carried over here.
  const [offer, setOffer] = useState<{ id: number; gadgetId: WorkpieceId | undefined; anchor: string | undefined }>(
    () => ({ id: 0, gadgetId: gadget?.id, anchor: undefined }))
  if (offer.gadgetId !== gadget?.id) {
    const anchor = opened?.gadgetId === gadget?.id ? opened?.spot.anchor : undefined
    setOffer({ id: offer.id + 1, gadgetId: gadget?.id, anchor })
  }
  const onFocusOpened = ({ gadgetId, spot }: MessageFocus) => {
    // A click that leaves `at` as it is sends the frame nowhere, so its report still stands.
    const opens = spot && !(gadgetId === gadget?.id && spot.anchor === uiFocus?.anchor) ? spot : undefined
    // Opening a chip asks for its focus, even one just dismissed, and a spot it opens is the one the
    // gadget's next report moves from.
    setOffer(current => ({ ...current, id: current.id + 1, anchor: opens ? opens.anchor : current.anchor }))
    if (opens) setOpened({ gadgetId, spot: opens, shown: false })
  }
  if (gadget === undefined) return { uiFocus, paneFocus: undefined, onFocusOpened, onWorkspaceChange }
  const gadgetId = gadget.id
  const spot = showsOpened ? opened.spot : reported?.gadgetId === gadgetId ? reported.spot : undefined
  return {
    uiFocus: uiFocus && {
      ...uiFocus,
      onFocusChange: focus => {
        uiFocus.onFocusChange(focus)
        setReported(focus && { gadgetId, spot: focus })
        setOffer(current => current.gadgetId === gadgetId && current.anchor !== focus?.anchor
          ? { id: current.id + 1, gadgetId, anchor: focus?.anchor }
          : current)
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
          offerId: offer.id,
          pendingChatId: gadget.chatId,
        }
      : undefined,
    onFocusOpened,
    onWorkspaceChange,
  }
}
