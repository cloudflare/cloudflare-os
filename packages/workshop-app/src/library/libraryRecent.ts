import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { MAX_OPENED_OUTPUTS, type OutputRef } from '@/prefs/preferenceFields'
import type { UserPreferences } from '@/prefs/UserPreferences'
import { outputKey } from './libraryList'

/** How many of those opened last the Recent tab shows, after what needs the user. */
export const RECENT_SHOWN = 12

/** What waits on the user of `outputs` (`waitingOf`): the most waiting first, then the latest active. */
export const needingYou = (outputs: readonly OutputSummary[], waitingOf: (output: OutputSummary) => number = () => 0) =>
  outputs
    .filter((output) => waitingOf(output) > 0)
    .toSorted((a, b) => waitingOf(b) - waitingOf(a) || b.lastActive.getTime() - a.lastActive.getTime())

/**
 * What the Recent tab has of `outputs`: what waits on the user (`needingYou`), then what they
 * opened last (`opened`, their keys, latest first) that does not, as many as `RECENT_SHOWN`. One
 * opened that is no longer there is passed over.
 */
export const recentOutputs = (outputs: readonly OutputSummary[], opened: readonly string[], waitingOf?: (output: OutputSummary) => number) => {
  const needsYou = needingYou(outputs, waitingOf)
  const waiting = new Set(needsYou.map(outputKey))
  const byKey = new Map(outputs.map((output) => [outputKey(output), output]))
  return {
    needsYou,
    opened: opened.flatMap((key) => (waiting.has(key) ? [] : byKey.get(key) ?? [])).slice(0, RECENT_SHOWN),
  }
}

/**
 * Remembers that `output` was opened now, in the user's preferences (`openedOutputs`), for the
 * Recent tab: latest first, each once, the latest MAX_OPENED_OUTPUTS. Nothing is sent when it
 * already is the latest.
 */
export const recordOpened = (preferences: UserPreferences, output: OutputRef) => {
  const key = outputKey(output)
  const [latest] = preferences.getSnapshot().openedOutputs
  if (latest && outputKey(latest) === key) return
  preferences.change(({ openedOutputs }) => ({
    openedOutputs: [output, ...openedOutputs.filter((other) => outputKey(other) !== key)].slice(0, MAX_OPENED_OUTPUTS),
  }))
}
