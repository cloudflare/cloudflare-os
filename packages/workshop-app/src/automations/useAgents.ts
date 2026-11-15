import { useCallback, useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { agentsOf, type Agent } from './agents'

export type AgentsState =
  | { status: 'loading' }
  | { status: 'ready'; agents: Agent[] }
  | { status: 'failed'; message: string }

// Workspaces read at once: each is a Durable Object of its own to wake.
const AT_ONCE = 4
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The agents of some workspaces (`listAgentSpawners`), each with its runs from its workspace's
 * chats (`listChats`, read only where there is an agent) and its model named as the user's models
 * are (`listModels`), read a few workspaces at a time. A
 * workspace that refuses is left out. `reload` reads them again, as after one is changed.
 */
export const useAgents = (workspaceIds: readonly string[] | undefined) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<AgentsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const ids = workspaceIds?.join('\n')

  useEffect(() => {
    if (ids === undefined || reconnecting) return
    let current = true
    const queue = ids ? ids.split('\n') : []
    const found: Agent[][] = []
    // The models' names as the user's model list has them, read once, when there is an agent.
    let models: Promise<Map<string, string>> | undefined
    const modelNames = () => (models ??= api.listModels().then(
      (offered) => new Map(offered.map(({ id, name }) => [id, name])),
      () => new Map<string, string>(),
    ))
    const read = async (workspaceId: string, at: number) => {
      const overseer = api.openWorkspace(workspaceId)
      try {
        const spawners = await overseer.listAgentSpawners()
        found[at] = spawners.length === 0 ? [] : agentsOf(workspaceId, spawners, await overseer.listChats(), await modelNames())
      } catch {
        found[at] = []
      } finally {
        overseer[Symbol.dispose]()
      }
    }
    let next = 0
    const worker = async () => {
      while (next < queue.length) {
        const at = next++
        await read(queue[at], at)
      }
    }
    Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker)).then(
      () => { if (current) setState({ status: 'ready', agents: found.flat() }) },
      (error: unknown) => { if (current) setState({ status: 'failed', message: messageOf(error) }) },
    )
    return () => { current = false }
  }, [api, reconnecting, ids, attempt])

  const reload = useCallback(() => setAttempt((count) => count + 1), [])
  return { state, reload }
}
