import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'

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

/** The model the user's messages are answered by: the first of their models, which is the default. */
export const useDefaultModel = (): DefaultModel => {
  const { api } = useApi()
  const [model, setModel] = useState<DefaultModel>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.listModels().then(
      ([first]) => {
        if (!cancelled) setModel(first ? { status: 'ready', id: first.id } : { status: 'none' })
      },
      (error) => {
        if (!cancelled) setModel({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  return model
}
