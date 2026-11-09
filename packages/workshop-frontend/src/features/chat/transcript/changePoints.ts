import type { AiChatMessage, WorkpieceId } from '@gadgets/workshop-shared/api'
import { listApps } from './ChangeLine'

/** A point in the chat the person can go back to, as its line draws it (see ChangeLine). */
export type ChangePoint = {
  label: string
  /** The app whose glyph the line shows. */
  gadgetId: WorkpieceId
  /** A restore, drawn with the back arrow rather than the app's glyph. */
  back: boolean
  action?: 'Undo' | 'Redo' | 'Restore'
  /** What the action asks Overseer.restoreChanges() for. */
  to?: 'before' | 'after'
  actionTitle?: string
  /** The apps the action deletes, which it confirms first: those the undone accept created. */
  deletes?: string[]
}

/**
 * The points the person can go back to, by message sequence: every accept that changed an app,
 * which a turn's end makes itself (see the merge message's `automatic`), and every restore. The
 * newest offers Undo, putting things as they were before it; the rest offer Restore, bringing
 * back how things were there.
 */
export function findChangePoints(messages: readonly AiChatMessage[],
  appTitle: (id: WorkpieceId) => string): Map<number, ChangePoint> {
  const points = new Map<number, ChangePoint>()
  const bySequence = new Map(messages.map((m) => [m.sequence, m]))
  let latest: number | undefined
  for (const m of messages) {
    if (m.type === 'merge' && m.commits.length > 0) latest = m.sequence
    if (m.type === 'restore') latest = m.sequence
  }
  for (const m of messages) {
    if (m.type === 'merge' && m.commits.length > 0) {
      const titles = m.commits.map((c) => appTitle(c.gadgetId))
      const created = m.commits.filter((c) => c.previousCommit === null).map((c) => appTitle(c.gadgetId))
      // A merge from before merges recorded what they replaced has no way back.
      const restorable = m.commits.every((c) => c.previousCommit !== undefined)
      const isLatest = m.sequence === latest
      points.set(m.sequence, {
        label: `${created.length === titles.length ? 'Created' : 'Updated'} ${listApps(titles)}`,
        gadgetId: m.commits[0].gadgetId, back: false,
        ...(restorable ? isLatest
          ? { action: 'Undo' as const, to: 'before' as const,
              actionTitle: `Put ${listApps(titles)} back as ${titles.length > 1 ? 'they were' : 'it was'} before this`,
              ...(created.length > 0 ? { deletes: created } : {}) }
          : { action: 'Restore' as const, to: 'after' as const,
              actionTitle: `Bring ${listApps(titles)} back to how ${titles.length > 1 ? 'they were' : 'it was'} here` }
        : {}),
      })
    } else if (m.type === 'restore') {
      const removed = (m.removedGadgets ?? []).map((r) => r.title)
      const titles = m.commits.map((c) => appTitle(c.gadgetId))
      const target = bySequence.get(m.from)
      // Going back to before an undo is a redo, and says so.
      const undid = m.to === 'before' && target?.type === 'merge'
      const redid = m.to === 'before' && target?.type === 'restore' && target.to === 'before'
      const label = titles.length === 0 ? `Removed ${listApps(removed)}`
        : undid ? `Undid changes to ${listApps(titles)}`
        : redid ? `Redid changes to ${listApps(titles)}`
        : m.to === 'after' ? `Restored ${listApps(titles)} to an earlier version`
        : `Undid restoring ${listApps(titles)}`
      const isLatest = m.sequence === latest
      points.set(m.sequence, {
        label, gadgetId: m.commits[0]?.gadgetId ?? m.removedGadgets![0].gadgetId, back: true,
        ...(titles.length === 0 ? {} : isLatest
          ? { action: undid ? 'Redo' as const : 'Undo' as const, to: 'before' as const,
              actionTitle: undid ? `Bring back the changes to ${listApps(titles)}` : `Undo this` }
          : { action: 'Restore' as const, to: 'after' as const,
              actionTitle: `Bring ${listApps(titles)} back to how ${titles.length > 1 ? 'they were' : 'it was'} here` }),
      })
    }
  }
  return points
}
