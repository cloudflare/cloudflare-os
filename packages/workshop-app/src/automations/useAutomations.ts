import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { AutomationsList } from './AutomationsList'

const IDLE = () => () => {}
const NOTHING = { status: 'loading' } as const

/**
 * The automations of `workspaceIds` (an `AutomationsList`), read once mounted with some; none while
 * they are undefined. A new connection reads them again, keeping what is shown meanwhile.
 */
export const useAutomations = (workspaceIds: readonly string[] | undefined) => {
  const { api, reconnecting } = useApi()
  const latestApi = useRef(api)
  const key = workspaceIds?.join('\n')
  const [list, setList] = useState<{ key: string; list: AutomationsList }>()
  const current = list && list.key === key ? list.list : undefined

  useEffect(() => {
    if (key === undefined) return
    const made = new AutomationsList(() => latestApi.current, key === '' ? [] : key.split('\n'))
    setList({ key, list: made })
    return () => made.stop()
  }, [key])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (!current || reconnecting) return
    current.start()
    return () => current.stop()
  }, [current, reconnecting])

  useLayoutEffect(() => {
    latestApi.current = api
  }, [api])

  const snapshot = useSyncExternalStore(current?.subscribe ?? IDLE, current?.getSnapshot ?? (() => NOTHING))
  return { list: current, snapshot }
}
