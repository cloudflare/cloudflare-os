import type { AiChatMessage, ChatCodeBase } from '@gadgets/workshop-shared/api'
import { composeEpochChanges, type CodeChange } from '@gadgets/workshop-shared/code-change'

type Changes = Extract<AiChatMessage, { type: 'changes' }>

/**
 * The batches of changes a chat still proposes: those from the message that opened its epoch
 * (`ChatCodeBase.epoch`, which a migrated chat's conversion message is, its change and all) that no
 * revert has discarded since, in the order they were made.
 */
export const epochBatches = (messages: readonly AiChatMessage[], epoch: number | undefined) => {
  let batches: Changes[] = []
  for (const message of messages.toSorted((a, b) => a.sequence - b.sequence)) {
    if (epoch !== undefined && message.sequence < epoch) continue
    if (message.type === 'changes') batches.push(message)
    else if (message.type === 'merge') batches = batches.filter(({ sequence }) => sequence > message.mergeThrough)
    else if (message.type === 'revert') batches = batches.filter(({ sequence }) => sequence < message.revertFrom)
  }
  return batches
}

/** What a chat's history says of its code since it was last kept. */
export type EpochCode = {
  /** The stream's generation it is of (`ChatCodeBase.generation`). */
  generation: number
  /** The generation it took over from where keeping the chat's changes closed that one. */
  prior?: ChatCodeBase['prior']
  /** Its changes, as one, over each gadget's pin. */
  change: CodeChange
  /** The rows of `generation` those take in, through this revision: later rows come on top. */
  rowsThrough: number
  /** What the keep that opened the epoch left each gadget it changed at, by its id. */
  kept: ReadonlyMap<number, string>
}

const NOTHING: CodeChange = {}

/** What `messages`, which must reach back to the epoch's start, say of the chat's code as `codeBase` stands. */
export const epochCode = (messages: readonly AiChatMessage[], codeBase: ChatCodeBase | undefined): EpochCode => {
  const generation = codeBase?.generation ?? 0
  const epoch = codeBase?.epoch
  const batches = epochBatches(messages, epoch)
  let rowsThrough = 0
  // Revisions start again with each generation, so only this one's say where its rows are.
  for (const { watermark } of batches) {
    if (watermark?.changesGeneration === generation) rowsThrough = Math.max(rowsThrough, watermark.throughRevision)
  }
  const opening = epoch === undefined ? undefined : messages.find(({ sequence }) => sequence === epoch)
  return {
    generation,
    prior: codeBase?.prior,
    change: composeEpochChanges(batches) ?? NOTHING,
    rowsThrough,
    kept: new Map(opening?.type === 'merge' ? opening.commits.map(({ gadgetId, commitId }) => [gadgetId, commitId]) : []),
  }
}
