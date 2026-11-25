/**
 * The runs a chat's agent started that the viewer has seen the end of, by chat, for the visit:
 * those that had ended when the list beside the composer was put away, and those opened once
 * ended. Nothing else knows of it, so it starts over with the tab.
 */
const seen = new Map<string, ReadonlySet<number>>()
const keyOf = (workspaceId: string, chatId: number) => `${workspaceId}:${chatId}`

const NONE: ReadonlySet<number> = new Set()

/** The ended runs of the chat seen so far, by their chat ids. */
export const seenRunsOf = (workspaceId: string, chatId: number): ReadonlySet<number> => seen.get(keyOf(workspaceId, chatId)) ?? NONE

/** Marks `runIds` seen, and gives what is seen now. */
export const markRunsSeen = (workspaceId: string, chatId: number, runIds: readonly number[]): ReadonlySet<number> => {
  const before = seenRunsOf(workspaceId, chatId)
  if (runIds.every((id) => before.has(id))) return before
  const after = new Set([...before, ...runIds])
  seen.set(keyOf(workspaceId, chatId), after)
  return after
}
