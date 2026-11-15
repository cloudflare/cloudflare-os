import type { AgentSpawnerInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'

/** One run of an agent: the conversation it had, as its workspace lists it. */
export type AgentRun = {
  chatId: number
  title: string
  lastActive: Date
  /** It stopped on something only a person can decide. */
  waiting: boolean
}

/** An agent a workspace can call on (an agent spawner), with its runs. */
export type Agent = {
  /** Tells it from every other, across workspaces. */
  key: string
  workspaceId: string
  /** Its connection, which its page is named by. */
  id: number
  name: string
  /** The model it thinks with, by name; absent when its runs only collect what they are given. */
  modelId: string | null
  modelName?: string
  /** The gadgets that call on it. */
  gadgetIds: number[]
  /** What each run can use, by what it is. */
  access: { name: string; title: string }[]
  /** Its conversations, latest first. */
  runs: AgentRun[]
  /** The chats whose agent started its runs. */
  startedFrom: ReadonlySet<number>
}

/**
 * A workspace's agents (`listAgentSpawners`), each with its runs: the chats it started
 * (`AiChatMetadata.spawnerId`), latest first, and the chats whose agent started them. A run recorded before
 * chats named their spawner is matched by its name. Its model is named as `modelNames` has it,
 * the user's models by id, else as recorded when it was set up.
 */
export const agentsOf = (
  workspaceId: string,
  spawners: readonly AgentSpawnerInfo[],
  chats: readonly AiChatMetadata[],
  modelNames: ReadonlyMap<string, string> = new Map(),
): Agent[] =>
  spawners.map((spawner) => {
    const modelName = (spawner.modelId !== null ? modelNames.get(spawner.modelId) : undefined) ?? spawner.modelName
    const own = chats.filter((chat) => (chat.spawnerId !== undefined ? chat.spawnerId === spawner.gatekeeperId : chat.spawnerName === spawner.displayName))
    return {
      key: `${workspaceId}:${spawner.gatekeeperId}`,
      workspaceId,
      id: spawner.gatekeeperId,
      name: spawner.displayName,
      modelId: spawner.modelId,
      ...(modelName ? { modelName } : {}),
      gadgetIds: spawner.gadgetIds,
      access: spawner.access.map(({ name, resourceTitle }) => ({ name, title: resourceTitle || name })),
      runs: own
        .map((chat) => ({ chatId: chat.id, title: chat.title || 'Untitled run', lastActive: chat.lastActive, waiting: chat.awaitingDecision === true }))
        .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime()),
      startedFrom: new Set(own.flatMap((chat) => (chat.parentChatId === undefined ? [] : [chat.parentChatId]))),
    }
  })

/** Whether an agent is one a gadget calls on, for the gadget's Automations tab. */
export const calledByGadget = (gadgetId: number) => (agent: Agent) => agent.gadgetIds.includes(gadgetId)

/** Whether an agent is one a chat's agent has started, for the chat's Automations tab. */
export const startedInChat = (chatId: number) => (agent: Agent) => agent.startedFrom.has(chatId)
