import { useEffect, useState } from 'react'
import type { AiChatAuthorInfo, RedactedAiModelConfig } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { messageOf } from './useAttempt'

export type ModelConfigState =
  | { status: 'loading' }
  | { status: 'ready'; profile: AiChatAuthorInfo; config: RedactedAiModelConfig }
  | { status: 'failed'; message: string }

/**
 * The configuration of a model the user added themselves, which the deployment's own have none
 * of to show, and the way to change its context window. Its secrets are never read: they are
 * withheld, and kept as they are by a change (`AuthenticatedApi.updateModel`). The state is not
 * reset when `modelId` changes, so give the calling component a `key` of the id.
 */
export const useModelConfig = (modelId: string) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<ModelConfigState>({ status: 'loading' })

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    api.getModelConfig(modelId).then(
      ({ profile, config }) => {
        if (!cancelled) setState({ status: 'ready', profile, config })
      },
      (error) => {
        // What was shown stays up when it could not be read again.
        if (!cancelled) setState((current) => (current.status === 'ready' ? current : { status: 'failed', message: messageOf(error) }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, modelId])

  /** Sets the most one request may hold, in tokens, or with `undefined` goes back to the model's own. Rejects with why it was not kept. */
  const setContextWindow = async (contextWindow: number | undefined) => {
    if (state.status !== 'ready') return
    // Left out rather than sent as nothing, which is how the server knows it is not set.
    const { contextWindow: _, ...rest } = state.config
    const config: RedactedAiModelConfig = contextWindow === undefined ? rest : { ...rest, contextWindow }
    await api.updateModel(state.profile, config)
    setState({ ...state, config })
  }

  return { state, setContextWindow }
}
