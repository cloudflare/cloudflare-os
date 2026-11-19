import type { AiChatMessage } from '@gadgets/workshop-shared/api'

type Changes = Extract<AiChatMessage, { type: 'changes' }>

/**
 * The batches of changes a chat still proposes: those after the merge that opened its epoch
 * (`ChatCodeBase.epoch`) that no revert has discarded since.
 */
const proposedBatches = (messages: readonly AiChatMessage[], epoch: number | undefined) => {
  let batches: Changes[] = []
  for (const message of messages.toSorted((a, b) => a.sequence - b.sequence)) {
    if (epoch !== undefined && message.sequence <= epoch) continue
    if (message.type === 'changes') batches.push(message)
    else if (message.type === 'merge') batches = batches.filter(({ sequence }) => sequence > message.mergeThrough)
    else if (message.type === 'revert') batches = batches.filter(({ sequence }) => sequence < message.revertFrom)
  }
  return batches
}

/** What a chat's still-proposed changes would do, as far as the user is asked to keep them. */
export type ProposedChanges = {
  /** Gadgets they make. */
  created: { gadgetId: number; title: string }[]
  /** Gadgets already there whose code they change. */
  edited: number[]
  /**
   * What they give gadgets and agent spawners to reach: the one given it (`gadgetId`), the name its
   * code reaches it by (`env.NAME`), and what it reaches.
   */
  bindings: { gadgetId: number; name: string; target: number }[]
  /**
   * Gadgets they bring a blueprint's update into. Not one they make from a blueprint, whose
   * release comes with it, as its code.
   */
  updates: { gadgetId: number; title: string }[]
  /** They bring in what has been accepted elsewhere since the chat began. */
  mainline: boolean
  /** Files left with conflict markers, by path, which keeping them would keep as they are. */
  conflicts: string[]
}

/** What the batches a chat still proposes add up to. `messages` must reach back to its epoch. */
export const proposedChanges = (messages: readonly AiChatMessage[], epoch: number | undefined): ProposedChanges => {
  const batches = proposedBatches(messages, epoch)
  const created = batches.flatMap(({ createdGadgets = [] }) => createdGadgets.map(({ gadgetId, title }) => ({ gadgetId, title })))
  const made = new Set(created.map(({ gadgetId }) => gadgetId))
  const edited = new Set(batches.flatMap(({ change = {} }) => Object.keys(change).map(Number)).filter((gadgetId) => !made.has(gadgetId)))
  const conflicts = new Set<string>()
  for (const { blueprintMerges = [], mainlineMerge } of batches) {
    for (const { conflictPaths } of blueprintMerges) conflictPaths.forEach((path) => conflicts.add(path))
    for (const { conflictPaths = [] } of mainlineMerge?.gadgets ?? []) conflictPaths.forEach((path) => conflicts.add(path))
    mainlineMerge?.conflictPaths.forEach((path) => conflicts.add(path))
  }
  return {
    created,
    edited: [...edited],
    bindings: batches.flatMap(({ addedBindings = [] }) => addedBindings.map(({ gadgetId, name, target }) => ({ gadgetId, name, target }))),
    updates: batches.flatMap(({ blueprintMerges = [] }) => blueprintMerges.filter(({ gadgetId }) => !made.has(gadgetId)).map(({ gadgetId, title }) => ({ gadgetId, title }))),
    mainline: batches.some(({ mainlineMerge }) => mainlineMerge !== undefined),
    conflicts: [...conflicts],
  }
}
