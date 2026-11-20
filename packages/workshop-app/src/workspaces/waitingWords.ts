import type { WorkspaceSummary } from '@gadgets/workshop-shared/api'

/** What in a workspace waits on the user, by kind: its agents' runs, its gadgets, and its chats. */
export type WaitingCounts = { runs: number; gadgets: number; chats: number }

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)

/**
 * What waits on the user in a workspace, in a few words for its line in the sidebar, where
 * anything does: as particular as it can be where it is all of one kind ("2 gadgets need you"),
 * and only how much where it is of several ("3 things need you").
 */
export const waitingWords = ({ runs, gadgets, chats }: WaitingCounts): string | undefined => {
  const kinds = [runs, gadgets, chats].filter((n) => n > 0).length
  if (kinds === 0) return undefined
  if (kinds > 1) return `${runs + gadgets + chats} things need you`
  if (runs > 0) return runs === 1 ? 'An agent needs you' : `${runs} agent runs need you`
  if (gadgets > 0) return count(gadgets, 'A gadget needs you', 'gadgets need you')
  return count(chats, 'A chat needs you', 'chats need you')
}

/**
 * What waits on the user in a workspace, as its summary says (`WorkspaceWaiting`): the gadgets that
 * ask something, each once. Nothing, where the workspace has not said.
 */
export const waitingCountsOf = (summary: WorkspaceSummary | undefined): WaitingCounts => ({
  runs: summary?.waiting.runs ?? 0,
  chats: summary?.waiting.chats ?? 0,
  gadgets: summary?.waiting.gadgets.length ?? 0,
})
