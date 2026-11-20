import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { automationsOf, type Automation } from './automations'

export type AutomationsState =
  | { status: 'loading' }
  | { status: 'ready'; automations: Automation[] }
  | { status: 'failed'; message: string; retry: () => void }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One workspace's automations (`listHooks()`), read once
 * mounted and again on a new connection, keeping what is shown meanwhile. `setEnabled` turns one
 * on or off: it shows at once, and is put back, rejecting with why, when the workspace refuses.
 * Give the calling component a `key` of the workspace.
 */
export const useAutomations = (workspaceId: string) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<AutomationsState>({ status: 'loading' })
  // Bumped to read again after a failure.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    overseer.listHooks().then(
      (hooks) => {
        if (!cancelled) setState({ status: 'ready', automations: automationsOf(workspaceId, hooks) })
      },
      (error: unknown) => {
        if (cancelled) return
        const retry = () => {
          setState({ status: 'loading' })
          setAttempt((current) => current + 1)
        }
        setState((current) => (current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry }))
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId, attempt])

  const patch = (hookId: number, enabled: boolean) =>
    setState((current) => current.status !== 'ready' ? current : {
      status: 'ready',
      automations: current.automations.map((each) => (each.hook.id === hookId ? { ...each, hook: { ...each.hook, enabled } } : each)),
    })

  const setEnabled = async ({ hook }: Automation, enabled: boolean) => {
    patch(hook.id, enabled)
    const overseer = api.openWorkspace(workspaceId)
    try {
      await (enabled ? overseer.enableHook(hook.id) : overseer.disableHook(hook.id))
    } catch (error) {
      patch(hook.id, hook.enabled)
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  return { state, setEnabled }
}
