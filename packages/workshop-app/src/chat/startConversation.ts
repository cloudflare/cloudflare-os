import type { RpcPromise } from 'capnweb'
import type { GatekeeperClient, MessageFormatRef, Overseer } from '@gadgets/workshop-shared/api'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import type { AddedConnection, ConnectionSource } from '@/connections/AddConnection'
import { withCapsules } from './capsules'
import { missingCommand, slashRequestFor } from './slashCommands'
import { assertAttachable, uploadAttachments } from './uploadAttachments'

/** The part of a workspace's Overseer that starting a conversation uses. */
export type NewConversationOverseer = Pick<Overseer, 'newChat' | 'getMetadata' | 'uploadBlob' | 'listSlashCommands' | 'newGatekeeper' | 'newAiModelGatekeeper' | 'newAgentSpawnerGatekeeper'> & Disposable

/** A connection the draft was given, in whichever workspace was chosen when it was added. */
export type DraftConnection = Pick<AddedConnection, 'gatekeeperId' | 'workspaceId' | 'source' | 'description' | 'vendorId'>

// The id of the same connection made again in `overseer`'s workspace.
const madeAgain = async (overseer: NewConversationOverseer, source: ConnectionSource) => {
  // Typed as nullable, but never null: it throws instead.
  const gatekeeper = ('agent' in source
    ? overseer.newAgentSpawnerGatekeeper({ displayName: source.agent.name, modelId: source.agent.modelId, env: {} })
    : 'modelId' in source
      ? overseer.newAiModelGatekeeper(source.modelId)
      : overseer.newGatekeeper(source.accountId, source.resourceUrl)) as RpcPromise<GatekeeperClient<never>>
  try {
    return await gatekeeper.getId()
  } finally {
    gatekeeper[Symbol.dispose]()
  }
}

/**
 * Starts a conversation: a chat that begins with `text` and carries `files`, answered by `modelId`,
 * in the workspace `open` creates or opens; or, with `command`, one that begins with the skill or
 * command given `text`, as that workspace offers it, which it may not. `formats` says where the
 * text names a format, for it to be drawn as one, and `connections` the connections it carries,
 * after its words: each made in another workspace than the one it starts in (one chosen after it
 * was added, or a new one) is made again there, so the chat is given its own. Resolves with the
 * workspace's and the chat's ids once the chat exists; the workspace's connection is released
 * before returning.
 */
export const startConversation = async (
  open: () => NewConversationOverseer,
  text: string,
  files: readonly File[],
  modelId: string,
  command?: ComposerCommand,
  formats?: MessageFormatRef[],
  connections: readonly DraftConnection[] = [],
): Promise<{ workspaceId: string; chatId: number }> => {
  // Before `open`, which may create a workspace, so that none is made for a message that cannot be sent.
  assertAttachable(files)
  const overseer = open()
  try {
    // Every call rides on the workspace, which may still be being created. Read once, as both the
    // result and the connections wait on it.
    const metadata = overseer.getMetadata().then((read) => read)
    const [chatId, { id: workspaceId }] = await Promise.all([
      command
        ? overseer.listSlashCommands().then((choices) => {
            const request = slashRequestFor(choices, command, text)
            if (!request) throw new Error(missingCommand(command))
            return overseer.newChat(request, modelId)
          })
        : Promise.all([
            uploadAttachments(overseer, files),
            connections.length === 0 ? [] : metadata.then(({ id }) =>
              Promise.all(connections.map(async (each) => (each.workspaceId === id ? each : { ...each, gatekeeperId: await madeAgain(overseer, each.source) })))),
          ]).then(([attachments, made]) => {
            const { text: written, capsules } = withCapsules(text, made)
            return overseer.newChat(written, modelId, capsules.length ? capsules : undefined, attachments, formats)
          }),
      metadata,
    ])
    return { workspaceId, chatId }
  } finally {
    overseer[Symbol.dispose]()
  }
}
