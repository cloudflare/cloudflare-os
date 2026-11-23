import { useEffect, useRef, useState } from 'react'
import type { GadgetFocus, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'

/**
 * How long after a write further reports are held back, the last of them written when it ends:
 * browsers rate-limit replaceState, and a drag-selection reports per event.
 */
export const FOCUS_URL_WRITE_DELAY_MS = 300

/**
 * The workspace URL's search params with `w` set to `workpieceId`. `at` names a spot only in the
 * gadget `w` names, so it is kept only if `w` is unchanged.
 */
export const withWorkpiece = (prev: Record<string, unknown>, workpieceId: WorkpieceId | undefined) => ({
  ...prev,
  w: workpieceId,
  at: prev.w === workpieceId && typeof prev.at === 'string' ? prev.at : undefined,
})

type FocusUrlOptions = {
  workspaceId: string | undefined
  // The URL's `w` and `at`.
  urlWorkpieceId: WorkpieceId | null
  at: string | undefined
  selectedGadgetId: WorkpieceId | null
  // Whether the selection is final enough to conclude that `w` can't be selected: until the
  // workpieces and chats have loaded, a pending gadget `w` names isn't selectable yet.
  selectionSettled: boolean
  // Changes the URL's search params without adding a history entry.
  replaceSearch: (changes: { w?: WorkpieceId; at: string | undefined }) => void
}

/**
 * Keeps the spot the selected gadget's frame reports in the URL's `at`, beside `w`, and sends the
 * frame to an anchor the URL gets any other way. Returns the selected gadget's `GadgetUI` focus.
 */
export const useFocusUrl = ({
  workspaceId,
  urlWorkpieceId,
  at,
  selectedGadgetId,
  selectionSettled,
  replaceSearch,
}: FocusUrlOptions): GadgetUIFocus | undefined => {
  const replaceSearchRef = useRef(replaceSearch)
  replaceSearchRef.current = replaceSearch
  const atApplies = urlWorkpieceId !== null && urlWorkpieceId === selectedGadgetId
  const anchor = atApplies ? at : undefined
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  // Open for FOCUS_URL_WRITE_DELAY_MS after a write, holding the latest report since. A report
  // that finds it closed is written at once.
  const holdRef = useRef<{
    timer: ReturnType<typeof setTimeout>
    pending: { focus: GadgetFocus | null } | null
  } | null>(null)
  // The anchors our writes have set that haven't yet come back through the URL, oldest first. The
  // anchor changing to one of them is that write landing; to anything else, it was set elsewhere (a
  // followed link, a sent message's chip).
  const unacknowledgedWritesRef = useRef<(string | undefined)[]>([])
  // The anchor the URL will hold once every write so far has landed.
  const writtenAnchor = () => {
    const writes = unacknowledgedWritesRef.current
    return writes.length > 0 ? writes[writes.length - 1] : anchorRef.current
  }

  // Counted during render, so the frame gets a new anchor together with whether to go there.
  const [target, setTarget] = useState({ anchor, navigation: 0 })
  if (target.anchor !== anchor) {
    const setElsewhere = !unacknowledgedWritesRef.current.includes(anchor)
    setTarget({ anchor, navigation: target.navigation + (setElsewhere ? 1 : 0) })
  }

  // Also ends the hold, so the next report, which may be the first from another gadget, isn't
  // held back behind a write it has nothing to do with.
  const cancelPendingWrite = () => {
    if (holdRef.current === null) return
    clearTimeout(holdRef.current.timer)
    holdRef.current = null
  }

  // A report from the previous gadget, or workspace, must never land on this one, nor its write be
  // taken for this one's.
  useEffect(() => () => {
    cancelPendingWrite()
    unacknowledgedWritesRef.current = []
  }, [workspaceId, selectedGadgetId])

  useEffect(() => {
    const writes = unacknowledgedWritesRef.current
    const landed = writes.indexOf(anchor)
    unacknowledgedWritesRef.current = landed < 0 ? [] : writes.slice(landed + 1)
    // An anchor set elsewhere is newer than any report still waiting to be written.
    if (landed < 0) cancelPendingWrite()
  }, [anchor])

  useEffect(() => {
    if (at !== undefined && selectionSettled && !atApplies) replaceSearchRef.current({ at: undefined })
  }, [at, selectionSettled, atApplies])

  if (selectedGadgetId === null) return undefined
  const write = (focus: GadgetFocus | null) => {
    // A write that leaves the anchor as it is never comes back as a change.
    if (focus?.anchor !== writtenAnchor()) unacknowledgedWritesRef.current.push(focus?.anchor)
    // `w` too, since `at` means nothing without it: with no `w` the editor picks a gadget from this
    // browser's state, so a copied link could open on another.
    replaceSearchRef.current({ w: selectedGadgetId, at: focus?.anchor })
    const hold: NonNullable<typeof holdRef.current> = {
      timer: setTimeout(() => {
        holdRef.current = null
        if (hold.pending) write(hold.pending.focus)
      }, FOCUS_URL_WRITE_DELAY_MS),
      pending: null,
    }
    holdRef.current = hold
  }
  return {
    anchor,
    navigation: target.navigation,
    latestAnchor: () => holdRef.current?.pending ? holdRef.current.pending.focus?.anchor : writtenAnchor(),
    onFocusChange: focus => {
      // A gadget that reports only null doesn't need `w` pinned. The URL may not yet show our last
      // write, which a null report must still clear.
      const report = focus === null && writtenAnchor() === undefined ? null : { focus }
      if (holdRef.current) holdRef.current.pending = report
      else if (report) write(report.focus)
    },
  }
}
