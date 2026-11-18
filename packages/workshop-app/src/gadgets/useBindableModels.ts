import { useEffect, useState } from 'react'
import type { ModelKind } from '@gadgets/workshop-shared/api'
import { defaultModelOf } from '@/chat/defaultModel'
import { useApi } from '@/rpc/ApiContext'

/** One of the user's models that a gadget's code can be given. */
export type BindableModel = { id: string; name: string; kind: ModelKind }

/**
 * The models a gadget's code can be given (`listModels()`): the language models, then the decision
 * models, with the one to start on, the model the user's messages are answered by. Undefined until
 * read; none where they could not be, which the dialog says.
 */
export const useBindableModels = () => {
  const { api, reconnecting } = useApi()
  const [models, setModels] = useState<{ models: BindableModel[]; initial?: string }>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads them.
    if (reconnecting) return
    let current = true
    Promise.all([
      api.listModels(),
      // Most deployments have none, and a gadget is given a language model as well without them.
      api.listModels('decision').catch(() => []),
      api.getPreferredModel().catch(() => null),
    ]).then(
      ([language, decision, preferred]) => {
        if (!current) return
        setModels({
          models: [
            ...language.map(({ id, name }) => ({ id, name, kind: 'language' as const })),
            ...decision.map(({ id, name }) => ({ id, name, kind: 'decision' as const })),
          ],
          initial: defaultModelOf(language, preferred)?.id,
        })
      },
      () => {
        if (current) setModels({ models: [] })
      },
    )
    return () => {
      current = false
    }
  }, [api, reconnecting])

  return models
}
