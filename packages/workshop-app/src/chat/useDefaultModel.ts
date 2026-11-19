import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { defaultModelOf } from './defaultModel'
import { subscribePreferredModelChanges } from './preferredModelChanges'

export type DefaultModel =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ready'; id: string }
  | { status: 'failed'; message: string }

/** What to tell the user when a message cannot be sent for lack of a model. */
export const describeModelProblem = (model: Exclude<DefaultModel, { status: 'ready' }>) => {
  switch (model.status) {
    case 'loading':
      return 'Your AI models are still loading. Try again in a moment.'
    case 'none':
      return 'No AI model is set up for your account.'
    case 'failed':
      return `Couldn’t load your AI models: ${model.message}`
  }
}

/**
 * The model the user's messages are answered by: the one they chose in the settings, or the first
 * of their models (`defaultModelOf`). Read as the page is opened, and again whenever another is
 * chosen (`preferredModelChanged`), with the one that was read up meanwhile.
 */
export const useDefaultModel = (): DefaultModel => {
  const { api, reconnecting } = useApi()
  const [model, setModel] = useState<DefaultModel>({ status: 'loading' })
  // Counts the models chosen since, each of which is read again.
  const [changes, setChanges] = useState(0)

  useEffect(() => subscribePreferredModelChanges(() => setChanges((count) => count + 1)), [])

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    // What was chosen is only a preference: where it cannot be read, the first model answers.
    Promise.all([api.listModels(), api.getPreferredModel().catch(() => null)]).then(
      ([models, preferred]) => {
        const chosen = defaultModelOf(models, preferred)
        if (!cancelled) setModel(chosen ? { status: 'ready', id: chosen.id } : { status: 'none' })
      },
      (error) => {
        if (!cancelled) setModel({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, changes])

  return model
}
