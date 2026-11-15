import type { AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'

type Changes = Extract<AiChatMessage, { type: 'changes' }>

/**
 * Whether a chat's changes can be accepted without anyone asking, as far as the workspace goes:
 * it has some, its agent is not working, and nobody else is in the workspace (`shared`), whose work
 * in progress keeping them could overtake. Another chat with changes waiting to the same gadgets
 * does not stop it: chats are kept as they finish, and a chat kept after another brings in what
 * that one kept first (see `ChatSession`).
 */
export const acceptsAlone = (chat: AiChatMetadata, shared: boolean) =>
  !chat.activeAgent && (chat.proposedChangeWorkpieces?.length ?? 0) > 0 && !shared

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

/**
 * Whether what a chat proposes is code and nothing else, which is accepted without asking.
 * `messages` must reach back to the start of the chat's epoch.
 *
 * A binding gives a gadget a resource to use, which is the user's to grant. A blueprint's update,
 * or the latest accepted changes brought into the chat, was asked for to be looked at before it
 * is taken, and can leave conflicts in the files. A gadget the chat made from a blueprint is the
 * exception: the release comes with the gadget, as its code.
 */
export const proposesOnlyCode = (messages: readonly AiChatMessage[], epoch: number | undefined) => {
  const batches = proposedBatches(messages, epoch)
  const created = new Set(batches.flatMap(({ createdGadgets = [] }) => createdGadgets.map(({ gadgetId }) => gadgetId)))
  return batches.every((batch) =>
    !batch.addedBindings?.length &&
    !batch.mainlineMerge &&
    (batch.blueprintMerges ?? []).every(({ gadgetId }) => created.has(gadgetId)))
}

/** What a chat's still-proposed changes would do, as far as the user is asked to keep them. */
export type ProposedChanges = {
  /** Gadgets they make. */
  created: { gadgetId: number; title: string }[]
  /**
   * What they give gadgets and agent spawners to reach: the one given it (`gadgetId`), the name its
   * code reaches it by (`env.NAME`), and what it reaches.
   */
  bindings: { gadgetId: number; name: string; target: number }[]
  /** Gadgets they bring a blueprint's update into. */
  updates: { gadgetId: number; title: string }[]
  /** They bring in what has been accepted elsewhere since the chat began. */
  mainline: boolean
  /** Files left with conflict markers, by path, which keeping them would keep as they are. */
  conflicts: string[]
}

/** What the batches a chat still proposes add up to. `messages` must reach back to its epoch. */
export const proposedChanges = (messages: readonly AiChatMessage[], epoch: number | undefined): ProposedChanges => {
  const batches = proposedBatches(messages, epoch)
  const conflicts = new Set<string>()
  for (const { blueprintMerges = [], mainlineMerge } of batches) {
    for (const { conflictPaths } of blueprintMerges) conflictPaths.forEach((path) => conflicts.add(path))
    for (const { conflictPaths = [] } of mainlineMerge?.gadgets ?? []) conflictPaths.forEach((path) => conflicts.add(path))
    mainlineMerge?.conflictPaths.forEach((path) => conflicts.add(path))
  }
  return {
    created: batches.flatMap(({ createdGadgets = [] }) => createdGadgets.map(({ gadgetId, title }) => ({ gadgetId, title }))),
    bindings: batches.flatMap(({ addedBindings = [] }) => addedBindings.map(({ gadgetId, name, target }) => ({ gadgetId, name, target }))),
    updates: batches.flatMap(({ blueprintMerges = [] }) => blueprintMerges.map(({ gadgetId, title }) => ({ gadgetId, title }))),
    mainline: batches.some(({ mainlineMerge }) => mainlineMerge !== undefined),
    conflicts: [...conflicts],
  }
}
