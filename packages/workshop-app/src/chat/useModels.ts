import { useCallback, useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import type { Models } from './models'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The models the user may chat with and the one they prefer, with the way to prefer another:
 * which a new chat then starts with, here and in every other browser they use. Shown at once, and
 * put back with why if the server refuses it.
 */
export const useModels = () => {
  const { api, reconnecting } = useApi()
  const [models, setModels] = useState<Models>({ status: 'loading' })

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    // A preference that cannot be read leaves the first model the default, as having none does.
    Promise.all([api.listModels(), api.getPreferredModel().catch(() => null)]).then(
      ([offered, preferred]) => {
        if (!cancelled) setModels({ status: 'ready', offered, preferred: preferred ?? undefined })
      },
      (error: unknown) => {
        if (!cancelled) setModels({ status: 'failed', message: messageOf(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  const prefer = useCallback(async (id: string) => {
    let before: string | undefined
    setModels((current) => {
      if (current.status !== 'ready') return current
      before = current.preferred
      return { ...current, preferred: id }
    })
    try {
      await api.setPreferredModel(id)
    } catch (error) {
      // Unless another was preferred meanwhile.
      setModels((current) => (current.status === 'ready' && current.preferred === id ? { ...current, preferred: before } : current))
      throw error
    }
  }, [api])

  return { models, prefer }
}
