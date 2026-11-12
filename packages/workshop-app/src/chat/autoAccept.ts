import type { AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'

type Changes = Extract<AiChatMessage, { type: 'changes' }>

/**
 * Whether a chat's changes can be accepted without anyone asking, as far as the workspace goes:
 * it has some, its agent is not working, and the viewer is the only one working on what they
 * change. Nobody else is in the workspace (`shared`), and no other chat has changes waiting to
 * the same workpieces, which accepting these would leave behind.
 */
export const acceptsAlone = (chat: AiChatMetadata, chats: readonly AiChatMetadata[], shared: boolean) => {
  const proposed = chat.proposedChangeWorkpieces ?? []
  if (chat.activeAgent || proposed.length === 0 || shared) return false
  return !chats.some(({ id, proposedChangeWorkpieces = [] }) =>
    id !== chat.id && proposedChangeWorkpieces.some((workpiece) => proposed.includes(workpiece)))
}

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
