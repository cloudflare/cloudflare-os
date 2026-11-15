import { useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedFileKind } from '@/files/connectedFile'
import type { ChangeDecision } from './resource-preview/changeMarks'
import { loadingPreview } from './resource-preview/loadingPreview'
import { ResourcePreviewView } from './resource-preview/ResourcePreviewView'
import { ReviewBar, type ReviewBarProps, type ReviewChange } from './ReviewBar'
import type { ActionResult } from './usePending'

/** The changes waiting on a file, to decide on it, and how deciding them goes. */
export type ConnectedFileReview = {
  /** Those still waiting, in the order they were asked for. */
  changes: ReviewChange[]
  /** Those decided since it was drawn, by log id, drawn settled or undone until it is drawn again. */
  decided: ReadonlyMap<number, ChangeDecision>
  /** Decides these, in the order given. */
  onDecide: (actionIds: number[], decision: 'approve' | 'deny') => ActionResult
  /** One of them makes the file, so they are decided whole: made with them, or not at all. */
  creates?: boolean
} & Pick<ReviewBarProps, 'restricted' | 'progress' | 'problem' | 'onDismissProblem'>

export type ConnectedFileViewProps = {
  /** The file as drawn; absent while it is on its way. */
  preview?: ResourcePreview
  /** What it is, so that a blank one can stand in for it while it loads. */
  kind: ConnectedFileKind
  /** Its waiting changes, to decide here; left out, it is only shown. */
  review?: ConnectedFileReview
}

const NO_DECISIONS = new Map<number, never>()

/**
 * The change to step to: the one stepped to while it waits, else the next that does after it in
 * `order` (the order they are drawn in), else the last that does.
 */
const focusOf = (wanted: number | undefined, waiting: readonly ReviewChange[], order: readonly number[]) => {
  if (waiting.some(({ actionId }) => actionId === wanted)) return wanted
  const from = wanted === undefined ? -1 : order.indexOf(wanted)
  const next = waiting.find(({ actionId }) => order.indexOf(actionId) > from)
  return (next ?? waiting.at(-1))?.actionId
}

/**
 * A Google Doc, Sheet or Slides deck, drawn in its own look as it will be once the changes waiting
 * on it are made, and read only: it is edited in its own editor. While it loads a blank one of its
 * kind stands where it will be, so nothing moves when it arrives. Changes waiting are marked where
 * they land.
 *
 * With a `review`, its waiting changes are decided on it: a bar over its foot (`ReviewBar`) steps
 * through them in the order they are drawn, the file outlining and scrolling to each, and clicking
 * one on the file steps to it. Decided, a change settles or is undone where it is, and the bar
 * moves on to the next; it goes once nothing waits. A file not made yet is drawn as it will be
 * made, and made with its changes, or not at all. Without one, as from the Library, a pill over its
 * foot counts them.
 */
export const ConnectedFileView = ({ preview, kind, review }: ConnectedFileViewProps) => {
  const [wanted, setWanted] = useState<number>()
  const drawnOrder = preview?.actions ?? []
  // A file not made yet is made first, then changed. One that exists is stepped through in the
  // order it draws them, and any it does not, such as a change to its name, after.
  const changes = !review ? []
    : review.creates ? review.changes.toSorted((a, b) => a.actionId - b.actionId)
    : review.changes.toSorted((a, b) => rank(drawnOrder, a.actionId) - rank(drawnOrder, b.actionId))
  const order = changes.map(({ actionId }) => actionId)
  // A file not made yet is drawn as made, its changes as its own text, and has nothing to step to.
  // Where each must be read before it is approved, it is stepped through instead, its making first.
  const creating = review?.creates === true && !review.restricted
  const focused = review && !creating ? focusOf(wanted, changes, [...drawnOrder, ...order]) : undefined
  const decided = creating ? new Map(drawnOrder.map((id) => [id, 'approved' as const])) : review?.decided ?? NO_DECISIONS
  // Without a review, those drawn are only counted.
  const waiting = drawnOrder.filter((id) => id >= 0).length
  const decide = (ids: number[], decision: 'approve' | 'deny') => {
    // Stays where it was, so that the next one waiting is stepped to.
    if (focused !== undefined) setWanted(focused)
    return review?.onDecide(ids, decision)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResourcePreviewView
        preview={preview ?? loadingPreview(kind)}
        loading={!preview}
        focusedChangeId={focused ?? null}
        decided={decided}
        onChangeClick={(id) => !creating && order.includes(id) && setWanted(id)}
        overlay={review ? (
          <AnimatePresence>
            {(focused !== undefined || (creating && changes.length > 0)) && preview && (
              <ReviewBar
                key="review"
                changes={changes}
                focusedId={focused ?? changes[0].actionId}
                creates={creating ? { title: preview.title, kind: preview.content.type } : undefined}
                onFocus={setWanted}
                onApprove={(id) => decide([id], 'approve')}
                onDeny={(id) => decide([id], 'deny')}
                onApproveAll={() => decide(order, 'approve')}
                onDenyAll={() => decide(order, 'deny')}
                restricted={review.restricted}
                progress={review.progress}
                problem={review.problem}
                onDismissProblem={review.onDismissProblem}
              />
            )}
          </AnimatePresence>
        ) : waiting > 0 ? (
          <p className="pointer-events-auto mx-auto w-fit rounded-full bg-kumo-base px-3 py-1.5 text-sm text-kumo-subtle ring-1 ring-kumo-line shadow-[0_2px_6px_rgb(0_0_0/0.03)]">
            Shows {waiting} {waiting === 1 ? 'change' : 'changes'} waiting for review
          </p>
        ) : undefined}
      />
    </div>
  )
}

const rank = (order: readonly number[], id: number) => {
  const at = order.indexOf(id)
  return at === -1 ? order.length + id : at
}
