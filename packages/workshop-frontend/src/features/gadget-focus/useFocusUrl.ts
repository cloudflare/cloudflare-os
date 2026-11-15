import { useEffect, useRef } from 'react'
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
 * Keeps the spot the selected gadget's frame reports in the URL's `at`, beside `w`, and sends a
 * new frame back to it. Returns the selected gadget's `GadgetUI` focus.
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
  const atRef = useRef(at)
  atRef.current = at
  // Open for FOCUS_URL_WRITE_DELAY_MS after a write, holding the latest report since. A report
  // that finds it closed is written at once.
  const holdRef = useRef<{
    timer: ReturnType<typeof setTimeout>
    pending: { focus: GadgetFocus | null } | null
  } | null>(null)
  // A write that changes `at` and hasn't yet come back through the URL, to tell it apart from `at`
  // being set elsewhere.
  const unacknowledgedWriteRef = useRef<{ at: string | undefined } | null>(null)

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
    unacknowledgedWriteRef.current = null
  }, [workspaceId, selectedGadgetId])

  // `at` set elsewhere (a followed link) is newer than any report still waiting to be written.
  useEffect(() => {
    const write = unacknowledgedWriteRef.current
    unacknowledgedWriteRef.current = null
    if (write === null || write.at !== at) cancelPendingWrite()
  }, [at])

  const atApplies = urlWorkpieceId !== null && urlWorkpieceId === selectedGadgetId
  useEffect(() => {
    if (at !== undefined && selectionSettled && !atApplies) replaceSearchRef.current({ at: undefined })
  }, [at, selectionSettled, atApplies])

  if (selectedGadgetId === null) return undefined
  const write = (focus: GadgetFocus | null) => {
    // A write that leaves `at` as it is never comes back as a change.
    if (focus?.anchor !== atRef.current) unacknowledgedWriteRef.current = { at: focus?.anchor }
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
    anchor: atApplies ? at : undefined,
    onFocusChange: focus => {
      // A gadget that reports only null doesn't need `w` pinned. `at` may not yet show our last
      // write, which a null report must still clear.
      const at = unacknowledgedWriteRef.current ? unacknowledgedWriteRef.current.at : atRef.current
      const report = focus === null && at === undefined ? null : { focus }
      if (holdRef.current) holdRef.current.pending = report
      else if (report) write(report.focus)
    },
  }
}
